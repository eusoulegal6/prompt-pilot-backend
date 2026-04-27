## Goal

Make the backend match the extension contract you described:

1. `draft-reply` returns strict JSON, and *never* puts "I can't reply to this" prose into `draft`. It self-corrects to `decision: "review"` when the model produces a refusal.
2. `sync-thread-state` already exists and largely works — align its event semantics, field names, and audit trail to the spec.

Auth (extension `ext_...` bearer + JWT fallback) and quota behavior stay exactly as they are.

---

## 1. Update `supabase/functions/draft-reply/index.ts`

Keep all existing infrastructure: `resolveUserId`, `checkQuota`, `recordUsage`, CORS, Anthropic call, timeouts, model. Only change the prompt + response-validation layer.

### a. Stronger system prompt — force structured JSON

Replace the current "return only the message text" system prompt with one that asks Claude to emit a small JSON object so we can route reply / review / skip without regex-sniffing prose:

```
You are an assistant that decides whether to draft a reply on {providerLabel}, and if so, drafts it.

Return ONE JSON object, no markdown, no code fences, matching exactly one of:

  { "decision": "reply",  "draft": "<message text>" }
  { "decision": "review", "reviewReason": "<snake_case>", "reviewSummary": "<short sentence>" }
  { "decision": "skip",   "reviewReason": "<snake_case>", "reviewSummary": "<short sentence>" }

Choose "review" or "skip" (NOT "reply") when the latest message is:
- automated, menu-driven, OTP, or a bot prompt  -> reason "menu_bot" or "automated_system"
- a broadcast / notification / system message    -> "broadcast_or_notification"
- missing context to safely respond              -> "missing_context"
- sensitive (legal, medical, financial advice)   -> "sensitive_request"
- something that needs human judgment            -> "needs_human_judgment"
- a thread where no reply is appropriate         -> "no_reply"

If decision is "reply":
- "draft" is ONLY the message text the user will send. No quotes, no labels, no markdown, no commentary.
- Match {providerLabel} conventions: short, conversational, sentence-case.
- Never invent facts, prices, dates, commitments.
- No greeting if mid-thread. Under 3 short sentences unless clearly required.
- Never put refusal/explanation text into "draft". If you would refuse, return decision "review" instead.
{identity / style / knowledge / extra / signature blocks unchanged}
```

### b. Parse + validate the model output

After the Anthropic call:

1. Try `JSON.parse` on `cleanDraft(rawDraft)`.
2. If parse fails, fall back: treat `rawDraft` as a candidate draft string and run heuristic detection (below).
3. If parse succeeds, validate:
   - `decision ∈ {reply, review, skip}` else → review/`needs_human_judgment`.
   - For `reply`: require non-empty `draft`. Run heuristic detection on it; if it looks like a refusal, convert to `review`/`automated_system`.
   - For `review` / `skip`: clamp `reviewReason` to the allowed set (else `needs_human_judgment`), truncate `reviewSummary` ≤ 500.

### c. Refusal-detection heuristic

A small regex test on the draft text. If it matches, override to `review`:

```
/(i (should|cannot|can'?t|won'?t) (draft|reply|respond|provide))|
 (this (appears|seems) to be (an )?(automated|system|bot))|
 (no (visible )?options to respond)|
 (cannot generate (a )?reply)|
 (as an ai)/i
```

Override payload:
```json
{ "decision": "review",
  "reviewReason": "automated_system",
  "reviewSummary": "Automated or menu-driven message; do not auto-reply." }
```

### d. Response shapes (strict)

- Reply: `{ decision: "reply", draft, model, inputTokens, outputTokens }`
- Review: `{ decision: "review", reviewReason, reviewSummary, model, inputTokens, outputTokens }`
- Skip: `{ decision: "skip", reviewReason, reviewSummary, model, inputTokens, outputTokens }`

`recordUsage` is already called with `decision`. Keep the rule that only `decision === "reply"` increments `emails_used`. `review`/`skip` still log tokens to `reply_logs` for visibility.

### e. Pre-call short-circuit (unchanged)

If the *client* already passed `decision: "review" | "skip"`, keep the existing log-only path and return the matching shape — no Anthropic call.

---

## 2. Update `supabase/functions/sync-thread-state/index.ts`

The function exists and the table has the right columns under different names. Two options:

**Option A (chosen):** keep the existing column names (`status_value`, `review_active`, `review_resolved_at`, `thread_state_history`) — they already work and the dashboard will be wired against them. Only adjust event semantics + add the missing field.

Concretely:

1. **Event semantics fix** — current `review_flagged` already sets `review_active = true`, but it does not stamp an "opened at" timestamp. Add a new column `review_opened_at` (see migration below) and set it on `review_flagged`. Clear `review_resolved_at` on `review_flagged`. Leave `draft_saved` / `reply_sent` / `review_resolved` semantics as-is — they already match the spec.

2. **Audit trail** — `thread_state_history` already exists and is appended on every event. Add a `payload jsonb` column so we capture the raw event for debugging (spec asks for it).

3. **Validation** — already strict. No change.

4. **Response** — already `{ ok: true }`. No change.

5. **Auth** — already supports `ext_...` and JWT. No change.

### Migration (schema only)

```sql
ALTER TABLE public.thread_states
  ADD COLUMN IF NOT EXISTS review_opened_at timestamptz;

ALTER TABLE public.thread_state_history
  ADD COLUMN IF NOT EXISTS payload jsonb;

CREATE INDEX IF NOT EXISTS idx_thread_states_active_review
  ON public.thread_states (user_id, review_active, review_opened_at DESC)
  WHERE review_active = true;
```

No new tables, no RLS changes (existing policies already restrict reads to `auth.uid() = user_id`; writes go through the service role inside the function).

---

## 3. Dashboard contract (already satisfied, documenting only)

- "Flagged messages" tile = `count(*) from thread_states where user_id = auth.uid() and review_active = true`.
- Review queue list = same filter, ordered by `review_opened_at desc, updated_at desc`.

No frontend changes in this plan — dashboard already reads `thread_states` once data starts flowing. The reason the tile is `0` today is the extension still has not started calling `sync-thread-state`; that is an extension-side change, out of scope here.

---

## Files touched

- `supabase/functions/draft-reply/index.ts` — prompt + JSON parsing + refusal heuristic
- `supabase/functions/sync-thread-state/index.ts` — set `review_opened_at` on `review_flagged`, write `payload` jsonb to history
- `supabase/migrations/<new>.sql` — add `review_opened_at`, `payload`, partial index

## Out of scope

- Extension code changes (the extension lives outside this repo now)
- Dashboard UI changes (already reads the right table)
- Auth bridging / Realtime (separate decision, not blocking this work)

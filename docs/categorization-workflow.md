# Message & Transcript Categorization

How inbound WhatsApp / Gmail messages and voice-note transcripts get a
customer-service intent, and how the dashboard surfaces the ones that need
human review.

Claude is used as a triage agent. It does not classify by keywords — it
decides what the customer is trying to accomplish and what the business
should do next, then returns a structured JSON object the backend validates
and stores.

## Components

| Component | Path | Role |
|---|---|---|
| `classify-intent` edge function | `supabase/functions/classify-intent/index.ts` | Primary classifier (4 categories). Used for both text and voice transcripts. Also runs the backfill job. |
| `classify-message` edge function | `supabase/functions/classify-message/index.ts` | Legacy / fine-grained classifier (12 categories). Kept for callers that need the richer taxonomy. |
| `flagged-list` edge function | `supabase/functions/flagged-list/index.ts` | Reads `thread_states` and returns rows that need human review. |
| `thread_states` table | Supabase | Source of truth: one row per `(user_id, provider, thread_id)`. Holds `intent_category`, `intent_confidence`, `intent_reason`, `intent_source`, `intent_classified_at`. |
| `FlaggedReviewSection` | `src/components/FlaggedReviewSection.tsx` | Renders the flagged panel on the dashboard. |

## Taxonomy

`classify-intent` returns one fine-grained `intent` (stored as
`intent_subcategory`) and maps it to a broad `intent_category` for dashboard
routing.

Fine-grained intents:

- `greeting_only`
- `appointment_new`, `appointment_reschedule`, `appointment_cancel`
- `pricing_question`, `product_or_service_question`
- `order_status`, `payment_or_billing`, `refund_or_return`
- `complaint`, `technical_support`, `human_agent_request`
- `spam_or_irrelevant`, `unclear`

Broad → fine mapping:

| Broad `intent_category` | Fine `intent_subcategory` |
|---|---|
| `appointment` | `appointment_new`, `appointment_reschedule`, `appointment_cancel` |
| `support`     | `pricing_question`, `product_or_service_question`, `order_status`, `payment_or_billing`, `refund_or_return`, `technical_support` |
| `flagged`     | `complaint`, `human_agent_request` |
| `misc`        | `greeting_only`, `spam_or_irrelevant`, `unclear` |

`classify-message` (legacy) still exists with its 12-category taxonomy for
callers that haven't migrated.

## Model output schema

Claude returns strict JSON. The backend validates and clamps every field:

```json
{
  "intent": "payment_or_billing",
  "confidence": 0.94,
  "customer_goal": "Wants help with a missing payment confirmation.",
  "business_action": "Check payment status and send confirmation or next steps.",
  "needs_human_review": true,
  "review_reason": "Payment issue may require account verification.",
  "urgency": "medium"
}
```

Stored on `thread_states`:

| Column | Source |
|---|---|
| `intent_category`      | broad bucket derived from `intent` |
| `intent_subcategory`   | model `intent` (validated against taxonomy) |
| `intent_confidence`    | model `confidence`, clamped to `[0,1]` |
| `intent_reason`        | legacy field — populated from `review_reason` / `customer_goal` for backward compatibility |
| `intent_source`        | `text`, `voice_transcript`, or `backfill` |
| `intent_classified_at` | server time at classification |
| `customer_goal`        | model `customer_goal`, truncated to 280 |
| `business_action`      | model `business_action`, truncated to 280 |
| `needs_human_review`   | model `needs_human_review`, OR'd with server fallback rules |
| `intent_review_reason` | model `review_reason`, truncated to 280 |
| `intent_urgency`       | `low` \| `medium` \| `high` (defaults to `medium`) |

### Server-side `needs_human_review` fallback

Even when the model returns `needs_human_review: false`, the backend forces
the flag to `true` if any of the following are true:

- `intent` ∈ {`complaint`, `refund_or_return`, `human_agent_request`,
  `payment_or_billing`, `unclear`}
- `confidence < 0.55`

## Inputs

`POST /functions/v1/classify-intent` accepts:

```jsonc
{
  "message":   "string (or 'transcript' / 'text')",   // required
  "context":   "string, optional prior thread",
  "provider":  "whatsapp | gmail | ...",
  "source":    "text | voice | voice_transcript | transcript | audio",
  "thread_id": "string, optional — enables persistence"
}
```

Text and voice transcripts share the same prompt. When `source` is any of
`voice|voice_transcript|transcript|audio`, the prompt is told to expect
disfluencies and minor STT errors and classify the underlying intent.

Limits: message ≤ 4000 chars, context ≤ 2000, provider ≤ 100, source ≤ 32,
thread_id ≤ 256. Inputs are trimmed and truncated server-side.

## Auth

`resolveUserId` accepts either:

1. `Authorization: Bearer ext_<raw>` — looks up the SHA-256 of `<raw>` in
   `extension_tokens` (must not be revoked) and returns its `user_id`.
2. `Authorization: Bearer <jwt>` — decodes `sub` from the JWT payload.

`flagged-list` additionally supports **partner-project JWTs**: it verifies the
token against each project in `PARTNER_PROJECTS` via JWKS, then maps the
resulting `sub` to the local bridge user via the email
`partner+{ref}+{sub}@bridge.sendsmart.local`. This is what lets the WhatsApp
Reply Hub frontend read flagged rows that the extension wrote under the bridge
user.

## Classification flow (single message)

1. Client (extension or web app) calls `POST /classify-intent`.
2. Function authenticates the caller and resolves `user_id`.
3. Body is parsed; `message` / `transcript` / `text` are accepted as aliases.
4. Anthropic Claude (`claude-haiku-4-5`, `max_tokens=400`, `temperature=0`,
   15s abort) is called with the customer-service system prompt + a user
   block containing `Provider`, `Source`, optional `Background context`, and
   the latest message wrapped in `<<<LATEST MESSAGE TO CLASSIFY>>> … <<<END>>>`
   markers.
5. `parseClassification` strips code fences, extracts the first `{…}`,
   `JSON.parse`s it, validates `intent` against the taxonomy (falls back to
   `unclear`), clamps `confidence` to `[0, 1]`, validates `urgency` against
   {`low`, `medium`, `high`} (defaults to `medium`), truncates string fields
   to 280 chars, derives the broad `category` from `intent`, and applies the
   `needs_human_review` fallback above.
6. If both `provider` and `thread_id` are present, the function PATCHes the
   matching `thread_states` row with the full intent payload listed in the
   table above.
7. Response: `{ ok, intent, category, confidence, customer_goal, business_action, needs_human_review, review_reason, urgency, reason, source, persisted, usage }`.

## Backfill flow

`POST /classify-intent` with `{ "action": "backfill", "limit": 1..100 }`:

1. Selects up to `limit` `thread_states` rows for the caller where
   `intent_category IS NULL OR intent_category = ''`, ordered by
   `updated_at desc`.
2. For each row, builds the message from `latest_message` ?? `preview` ??
   `subject`, classifies it with the same Claude call, PATCHes the row with
   `intent_source = "backfill"`.
3. Returns `{ ok, mode: "backfill", processed, classified, failed, skipped, results[] }`.

## Flagged-list query

`GET /flagged-list?limit=20&min_age_minutes=0` returns rows where ANY of the
following hold:

```
needs_human_review = true
OR intent_subcategory IN ('complaint','refund_or_return','human_agent_request','unclear')
OR intent_confidence < 0.55
OR intent_category = 'misc'                                      -- legacy rows
OR (intent_category = 'support' AND intent_confidence < 0.6)     -- legacy rows
```

ordered by `updated_at desc`. Optional `min_age_minutes` lets the UI skip
threads that are still being typed.

Selected columns: `thread_id, provider, sender, subject, preview,
latest_message, intent_category, intent_subcategory, intent_confidence,
intent_reason, intent_source, intent_classified_at, customer_goal,
business_action, needs_human_review, intent_review_reason, intent_urgency,
updated_at, thread_url`.

## Frontend wiring

`FlaggedReviewSection` polls `flagged-list` every ~15s (and subscribes to
realtime on `thread_states` filtered by `user_id`). It de-dupes by `sender`
(WhatsApp `thread_id` contains rotating avatar-URL tokens), and per row
renders:

- the `intent_subcategory` (humanised) with `Math.round(intent_confidence * 100)%`
- an `intent_urgency` pill (low / medium / high)
- the latest message preview
- `customer_goal` ("Customer goal: …")
- `business_action` ("Next action: …")
- `intent_review_reason` (falls back to `intent_reason`) as a muted sub-line

Empty state: "No flagged messages right now."

## Privacy & observability

- Email/message content is **never logged**. Logs only include user id,
  provider, source, category, confidence, token counts, elapsed ms.
- All responses set `Cache-Control: no-store`.
- `ANTHROPIC_API_KEY` lives only in backend secrets.

## Voice transcripts

Voice notes ride the same classifier as text — they don't have a separate path:

1. The extension posts an audio attachment to `draft-reply`.
2. `draft-reply` transcribes it via OpenAI Whisper (`whisper-1`) and writes a
   row to `whisper_invocations` (transcript stored, no thread linkage).
3. The transcript is folded into the latest-message payload used to draft the
   reply, then `draft-reply` fires `classifyAndPersistIntent` (fire-and-forget).
4. That helper now **delegates to the deployed `classify-intent` edge
   function** with `source: "voice_transcript"`, authenticating with the
   service-role key and passing the real end-user via the
   `x-user-id-override` header (`classify-intent` only trusts that header
   when the bearer equals `SUPABASE_SERVICE_ROLE_KEY`).
5. `classify-intent` runs the full 14-intent taxonomy, applies the
   `needs_human_review` safety net, and PATCHes `thread_states` — so voice
   threads land in the flagged panel under the same rules as text.

`whisper_invocations` itself is **not** consumed by the categorizer; it is
observability only. Transcripts reach `thread_states` exclusively through
the `draft-reply → classify-intent` path described above.

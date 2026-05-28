# Message & Transcript Categorization

How inbound WhatsApp / Gmail messages and voice-note transcripts get an
`intent_category`, and how the dashboard surfaces the flagged ones.

## Components

| Component | Path | Role |
|---|---|---|
| `classify-intent` edge function | `supabase/functions/classify-intent/index.ts` | Primary classifier (4 categories). Used for both text and voice transcripts. Also runs the backfill job. |
| `classify-message` edge function | `supabase/functions/classify-message/index.ts` | Legacy / fine-grained classifier (12 categories). Kept for callers that need the richer taxonomy. |
| `flagged-list` edge function | `supabase/functions/flagged-list/index.ts` | Reads `thread_states` and returns rows that need human review. |
| `thread_states` table | Supabase | Source of truth: one row per `(user_id, provider, thread_id)`. Holds `intent_category`, `intent_confidence`, `intent_reason`, `intent_source`, `intent_classified_at`. |
| `FlaggedReviewSection` | `src/components/FlaggedReviewSection.tsx` | Renders the flagged panel on the dashboard. |

## Categories

`classify-intent` returns exactly one of:

- `appointment` — booking / rescheduling / cancelling, or any concrete date+time.
- `greeting` — pure salutation, no request yet.
- `support` — help, pricing, orders, billing, refunds, complaints, any service question.
- `misc` — everything else (small talk, spam, bots, ambiguous, multi-topic).

Precedence (first match wins): scheduling → greeting → support → misc.

`classify-message` returns the richer set: `appointment`, `greeting`, `pricing`,
`complaint`, `support`, `order`, `payment`, `cancellation`, `escalation`,
`menu_bot`, `sensitive_request`, `needs_human_judgment`.

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
4. Anthropic Claude (`claude-haiku-4-5`, `max_tokens=150`, `temperature=0`,
   15s abort) is called with the system prompt + a user block containing
   `Provider`, `Source`, optional `Background context`, and the latest message
   wrapped in `<<<LATEST MESSAGE TO CLASSIFY>>> … <<<END>>>` markers.
5. `parseClassification` strips code fences, extracts the first `{…}`,
   `JSON.parse`s it, validates the slug against the category set (falls back
   to `misc`), clamps `confidence` to `[0, 1]`, truncates `reason` to 280
   chars.
6. If both `provider` and `thread_id` are present, the function PATCHes the
   matching `thread_states` row with `intent_category`, `intent_confidence`,
   `intent_reason`, `intent_source`, `intent_classified_at`.
7. Response: `{ ok, category, confidence, reason, source, persisted, usage }`.

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

`GET /flagged-list?limit=20&min_age_minutes=0` returns rows where:

```
intent_category = 'misc'
OR (intent_category = 'support' AND intent_confidence < 0.6)
```

ordered by `updated_at desc`. Optional `min_age_minutes` lets the UI skip
threads that are still being typed.

Selected columns: `thread_id, provider, sender, subject, preview,
latest_message, intent_category, intent_confidence, intent_reason,
intent_source, intent_classified_at, updated_at, thread_url`.

## Frontend wiring

`FlaggedReviewSection` polls `supabase.functions.invoke('flagged-list', { body: { limit: 20 } })`
every ~15s (and subscribes to realtime on `thread_states` filtered by
`user_id`). It de-dupes by `sender` (WhatsApp `thread_id` contains rotating
avatar-URL tokens), shows the `intent_category` badge,
`Math.round(intent_confidence * 100)%`, the latest message preview, and
`intent_reason` as a muted sub-line. Empty state: "No flagged threads".

## Privacy & observability

- Email/message content is **never logged**. Logs only include user id,
  provider, source, category, confidence, token counts, elapsed ms.
- All responses set `Cache-Control: no-store`.
- `ANTHROPIC_API_KEY` lives only in backend secrets.

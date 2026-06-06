# Chat Sync Integrity Contract v2

Update `sync-thread-state` and the database to honor the new extension contract: signed payloads, idempotent receipts, and per-message persistence.

## 1. Database migration

New tables:

- `sync_events`
  - `event_id text primary key` (the `eventId` from the body, e.g. `event:<uuid>`)
  - `user_id uuid`, `provider text`, `thread_id text`
  - `event_type text` (`chat_snapshot` | `chat_scanned`)
  - `scan_id text`, `schema_version int`
  - `payload_sha256 text not null`
  - `stored_message_count int`
  - `received_at timestamptz default now()`
  - unique constraint on `event_id`; index on `(user_id, thread_id)`

- `scan_messages` (per-message identity for `chat_scanned`)
  - `id uuid pk`
  - `user_id`, `provider`, `thread_id`
  - `event_id text references sync_events(event_id) on delete cascade`
  - `message_id text` (nullable — degraded input)
  - `ordinal int`, `source_model_index int`
  - `sender_id text`, `from_me bool`, `msg_timestamp bigint`
  - `raw_body text`, `normalized_body text`
  - `degraded bool` (true when `message_id` is null)
  - unique `(user_id, thread_id, message_id)` where `message_id is not null`
  - unique `(event_id, ordinal)` so re-posting the same event is a no-op
  - GRANTs + RLS (owner only); service_role full access

## 2. Edge function `sync-thread-state`

Behavior changes:

1. **Header capture**: read `x-idempotency-key`, `x-payload-sha256`, `x-schema-version`.
2. **Hash verify**: clone body, drop top-level `payloadSha256`, drop `integrity.payloadSha256` (keep other integrity fields), recursively sort object keys, JSON.stringify compact, SHA-256 → lowercase hex. Reject `400` if computed hash ≠ body `payloadSha256` ≠ header `x-payload-sha256`.
3. **Idempotency**:
   - Look up `sync_events.event_id`.
   - Same `event_id` + same `payload_sha256` → return the stored receipt (no re-write).
   - Same `event_id` + different hash → `409`.
   - Otherwise insert a new `sync_events` row.
4. **Existing thread_states upsert** continues as today.
5. **chat_scanned message persistence**: for each `scan.messages[i]`, insert a `scan_messages` row with `ordinal = i` and the contract fields. Use upsert on `(event_id, ordinal)` so retries are safe. Count inserted rows for `storedMessageCount`.
6. **Verified receipt**:
   ```json
   { "ok": true, "eventId": "...", "payloadSha256": "...", "storedMessageCount": N }
   ```
   `storedMessageCount` is included only for `chat_scanned`. Only returned after DB commits succeed; on partial failure return `500` and do not persist `sync_events`.
7. Backwards compatibility: if `schemaVersion` is missing and there's no `payloadSha256`, fall through to legacy behavior so older extension installs keep working (logged as `legacy_unverified`).

## Technical notes

- Canonical JSON: implement a small `canonicalize(obj)` that sorts keys recursively, preserves array order, stringifies with `JSON.stringify` (no spaces). Web Crypto `crypto.subtle.digest("SHA-256", ...)` for hashing.
- All new writes use the service-role REST calls already used in the function.
- `messageId` may be missing for some WhatsApp messages — store with `degraded=true`, do not collapse by text.
- No frontend changes required.


The dashboard is calling `POST /functions/v1/review-resolve` but that function doesn't exist on this backend yet — hence "Failed to fetch" (CORS preflight has nothing to respond). I'll add it, mirroring the auth + CORS pattern from `review-list` and `usage-get`.

## What to build

**New file: `supabase/functions/review-resolve/index.ts`**

- Method: `POST`
- CORS: same headers as `review-list` (`authorization, apikey, content-type, x-client-info`), handle `OPTIONS` preflight
- Auth: same bridged-JWT pattern as `review-list` / `usage-get` — read `Authorization: Bearer <jwt>`, resolve user via local `auth.getUser` first, fall back to partner project (`uxhtrpwgfqknxqzhssoe`) verification + bridge user lookup
- Body: `{ "id": "<reply_logs.id>" }` (validate it's a uuid string)
- Action: `UPDATE reply_logs SET decision = 'resolved' WHERE id = $1 AND user_id = <authed user> AND decision IN ('review','needs_review','flagged')` using the service-role client (RLS allows only SELECT on this table)
- Response: `{ ok: true, id, decision: 'resolved' }` on success, `{ ok: false, error }` with appropriate status on failure
- Always return CORS headers, including on errors

**Update `supabase/config.toml`**

Add:
```
[functions.review-resolve]
verify_jwt = false
```
(matches the other bridged endpoints — we verify manually).

## Why this matches the existing pattern

- `review-list` already filters by `decision IN ('review','needs_review','flagged')`. Setting `decision = 'resolved'` removes the row from that query naturally — no new column, no migration.
- No RLS changes needed: the function uses the service-role key after manually authenticating the user, just like `review-list` does for SELECT.
- Frontend is already wired (optimistic removal + toast), so once deployed the "I replied" button will work.

## Out of scope

- No DB migration, no RLS change, no changes to `review-list`, `usage-get`, `pair-*`, or `draft-gmail-reply`.
- No extension changes.

## Verify after deploy

- `OPTIONS /functions/v1/review-resolve` returns 204 with CORS headers.
- `POST` without auth → 401 with CORS headers.
- `POST` with valid bridged JWT + valid `id` → flips `decision` to `resolved`, row disappears from next `review-list` call, dashboard card removal sticks after refresh.

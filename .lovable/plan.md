# Pipeline: chat_snapshot + chat_scanned → Dashboard

Make the snapshot/scan data captured by `sync-thread-state` the primary live feed in the web app, following the `flagged-list` pattern (auth-aware edge function + React component with polling + realtime).

## 1. New edge function: `thread-activity`

Path: `supabase/functions/thread-activity/index.ts`

- Reuse the `resolveUserId` helper from `flagged-list` verbatim (JWT + `ext_` token + partner JWKS) so both web sessions and extension tokens work.
- `GET /?health=1` → `{ ok: true, function: "thread-activity" }`.
- `GET /?limit=20&thread_id=<optional>` returns:
  ```json
  {
    "ok": true,
    "threads": [ /* thread_states rows, latest snapshot+scan denormalized */ ],
    "snapshots": [ /* chat_snapshots time-series, newest first */ ],
    "scans": [ /* chat_scans time-series, newest first, messages truncated */ ]
  }
  ```
- Query strategy (service-role REST, filtered by `user_id`):
  - `thread_states`: select thread_id, provider, sender, subject, thread_url, snapshot_*, scan_*, last_snapshot, last_scan, updated_at — order by `snapshot_captured_at desc nulls last`, limit N.
  - `chat_snapshots`: select all columns, order `captured_at desc`, limit N.
  - `chat_scans`: select metadata + `messages` truncated to last 5 entries (slice server-side to keep payload small), order `captured_at desc`, limit N.
- If `thread_id` query param is set, filter all three queries by it.
- All responses include CORS headers + `Cache-Control: no-store`.

## 2. Frontend component: `ThreadActivitySection`

Path: `src/components/ThreadActivitySection.tsx`

- Mirrors `FlaggedReviewSection` structure: `fetch` + `setInterval` poll (15s) + Supabase realtime channel on `chat_snapshots` and `chat_scans` INSERT (filtered by `user_id`) to trigger reload.
- Two stacked panels inside the card:
  1. **Live snapshots** — list of latest `chat_snapshots` (sender, body preview, unread count badge, from_me indicator, captured_at).
  2. **Recent scans** — list of latest `chat_scans` (sender/thread, message_count, captured_at, expandable accordion to show truncated `messages[]`).
- Uses semantic Tailwind tokens (no raw colors), `lucide-react` icons (`Activity`, `MessageSquare`, `ScanLine`).
- Header refresh button + spinner identical to `FlaggedReviewSection`.

## 3. Dashboard wiring

`src/pages/Dashboard.tsx`: import and render `<ThreadActivitySection />` directly above `<FlaggedReviewSection />` so the live pipeline is the first thing users see.

## 4. Realtime publication

Migration adds:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_snapshots;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_scans;
```
Plus `REPLICA IDENTITY FULL` on both so updates carry full rows (no schema change otherwise — RLS already permits authenticated user reads of own rows).

## 5. Handoff docs

Update `sync-thread-state-handoff.md` with a new "Consumers" section pointing to `thread-activity` + `ThreadActivitySection.tsx`, so the next agent knows the read path is now live.

## Out of scope (call out, don't build)

- Thread Inspector drawer (full scan history per thread) — defer until users ask.
- Pagination beyond `limit` query param — current cap (50) is enough for the dashboard card.
- Surfacing snapshots/scans inside the flagged list — keep concerns separated.

## Technical notes

- `chat_scans.messages` is unbounded jsonb; the edge function slices to last 5 messages before returning to keep the payload under a few KB per row.
- The component dedupes snapshots by `thread_id` for the "Live snapshots" panel (latest wins), same dedupe pattern `FlaggedReviewSection` uses for sender.
- No new secrets, no DB schema changes beyond the realtime publication.

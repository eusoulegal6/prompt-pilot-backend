
## Context

You have two projects:

- **This project** (`ocpphyjkstvfespxrajk`) — the backend. It has all the tables (`account_apps`, `app_settings`, `extension_pair_codes`, `extension_tokens`, `reply_logs`, `usage_counters`, etc.) and the deployed edge functions (`pair-create`, `pair-redeem`, `review-list`, `review-resolve`, `usage-get`, `draft-gmail-reply`). `ANTHROPIC_API_KEY` is now set.
- **[Whatsapp Reply Hub](/projects/1a50ee9b-cd11-44ed-8b71-d21bfe1b33fc)** — the rebranded WhatsReply frontend. After the remix, its own Lovable Cloud was provisioned as a fresh, empty project (`zzqdzubykkglytjdecqe`), but the UI still calls the *original* hardcoded backend (`uexdjvbdqwrzlgfrpgbl`). Neither matches this backend.

Goal: make the WhatsReply frontend talk to **this** backend so auth, usage, flagged reviews, and extension pairing all work end-to-end against the data and functions you actually own.

## Recommended approach

Point the frontend's Supabase client AND all hardcoded edge-function URLs at this project (`ocpphyjkstvfespxrajk`). Use the existing publishable anon key from this project's `.env`.

Note: cross-project file edits require switching to the WhatsReply project to apply them. This plan documents exactly what to change there.

## Changes to apply in the WhatsReply project

### 1. Update `.env`
Replace the three `VITE_SUPABASE_*` values with this backend's:
```
VITE_SUPABASE_PROJECT_ID="ocpphyjkstvfespxrajk"
VITE_SUPABASE_URL="https://ocpphyjkstvfespxrajk.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="<anon key from this project>"
```
(Lovable manages `.env` automatically once the WhatsReply project's Cloud is re-linked — see step 5.)

### 2. Replace hardcoded URLs + anon keys in 4 frontend files
Swap the `uexdjvbdqwrzlgfrpgbl.supabase.co` host and its anon key for this project's host/anon key, OR refactor to use `import.meta.env.VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` (preferred — no hardcoded values):

- `src/components/ConnectExtension.tsx` → `pair-create`
- `src/hooks/useFlaggedEmails.ts` → `review-list`
- `src/hooks/useResolveFlagged.ts` → `review-resolve`
- `src/hooks/useSendSmartUsage.ts` → `usage-get`

### 3. Regenerate Supabase types
After repointing, regenerate `src/integrations/supabase/types.ts` so the client knows about this backend's schema (tables like `usage_counters`, `reply_logs`, etc.).

### 4. Verify auth + RLS alignment
Users who sign up in the WhatsReply UI will create accounts in **this** backend's `auth.users`. RLS on `account_apps`, `app_settings`, `usage_counters`, `reply_logs`, `extension_pair_codes`, `extension_tokens` is keyed on `auth.uid()`, so each user only sees their own rows — no schema changes needed.

### 5. Re-link Lovable Cloud (one option)
The cleanest path is to disable the empty Cloud (`zzqdzubykkglytjdecqe`) on the WhatsReply project and treat this project's backend as a plain remote Supabase the frontend talks to via env vars. The WhatsReply project does not need its own Cloud at all — it only needs the URL + anon key to call this backend's edge functions and tables.

## Open question

Do you want users who sign up in WhatsReply to share the same auth pool as this project (recommended — it's already what happens once you repoint), or kept separate? Separate would require keeping a second backend and copying the schema/functions over, which defeats the purpose of this consolidation.

## Outcome

After these edits, the WhatsReply UI will:
- authenticate against this backend's Supabase auth
- read usage from `usage_counters` via `usage-get`
- list/resolve flagged items via `review-list` / `review-resolve`
- pair the Chrome extension via `pair-create` (which can then call `draft-gmail-reply` using the `ANTHROPIC_API_KEY` you just set)

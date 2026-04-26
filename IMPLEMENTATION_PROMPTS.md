# Send Smart Implementation Prompts

This document splits the work into copy-ready prompts by execution surface.

- Use the `Lovable` prompts for backend and web app work in the main app at `C:\Users\null\send-smart-backend`.
- Use the `Codex` prompts here for Chrome extension work in `C:\Users\null\send-smart-backend\ChromeExtensionAgent 2`.

## Global Constraints

These constraints should be preserved across every prompt:

- Keep the current Gmail unread-only automation workflow intact.
- Do not switch the extension to the normal inbox URL.
- Do not replace the current "first unread from the special unread page" behavior with custom local dedupe logic.
- The unread-page behavior is the primary anti-duplicate mechanism and must remain the core navigation model.
- Add auth, quota, CC/BCC, and UX improvements around the current flow, not instead of it.
- During testing, keep auth simple. No email confirmation is required yet.
- Quota can be generous. The goal is basic access control and abuse reduction, not strict billing accuracy yet.

## Suggested Order

1. Run `Lovable Prompt 1`.
2. Run `Lovable Prompt 2`.
3. Run `Codex Prompt 1`.
4. Run `Codex Prompt 2`.
5. Run `Codex Prompt 3`.
6. Run `Lovable Prompt 3`.

## Lovable Prompts

### Lovable Prompt 1: Auth, Settings, Quota, and Secure Reply Generation

```text
You are working in the main Send Smart app at C:\Users\null\send-smart-backend.

Implement the backend/account foundation for a Gmail AI auto-reply product. Important: the Chrome extension already has a working Gmail unread-only automation flow based on a special Gmail unread page, and that behavior must be preserved. Your work should support that flow, not replace it.

Goals:

1. Add simple account support using Supabase Auth.
2. Store each user's business/reply settings server-side.
3. Add a generous per-user quota to reduce abuse risk.
4. Stop relying on an anonymous public reply-generation flow.
5. Make the backend load settings server-side instead of trusting the extension to send all settings every time.

Requirements:

- Use simple email/password auth for now.
- Do not require email confirmation during testing.
- Create or update database schema for:
  - profiles
  - user_settings
  - usage_counters
  - reply_logs
- Add sensible Row Level Security policies.
- The saved settings should include:
  - identity
  - reply_style
  - knowledge
  - signature
  - reply_decision_mode
  - reply_decision_instructions
  - attention_rules_enabled
  - attention_rules
  - allowed_senders
  - ignored_senders
  - ignored_subjects
  - skip_replied_threads
  - skip_no_reply_senders
  - auto_send_first_contact_only
  - default_cc
  - default_bcc
- Update the existing reply-generation backend flow so it:
  - requires an authenticated user
  - reads that user's settings from the database
  - checks quota before generating
  - logs usage after generation
  - returns a draft or no-reply/needs-attention decision
- Keep quota simple for now. A monthly email-volume cap is enough.
- Make the quota generous and easy to adjust later.
- The extension should only need to send thread context plus auth. It should not need to send the user's full saved business profile every time.
- If useful, keep the current Supabase Edge Function shape, but harden it around auth and quota.

Deliverables:

- Schema/migration changes
- Any updated Edge Function code
- Any shared API contract/types needed by the frontend or extension
- A short summary of:
  - tables added
  - auth model
  - quota model
  - request/response contract the extension should use

Do not redesign the extension workflow. Preserve the current unread-only Gmail model as an external invariant.
```

### Lovable Prompt 2: Landing Page, Auth UI, Dashboard, and Install Guide

```text
You are working in the main Send Smart app at C:\Users\null\send-smart-backend.

Replace the current placeholder frontend with a real product site and dashboard for the Gmail AI auto-reply extension.

Goals:

1. Create a landing page for distribution.
2. Add login/signup pages for the new account system.
3. Add a settings dashboard for saved user configuration.
4. Add installation guidance for a manually loaded Chrome extension.
5. Prepare the UI for future paid plans, without building full billing yet.

Requirements:

- Preserve the app's current stack and patterns where reasonable.
- Build these surfaces:
  - public landing page
  - login/signup page
  - authenticated dashboard
  - settings page within the dashboard
  - usage/quota view
  - installation guide for manual/unpacked extension loading
- The dashboard settings UI should support:
  - identity
  - tone/reply style
  - business knowledge
  - signature
  - reply rules
  - attention rules
  - sender filters
  - default CC recipients
  - default BCC recipients
- The landing page should explain:
  - what the extension does
  - review mode vs auto-send mode
  - how the Gmail unread-only workflow works at a high level
  - how to install an unpacked/manual extension
  - how users will eventually get paid plans
- Add a clear place in the UI for extension download/distribution, even if the actual file hosting remains simple for now.
- Add a quota/usage section that shows current usage and remaining allowance in a straightforward way.
- Keep the design product-oriented, not generic boilerplate.

Deliverables:

- The implemented pages/components
- Any auth wiring needed for the dashboard
- Any API calls needed to load and save settings
- A short summary of routes/pages added and how the extension user should move through the site
```

### Lovable Prompt 3: Backend Contract Cleanup and Product Hardening

```text
You are working in the main Send Smart app at C:\Users\null\send-smart-backend.

Now that auth, settings, quota, and the dashboard exist, clean up the backend contract so the Chrome extension can rely on a stable, minimal authenticated API.

Goals:

1. Finalize the extension-facing authenticated reply-generation contract.
2. Reduce unnecessary client exposure and remove anonymous assumptions.
3. Add practical hardening for a first real product version.

Requirements:

- Ensure the reply-generation endpoint requires auth and works with the extension sending:
  - latest message
  - thread messages
  - subject
  - sender data
  - source URL
- Ensure all user configuration is loaded server-side.
- Ensure quota checks are server-side.
- Add basic abuse controls that are pragmatic, not overbuilt:
  - per-user quota
  - lightweight rate limiting if practical
  - clear backend errors for:
    - unauthenticated
    - quota exceeded
    - inactive account
- Make sure the API contract is simple enough for the extension to consume cleanly.
- If needed, add a small backend-facing integration note or type definitions that document the response shape expected by the extension.

Deliverables:

- Finalized authenticated API contract
- Any cleanup to schema/function code
- A concise integration summary the extension can follow

Do not spend time on heavy anti-abuse systems, advanced billing, or email confirmation. Keep this MVP-oriented.
```

## Codex Prompts

### Codex Prompt 1: Add Extension Auth Gate and Account-Aware State

```text
Work in C:\Users\null\send-smart-backend\ChromeExtensionAgent 2.

Add login/account support to the extension without breaking the existing Gmail unread-only automation flow.

Critical constraint:

- Preserve the current special Gmail unread-page workflow exactly.
- Do not switch to the normal inbox.
- Do not replace the current unread-tab navigation logic with custom dedupe logic.

Goals:

1. Require login before the extension can be used.
2. Store and refresh account session state in the extension.
3. Pause or block automation when the user is not authenticated.
4. Keep the current Gmail working flow intact.

Requirements:

- Add an auth state to the popup and options/settings experience.
- If the user is logged out:
  - do not allow starting automation
  - do not allow drafting replies
  - show a clear login/signup path
- If the session expires:
  - pause automation safely
  - show a clear message that re-authentication is required
- Reuse the backend auth model created in the main app.
- Keep extension changes focused on the extension folder only.
- Preserve the current UX for unread-only Gmail handling once authenticated.

Deliverables:

- Updated popup/options UI for auth-aware behavior
- Session persistence logic
- Safe automation blocking when unauthenticated
- A short summary of extension files changed
```

### Codex Prompt 2: Replace Anonymous Reply Generation With Authenticated Backend Calls

```text
Work in C:\Users\null\send-smart-backend\ChromeExtensionAgent 2.

Update the extension so reply generation uses the authenticated backend contract instead of relying on a weak anonymous flow.

Critical constraint:

- Preserve the current Gmail unread-only automation workflow exactly.
- Do not change the core unread-page behavior.

Goals:

1. Use the logged-in user's auth/session to call the backend.
2. Stop assuming the extension is effectively anonymous.
3. Let the backend load saved settings and enforce quota.
4. Handle auth and quota errors cleanly in the extension UX.

Requirements:

- Update the extension's reply-generation request path to send authenticated requests.
- Remove any assumptions that the extension must provide the user's full saved settings on every request.
- Keep sending the necessary thread context only.
- Handle backend responses for:
  - success
  - no reply needed
  - needs attention
  - unauthenticated
  - quota exceeded
  - inactive account
- Show useful status messages in the popup/options flow.
- Preserve the current working automation sequence as much as possible.

Deliverables:

- Updated backend request path in the extension
- Authenticated request handling
- Error-state UX for quota/auth failures
- A short summary of the updated request/response flow
```

### Codex Prompt 3: Add CC/BCC Injection and More Human-Like Reply Pacing

```text
Work in C:\Users\null\send-smart-backend\ChromeExtensionAgent 2.

Add configurable CC/BCC behavior and make the reply/send sequence feel less robotic, while preserving the current Gmail unread-only automation workflow.

Critical constraint:

- Preserve the current special Gmail unread-page workflow exactly.
- Do not change the core unread-page targeting behavior.

Goals:

1. Apply saved default CC and BCC recipients to every AI-generated reply.
2. Do this consistently in both review mode and auto-send mode.
3. Add small human-like delays between major actions.
4. Avoid making the UI automation unnecessarily fragile.

Requirements:

- Load default CC/BCC from the authenticated user's saved settings.
- In Gmail, when composing a reply:
  - open CC/BCC fields if they are collapsed
  - insert default CC recipients
  - insert default BCC recipients
  - avoid duplicates
  - avoid adding obviously invalid emails
- Apply this before sending or handing a draft to the user.
- Add jittered delays between steps such as:
  - opening the thread
  - opening the reply box
  - filling CC/BCC
  - inserting the reply body
  - sending
- Prefer safe, realistic delays over complicated fake typing.
- If text insertion changes are made, keep them robust for Gmail's editor.
- Do not break the current review-mode or auto-send-mode flow.

Deliverables:

- Gmail CC/BCC insertion support
- Humanized pacing around compose/send steps
- Any shared utility/constants added for timings
- A short summary of how the delays and recipient injection now work
```

## Notes

- The main app currently looks like the right place for landing page, auth, dashboard, and backend work.
- The nested extension project currently looks like the right place for the extension work.
- The extension should ultimately be loaded from `C:\Users\null\send-smart-backend\ChromeExtensionAgent 2\dist`.

ALTER TABLE public.thread_states
  ADD COLUMN IF NOT EXISTS auto_send boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS draft_id text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS thread_states_user_thread_provider_uidx
  ON public.thread_states (user_id, provider, thread_id);
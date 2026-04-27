ALTER TABLE public.thread_states
  ADD COLUMN IF NOT EXISTS review_opened_at timestamptz;

ALTER TABLE public.thread_state_history
  ADD COLUMN IF NOT EXISTS payload jsonb;

CREATE INDEX IF NOT EXISTS idx_thread_states_active_review
  ON public.thread_states (user_id, review_active, review_opened_at DESC)
  WHERE review_active = true;
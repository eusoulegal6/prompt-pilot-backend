ALTER TABLE public.thread_states
  ADD COLUMN IF NOT EXISTS intent_subcategory text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS customer_goal text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS business_action text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS needs_human_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS intent_review_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS intent_urgency text NOT NULL DEFAULT 'medium';

DROP INDEX IF EXISTS public.idx_thread_states_flagged;
CREATE INDEX IF NOT EXISTS idx_thread_states_needs_review
  ON public.thread_states (user_id, updated_at DESC)
  WHERE needs_human_review = true;
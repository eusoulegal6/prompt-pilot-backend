
ALTER TABLE public.thread_states
  ADD COLUMN IF NOT EXISTS intent_category text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS intent_confidence numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intent_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS intent_source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS intent_classified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_thread_states_flagged
  ON public.thread_states (user_id, updated_at DESC)
  WHERE intent_category = 'misc'
     OR (intent_category = 'support' AND intent_confidence < 0.6);

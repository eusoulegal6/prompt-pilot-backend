-- Per-thread state synced from the extension
CREATE TABLE public.thread_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'whatsapp',
  thread_id text NOT NULL,

  -- thread info
  subject text,
  sender text,
  latest_message text,
  preview text,
  unread boolean NOT NULL DEFAULT false,
  thread_url text,
  source_url text,
  queued_at timestamptz,

  -- status
  status_value text NOT NULL DEFAULT 'queued',
  backend_decision text NOT NULL DEFAULT '',
  review_reason text NOT NULL DEFAULT '',
  review_summary text NOT NULL DEFAULT '',
  draft_preview text NOT NULL DEFAULT '',
  last_error text NOT NULL DEFAULT '',

  last_draft_at timestamptz,
  last_sent_at timestamptz,
  last_opened_at timestamptz,
  last_auto_sent_at timestamptz,
  last_handled_message_key text NOT NULL DEFAULT '',
  last_auto_sent_message_key text NOT NULL DEFAULT '',

  -- review tracking
  review_active boolean NOT NULL DEFAULT false,
  review_resolved_at timestamptz,

  -- extension/event metadata
  extension_version text,
  source text,
  queue_scope text,
  last_event_type text,
  last_event_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT thread_states_user_provider_thread_unique UNIQUE (user_id, provider, thread_id)
);

CREATE INDEX idx_thread_states_user_review_active
  ON public.thread_states (user_id, review_active)
  WHERE review_active = true;

CREATE INDEX idx_thread_states_user_status
  ON public.thread_states (user_id, status_value);

ALTER TABLE public.thread_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own thread states"
  ON public.thread_states
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE TRIGGER thread_states_set_updated_at
BEFORE UPDATE ON public.thread_states
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Append-only audit trail
CREATE TABLE public.thread_state_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_state_id uuid NOT NULL REFERENCES public.thread_states(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  thread_id text NOT NULL,
  event_type text NOT NULL,
  status_value text NOT NULL DEFAULT '',
  backend_decision text NOT NULL DEFAULT '',
  review_reason text NOT NULL DEFAULT '',
  review_summary text NOT NULL DEFAULT '',
  occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_thread_state_history_user_created
  ON public.thread_state_history (user_id, created_at DESC);

CREATE INDEX idx_thread_state_history_thread
  ON public.thread_state_history (thread_state_id, created_at DESC);

ALTER TABLE public.thread_state_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own thread state history"
  ON public.thread_state_history
  FOR SELECT
  USING (auth.uid() = user_id);
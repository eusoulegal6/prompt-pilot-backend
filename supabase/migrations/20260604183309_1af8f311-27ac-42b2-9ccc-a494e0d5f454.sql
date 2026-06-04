
ALTER TABLE public.thread_states
  ADD COLUMN IF NOT EXISTS last_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS snapshot_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_unread_count integer,
  ADD COLUMN IF NOT EXISTS snapshot_from_me boolean,
  ADD COLUMN IF NOT EXISTS snapshot_msg_type text,
  ADD COLUMN IF NOT EXISTS snapshot_ack integer,
  ADD COLUMN IF NOT EXISTS snapshot_msg_timestamp bigint,
  ADD COLUMN IF NOT EXISTS snapshot_has_reaction boolean,
  ADD COLUMN IF NOT EXISTS snapshot_is_forwarded boolean,
  ADD COLUMN IF NOT EXISTS snapshot_body text;

CREATE TABLE IF NOT EXISTS public.chat_snapshots (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'whatsapp',
  thread_id text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  unread_count integer DEFAULT 0,
  from_me boolean,
  body text,
  msg_type text,
  ack integer,
  has_reaction boolean DEFAULT false,
  is_forwarded boolean DEFAULT false,
  msg_timestamp bigint,
  source text,
  extension_version text,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.chat_snapshots TO authenticated;
GRANT ALL ON public.chat_snapshots TO service_role;

ALTER TABLE public.chat_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own chat snapshots"
  ON public.chat_snapshots
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_chat_snapshots_user_thread
  ON public.chat_snapshots (user_id, thread_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_snapshots_captured_at
  ON public.chat_snapshots (captured_at DESC);

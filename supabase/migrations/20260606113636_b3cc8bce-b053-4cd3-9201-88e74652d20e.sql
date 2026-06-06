
CREATE TABLE public.sync_events (
  event_id text PRIMARY KEY,
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'whatsapp',
  thread_id text NOT NULL,
  event_type text NOT NULL,
  scan_id text,
  schema_version int,
  payload_sha256 text NOT NULL,
  stored_message_count int,
  received_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.sync_events TO authenticated;
GRANT ALL ON public.sync_events TO service_role;
ALTER TABLE public.sync_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own sync events" ON public.sync_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX sync_events_user_thread_idx ON public.sync_events(user_id, thread_id, received_at DESC);

CREATE TABLE public.scan_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'whatsapp',
  thread_id text NOT NULL,
  event_id text NOT NULL REFERENCES public.sync_events(event_id) ON DELETE CASCADE,
  message_id text,
  ordinal int NOT NULL,
  source_model_index int,
  sender_id text,
  from_me boolean,
  msg_timestamp bigint,
  raw_body text,
  normalized_body text,
  degraded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.scan_messages TO authenticated;
GRANT ALL ON public.scan_messages TO service_role;
ALTER TABLE public.scan_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own scan messages" ON public.scan_messages
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE UNIQUE INDEX scan_messages_event_ordinal_uidx ON public.scan_messages(event_id, ordinal);
CREATE UNIQUE INDEX scan_messages_thread_msgid_uidx ON public.scan_messages(user_id, thread_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX scan_messages_thread_idx ON public.scan_messages(user_id, thread_id, msg_timestamp DESC);

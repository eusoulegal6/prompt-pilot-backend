ALTER TABLE public.thread_states
  ADD COLUMN IF NOT EXISTS last_scan jsonb,
  ADD COLUMN IF NOT EXISTS scan_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS scan_message_count integer;

CREATE TABLE IF NOT EXISTS public.chat_scans (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'whatsapp',
  thread_id text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  message_count integer NOT NULL DEFAULT 0,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text,
  extension_version text,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.chat_scans TO authenticated;
GRANT ALL ON public.chat_scans TO service_role;

ALTER TABLE public.chat_scans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own chat scans"
  ON public.chat_scans FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_chat_scans_user_thread
  ON public.chat_scans (user_id, thread_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_scans_captured_at
  ON public.chat_scans (captured_at DESC);
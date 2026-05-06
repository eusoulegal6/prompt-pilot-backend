CREATE TABLE public.whisper_invocations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  provider TEXT,
  mime_type TEXT,
  status TEXT NOT NULL,
  chars INTEGER,
  duration_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.whisper_invocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view whisper invocations"
ON public.whisper_invocations FOR SELECT
TO authenticated
USING (true);

CREATE INDEX idx_whisper_invocations_created_at ON public.whisper_invocations(created_at DESC);

ALTER PUBLICATION supabase_realtime ADD TABLE public.whisper_invocations;
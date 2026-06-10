CREATE TABLE public.contact_backups (
  thread_id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.contact_backups TO service_role;
ALTER TABLE public.contact_backups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service only" ON public.contact_backups FOR ALL USING (false);
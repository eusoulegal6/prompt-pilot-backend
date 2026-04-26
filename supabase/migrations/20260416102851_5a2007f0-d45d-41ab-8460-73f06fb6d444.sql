
-- usage_counters: one row per user per calendar month
CREATE TABLE public.usage_counters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  emails_used INTEGER NOT NULL DEFAULT 0,
  input_tokens_used BIGINT NOT NULL DEFAULT 0,
  output_tokens_used BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, period)
);

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own usage"
  ON public.usage_counters FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX idx_usage_counters_user_period ON public.usage_counters (user_id, period);

-- reply_logs: append-only log of every generation attempt
CREATE TABLE public.reply_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  subject TEXT,
  sender_email TEXT,
  source_url TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  decision TEXT NOT NULL DEFAULT 'reply',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.reply_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own reply logs"
  ON public.reply_logs FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX idx_reply_logs_user_period ON public.reply_logs (user_id, period);

-- updated_at trigger for usage_counters
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_usage_counters_updated_at
  BEFORE UPDATE ON public.usage_counters
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

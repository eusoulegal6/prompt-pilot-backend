-- Extension pairing codes (short-lived, single use)
CREATE TABLE public.extension_pair_codes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_extension_pair_codes_user ON public.extension_pair_codes(user_id);
CREATE INDEX idx_extension_pair_codes_code ON public.extension_pair_codes(code);

ALTER TABLE public.extension_pair_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own pair codes"
ON public.extension_pair_codes
FOR SELECT
USING (auth.uid() = user_id);

-- Extension tokens (long-lived, per device)
CREATE TABLE public.extension_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_extension_tokens_user ON public.extension_tokens(user_id);
CREATE INDEX idx_extension_tokens_hash ON public.extension_tokens(token_hash);

ALTER TABLE public.extension_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own extension tokens"
ON public.extension_tokens
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can revoke their own extension tokens"
ON public.extension_tokens
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
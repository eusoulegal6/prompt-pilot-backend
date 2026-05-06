DROP POLICY IF EXISTS "Authenticated users can view whisper invocations" ON public.whisper_invocations;
CREATE POLICY "Anyone can view whisper invocations"
ON public.whisper_invocations FOR SELECT
TO anon, authenticated
USING (true);
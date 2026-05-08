-- Make user_id non-nullable so RLS delete policy is reliable
ALTER TABLE public.whisper_invocations
ALTER COLUMN user_id SET NOT NULL;

-- Allow authenticated users to delete their own whisper invocations
CREATE POLICY "Users can delete their own whisper invocations"
ON public.whisper_invocations
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);
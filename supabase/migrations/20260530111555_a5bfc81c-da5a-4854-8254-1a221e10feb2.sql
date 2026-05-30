UPDATE public.extension_tokens
SET user_id = '2114edee-36ab-46c7-9f3d-e763aff4dc04'
WHERE user_id = 'e49ff6d9-a7a1-40c2-b5c9-2b7bd2ec124e'
  AND revoked_at IS NULL;
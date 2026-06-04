ALTER TABLE public.chat_snapshots REPLICA IDENTITY FULL;
ALTER TABLE public.chat_scans REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_snapshots;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_scans;
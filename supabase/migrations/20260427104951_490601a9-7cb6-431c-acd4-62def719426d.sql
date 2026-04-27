ALTER TABLE public.thread_states REPLICA IDENTITY FULL;
ALTER TABLE public.thread_state_history REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.thread_states;
ALTER PUBLICATION supabase_realtime ADD TABLE public.thread_state_history;
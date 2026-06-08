import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Inbox, RefreshCw, Trash2, ChevronDown, ChevronRight } from "lucide-react";

type SyncEvent = {
  event_id: string;
  event_type: string;
  provider: string | null;
  thread_id: string;
  scan_id: string | null;
  schema_version: number | null;
  payload_sha256: string;
  stored_message_count: number | null;
  received_at: string;
};

type ScanMessage = {
  event_id: string;
  thread_id: string;
  message_id: string | null;
  ordinal: number;
  source_model_index: number | null;
  sender_id: string | null;
  from_me: boolean;
  msg_timestamp: number;
  raw_body: string | null;
  normalized_body: string | null;
  degraded: boolean;
};

const URL_BASE =
  "https://ocpphyjkstvfespxrajk.supabase.co/functions/v1/message-batches";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jcHBoeWprc3R2ZmVzcHhyYWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODExMzUsImV4cCI6MjA5Mjc1NzEzNX0.wcqrpSVkgDZRPet_4yLcF5YYISsWqRacVNOHf_eW8uY";

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));

const MessageBatchesSection = () => {
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [messages, setMessages] = useState<ScanMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setError("Not signed in");
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const res = await fetch(`${URL_BASE}?limit=15`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setEvents(Array.isArray(body.events) ? body.events : []);
      setMessages(Array.isArray(body.messages) ? body.messages : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load batches");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const clearAll = useCallback(async () => {
    if (!window.confirm("Clear all your messages, scans, snapshots and thread state? This cannot be undone.")) return;
    setClearing(true);
    setError(null);
    setInfo(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setError("Not signed in"); setClearing(false); return; }
    try {
      const res = await fetch(URL_BASE, {
        method: "POST",
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "clear" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setInfo("Cleared. Waiting for next batch…");
      setEvents([]);
      setMessages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to clear");
    } finally {
      setClearing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 10_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const messagesByEvent = useMemo(() => {
    const map = new Map<string, ScanMessage[]>();
    for (const m of messages) {
      const arr = map.get(m.event_id) ?? [];
      arr.push(m);
      map.set(m.event_id, arr);
    }
    return map;
  }, [messages]);

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Inbox className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold text-card-foreground">Incoming Batches</h2>
        <span className="text-xs text-muted-foreground">Live</span>
        <button
          onClick={load}
          disabled={refreshing}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-card-foreground hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
        <button
          onClick={clearAll}
          disabled={clearing}
          className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-2.5 py-1 text-xs hover:bg-destructive/20 disabled:opacity-60"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {clearing ? "Clearing…" : "Clear all"}
        </button>
      </div>

      {info ? <p className="text-xs text-muted-foreground mb-2">{info}</p> : null}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No batches yet. Waiting for the next incoming payload…</p>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => {
            const isOpen = expanded === e.event_id;
            const msgs = messagesByEvent.get(e.event_id) ?? [];
            return (
              <li key={e.event_id} className="rounded-md border border-border px-3 py-2 text-sm">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : e.event_id)}
                  className="flex items-center gap-2 w-full text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs">{e.event_type}</span>
                  <span className="font-mono text-xs text-card-foreground/80 truncate max-w-[16rem]">{e.thread_id}</span>
                  {typeof e.stored_message_count === "number" ? (
                    <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs">
                      {e.stored_message_count} msgs
                    </span>
                  ) : null}
                  {e.schema_version ? (
                    <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs">v{e.schema_version}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">{formatTime(e.received_at)}</span>
                </button>
                {isOpen ? (
                  <div className="mt-2 border-l-2 border-primary pl-3 space-y-1.5">
                    <p className="text-xs text-muted-foreground font-mono break-all">
                      event: {e.event_id} • sha: {e.payload_sha256.slice(0, 16)}…
                    </p>
                    {msgs.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No per-message rows for this event.</p>
                    ) : (
                      msgs.map((m, i) => (
                        <div key={`${m.event_id}-${m.ordinal}-${i}`} className="text-xs">
                          <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground">
                            <span>#{m.ordinal}</span>
                            {m.from_me ? (
                              <span className="rounded-full bg-primary/10 text-primary px-1.5 py-0.5">sent</span>
                            ) : (
                              <span className="rounded-full bg-muted px-1.5 py-0.5">received</span>
                            )}
                            {m.degraded ? (
                              <span className="rounded-full bg-destructive/15 text-destructive px-1.5 py-0.5">degraded</span>
                            ) : null}
                            <span className="font-mono">
                              {new Date(Number(m.msg_timestamp) * 1000).toISOString().replace("T", " ").slice(0, 19)}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap text-card-foreground/90">
                            {m.raw_body && m.raw_body.length > 0 ? m.raw_body : <span className="italic text-muted-foreground">(empty body)</span>}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default MessageBatchesSection;
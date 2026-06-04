import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Activity, MessageSquare, ScanLine, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";

type Snapshot = {
  id: string;
  thread_id: string;
  provider: string | null;
  captured_at: string;
  unread_count: number | null;
  body: string | null;
  from_me: boolean | null;
  msg_type: string | null;
  ack: number | null;
  has_reaction: boolean | null;
  is_forwarded: boolean | null;
};

type Scan = {
  id: string;
  thread_id: string;
  provider: string | null;
  captured_at: string;
  message_count: number;
  messages: unknown[];
  messages_truncated?: boolean;
  source: string | null;
  extension_version: string | null;
};

type Thread = {
  thread_id: string;
  provider: string;
  sender: string | null;
  subject: string | null;
  thread_url: string | null;
};

type ApiResponse = {
  ok?: boolean;
  threads?: Thread[];
  snapshots?: Snapshot[];
  scans?: Scan[];
  error?: string;
};

const THREAD_ACTIVITY_URL =
  "https://ocpphyjkstvfespxrajk.supabase.co/functions/v1/thread-activity";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jcHBoeWprc3R2ZmVzcHhyYWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODExMzUsImV4cCI6MjA5Mjc1NzEzNX0.wcqrpSVkgDZRPet_4yLcF5YYISsWqRacVNOHf_eW8uY";

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const ThreadActivitySection = () => {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedScan, setExpandedScan] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      setSnapshots([]);
      setScans([]);
      setThreads([]);
      setError("Not signed in");
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      const res = await fetch(`${THREAD_ACTIVITY_URL}?limit=20`, {
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiResponse | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }

      const body = (await res.json()) as ApiResponse;
      setThreads(Array.isArray(body.threads) ? body.threads : []);
      setSnapshots(Array.isArray(body.snapshots) ? body.snapshots : []);
      setScans(Array.isArray(body.scans) ? body.scans : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load thread activity");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 15_000);

    let snapChannel: ReturnType<typeof supabase.channel> | null = null;
    let scanChannel: ReturnType<typeof supabase.channel> | null = null;

    supabase.auth.getSession().then(({ data: { session } }) => {
      const userId = session?.user.id;
      if (!userId) return;

      snapChannel = supabase
        .channel("chat-snapshots-feed")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "chat_snapshots", filter: `user_id=eq.${userId}` },
          () => load(),
        )
        .subscribe();

      scanChannel = supabase
        .channel("chat-scans-feed")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "chat_scans", filter: `user_id=eq.${userId}` },
          () => load(),
        )
        .subscribe();
    });

    return () => {
      window.clearInterval(interval);
      if (snapChannel) supabase.removeChannel(snapChannel);
      if (scanChannel) supabase.removeChannel(scanChannel);
    };
  }, [load]);

  const threadMap = useMemo(() => {
    const map = new Map<string, Thread>();
    threads.forEach((t) => map.set(t.thread_id, t));
    return map;
  }, [threads]);

  const dedupedSnapshots = useMemo(() => {
    const seen = new Set<string>();
    return snapshots.filter((s) => {
      if (seen.has(s.thread_id)) return false;
      seen.add(s.thread_id);
      return true;
    });
  }, [snapshots]);

  const label = (threadId: string) => {
    const t = threadMap.get(threadId);
    return t?.sender || t?.subject || threadId.slice(0, 16);
  };

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold text-card-foreground">Thread Activity</h2>
        <span className="text-xs text-muted-foreground">Live</span>
        <button
          onClick={load}
          disabled={refreshing}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-card-foreground hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium text-card-foreground">Live snapshots</h3>
              <span className="text-xs text-muted-foreground">({dedupedSnapshots.length})</span>
            </div>
            {dedupedSnapshots.length === 0 ? (
              <p className="text-sm text-muted-foreground">No snapshots yet.</p>
            ) : (
              <ul className="space-y-2">
                {dedupedSnapshots.map((s) => (
                  <li key={s.id} className="rounded-md border border-border px-3 py-2 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-card-foreground truncate max-w-[14rem]">
                        {label(s.thread_id)}
                      </span>
                      {s.from_me ? (
                        <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs">sent</span>
                      ) : (
                        <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs">received</span>
                      )}
                      {s.unread_count && s.unread_count > 0 ? (
                        <span className="rounded-full bg-destructive/15 text-destructive px-2 py-0.5 text-xs">
                          {s.unread_count} unread
                        </span>
                      ) : null}
                      {s.msg_type && s.msg_type !== "chat" ? (
                        <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs">
                          {s.msg_type}
                        </span>
                      ) : null}
                      <span className="ml-auto text-xs text-muted-foreground">{formatTime(s.captured_at)}</span>
                    </div>
                    {s.body ? (
                      <p className="mt-1 whitespace-pre-wrap text-card-foreground/90 text-sm">{s.body}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <ScanLine className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium text-card-foreground">Recent scans</h3>
              <span className="text-xs text-muted-foreground">({scans.length})</span>
            </div>
            {scans.length === 0 ? (
              <p className="text-sm text-muted-foreground">No scans yet.</p>
            ) : (
              <ul className="space-y-2">
                {scans.map((sc) => {
                  const expanded = expandedScan === sc.id;
                  return (
                    <li key={sc.id} className="rounded-md border border-border px-3 py-2 text-sm">
                      <button
                        type="button"
                        onClick={() => setExpandedScan(expanded ? null : sc.id)}
                        className="flex items-center gap-2 w-full text-left"
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className="font-medium text-card-foreground truncate max-w-[14rem]">
                          {label(sc.thread_id)}
                        </span>
                        <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs">
                          {sc.message_count} msgs
                        </span>
                        {sc.source ? (
                          <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs">
                            {sc.source}
                          </span>
                        ) : null}
                        <span className="ml-auto text-xs text-muted-foreground">{formatTime(sc.captured_at)}</span>
                      </button>
                      {expanded ? (
                        <div className="mt-2 border-l-2 border-primary pl-3 space-y-1">
                          {sc.messages_truncated ? (
                            <p className="text-xs text-muted-foreground">Showing last {sc.messages.length} of {sc.message_count}</p>
                          ) : null}
                          <pre className="text-xs whitespace-pre-wrap text-card-foreground/80 font-mono">
                            {JSON.stringify(sc.messages, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default ThreadActivitySection;
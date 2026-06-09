import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Users, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";

type ThreadState = {
  thread_id: string;
  sender: string | null;
  subject: string | null;
  provider: string | null;
};

type ScanMessage = {
  id: string;
  thread_id: string;
  sender_id: string | null;
  sender: string | null;
  from_me: boolean | null;
  msg_timestamp: number | null;
  body: string | null;
  normalized_body: string | null;
  raw_body: string | null;
  msg_type: string | null;
  ack: number | null;
  has_reaction: boolean | null;
  is_forwarded: boolean | null;
  has_media: boolean | null;
  caption: string | null;
  mime_type: string | null;
  created_at: string;
};

type Contact = {
  key: string;
  label: string;
  threadIds: Set<string>;
  messages: ScanMessage[];
  lastTs: number;
};

const formatTime = (ms: number) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));

const ContactsSection = () => {
  const [threads, setThreads] = useState<ThreadState[]>([]);
  const [messages, setMessages] = useState<ScanMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [tRes, mRes] = await Promise.all([
        supabase
          .from("thread_states")
          .select("thread_id, sender, subject, provider"),
        supabase
          .from("scan_messages")
          .select(
            "id, thread_id, sender_id, sender, from_me, msg_timestamp, body, normalized_body, raw_body, msg_type, ack, has_reaction, is_forwarded, has_media, caption, mime_type, created_at",
          )
          .order("msg_timestamp", { ascending: true })
          .limit(5000),
      ]);
      if (tRes.error) throw tRes.error;
      if (mRes.error) throw mRes.error;
      setThreads((tRes.data ?? []) as ThreadState[]);
      setMessages((mRes.data ?? []) as ScanMessage[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const threadMap = useMemo(() => {
    const m = new Map<string, ThreadState>();
    threads.forEach((t) => m.set(t.thread_id, t));
    return m;
  }, [threads]);

  const contacts = useMemo<Contact[]>(() => {
    const byKey = new Map<string, Contact>();
    for (const msg of messages) {
      const t = threadMap.get(msg.thread_id);
      const label =
        t?.sender ||
        t?.subject ||
        msg.sender ||
        msg.sender_id ||
        msg.thread_id;
      const key = label;
      let c = byKey.get(key);
      if (!c) {
        c = {
          key,
          label,
          threadIds: new Set(),
          messages: [],
          lastTs: 0,
        };
        byKey.set(key, c);
      }
      c.threadIds.add(msg.thread_id);
      c.messages.push(msg);
      const ts = msg.msg_timestamp ? msg.msg_timestamp * 1000 : Date.parse(msg.created_at);
      if (ts > c.lastTs) c.lastTs = ts;
    }
    return Array.from(byKey.values()).sort((a, b) => b.lastTs - a.lastTs);
  }, [messages, threadMap]);

  const renderBody = (m: ScanMessage) => {
    const text = m.body || m.normalized_body || m.raw_body || m.caption;
    if (text) return text;
    if (m.has_media) return `[${m.msg_type || "media"}${m.mime_type ? ` · ${m.mime_type}` : ""}]`;
    return `[${m.msg_type || "message"}]`;
  };

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Users className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold text-card-foreground">Contacts</h2>
        <span className="text-xs text-muted-foreground">
          {contacts.length ? `${contacts.length} contact${contacts.length === 1 ? "" : "s"}` : ""}
        </span>
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
      ) : contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      ) : (
        <ul className="space-y-2">
          {contacts.map((c) => {
            const open = expanded === c.key;
            return (
              <li key={c.key} className="rounded-md border border-border">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : c.key)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
                >
                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="font-medium text-card-foreground truncate max-w-[16rem]">
                    {c.label}
                  </span>
                  <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs">
                    {c.messages.length} msg{c.messages.length === 1 ? "" : "s"}
                  </span>
                  {c.threadIds.size > 1 ? (
                    <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs">
                      {c.threadIds.size} threads
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {c.lastTs ? formatTime(c.lastTs) : ""}
                  </span>
                </button>
                {open ? (
                  <div className="border-t border-border px-3 py-2 space-y-2 max-h-[28rem] overflow-y-auto">
                    {c.messages.map((m) => {
                      const ts = m.msg_timestamp
                        ? m.msg_timestamp * 1000
                        : Date.parse(m.created_at);
                      return (
                        <div
                          key={m.id}
                          className={`flex flex-col rounded-md px-3 py-2 text-sm ${
                            m.from_me
                              ? "bg-primary/10 self-end ml-8"
                              : "bg-muted mr-8"
                          }`}
                        >
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1 flex-wrap">
                            <span className="font-medium">
                              {m.from_me ? "You" : c.label}
                            </span>
                            {m.msg_type && m.msg_type !== "chat" ? (
                              <span className="rounded-full bg-background px-1.5 py-0.5">
                                {m.msg_type}
                              </span>
                            ) : null}
                            {m.is_forwarded ? (
                              <span className="rounded-full bg-background px-1.5 py-0.5">
                                forwarded
                              </span>
                            ) : null}
                            {m.has_reaction ? <span>♥</span> : null}
                            <span className="ml-auto">{formatTime(ts)}</span>
                          </div>
                          <p className="whitespace-pre-wrap text-card-foreground">
                            {renderBody(m)}
                          </p>
                        </div>
                      );
                    })}
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

export default ContactsSection;
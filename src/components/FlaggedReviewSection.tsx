import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";

type FlaggedItem = {
  thread_id: string;
  provider: string;
  sender: string | null;
  subject: string | null;
  preview: string | null;
  latest_message: string | null;
  intent_category: string;
  intent_subcategory: string | null;
  intent_confidence: number | string;
  intent_reason: string;
  intent_source: string;
  intent_classified_at: string | null;
  customer_goal: string | null;
  business_action: string | null;
  needs_human_review: boolean | null;
  intent_review_reason: string | null;
  intent_urgency: "low" | "medium" | "high" | null;
  updated_at: string;
  thread_url: string | null;
};

const URGENCY_STYLES: Record<string, string> = {
  high: "bg-destructive/15 text-destructive border-destructive/30",
  medium: "bg-primary/10 text-primary border-primary/20",
  low: "bg-muted text-muted-foreground border-border",
};

const prettyIntent = (slug: string | null | undefined) =>
  (slug ?? "").replace(/_/g, " ").trim() || "unclassified";

const FLAGGED_LIST_URL = "https://ocpphyjkstvfespxrajk.supabase.co/functions/v1/flagged-list";
const FLAGGED_LIST_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jcHBoeWprc3R2ZmVzcHhyYWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODExMzUsImV4cCI6MjA5Mjc1NzEzNX0.wcqrpSVkgDZRPet_4yLcF5YYISsWqRacVNOHf_eW8uY";

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const FlaggedReviewSection = () => {
  const [items, setItems] = useState<FlaggedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      setItems([]);
      setError("Not signed in");
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      const res = await fetch(`${FLAGGED_LIST_URL}?limit=20`, {
        headers: {
          apikey: FLAGGED_LIST_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }

      const body = (await res.json()) as { items?: FlaggedItem[] };
      setItems(Array.isArray(body.items) ? body.items : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load flagged messages");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 15_000);

    let channel: ReturnType<typeof supabase.channel> | null = null;
    supabase.auth.getSession().then(({ data: { session } }) => {
      const userId = session?.user.id;
      if (!userId) return;
      channel = supabase
        .channel("flagged-thread-states")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "thread_states",
            filter: `user_id=eq.${userId}`,
          },
          () => load(),
        )
        .subscribe();
    });

    return () => {
      window.clearInterval(interval);
      if (channel) supabase.removeChannel(channel);
    };
  }, [load]);

  const dedupedItems = useMemo(() => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = (item.sender || item.thread_id).trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [items]);

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 mb-4">
        <AlertTriangle className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold text-card-foreground">Flagged Messages</h2>
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
      ) : dedupedItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">No flagged messages right now.</p>
      ) : (
        <ul className="space-y-2">
          {dedupedItems.map((item) => {
            const confidence = Number(item.intent_confidence || 0);
            const message = item.latest_message?.trim() || item.preview?.trim() || item.subject?.trim() || "No message preview";

            return (
              <li key={`${item.provider}-${item.thread_id}`} className="rounded-md border border-border px-3 py-2 text-sm">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-card-foreground truncate max-w-[14rem]">
                        {item.sender || item.subject || "Unknown sender"}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {prettyIntent(item.intent_subcategory || item.intent_category)} · {Math.round(confidence * 100)}%
                      </span>
                      {item.intent_urgency ? (
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs capitalize ${
                            URGENCY_STYLES[item.intent_urgency] ?? URGENCY_STYLES.medium
                          }`}
                        >
                          {item.intent_urgency} urgency
                        </span>
                      ) : null}
                      <span className="text-xs text-muted-foreground">{formatTime(item.updated_at)}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-card-foreground/90">{message}</p>
                    {item.customer_goal ? (
                      <p className="mt-2 text-xs text-card-foreground/80">
                        <span className="font-medium">Customer goal: </span>
                        {item.customer_goal}
                      </p>
                    ) : null}
                    {item.business_action ? (
                      <p className="mt-1 text-xs text-card-foreground/80">
                        <span className="font-medium">Next action: </span>
                        {item.business_action}
                      </p>
                    ) : null}
                    {item.intent_review_reason || item.intent_reason ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {item.intent_review_reason || item.intent_reason}
                      </p>
                    ) : null}
                  </div>
                  {item.thread_url ? (
                    <a
                      href={item.thread_url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md p-1 text-muted-foreground hover:text-card-foreground hover:bg-muted transition-colors"
                      aria-label="Open WhatsApp thread"
                      title="Open WhatsApp thread"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default FlaggedReviewSection;
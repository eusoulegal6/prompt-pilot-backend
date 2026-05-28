import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { AlertTriangle, ArchiveX, CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";

type ReviewItem = {
  id: string;
  thread_id: string;
  provider: string;
  sender?: string | null;
  senderName?: string | null;
  subject?: string | null;
  snippet?: string | null;
  reason?: string | null;
  review_reason?: string | null;
  review_summary?: string | null;
  review_opened_at?: string | null;
  updated_at?: string | null;
  createdAt?: string | null;
  status_value?: string | null;
  thread_url?: string | null;
  source_url?: string | null;
};

const formatDate = (value?: string | null) => {
  if (!value) return "Recently";
  return new Date(value).toLocaleString();
};

const getItemUrl = (item: ReviewItem) => item.thread_url || item.source_url || null;

export default function FlaggedReviewPanel() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    const { data, error: invokeError } = await supabase.functions.invoke<{ items?: ReviewItem[] }>(
      "review-list",
      { method: "GET" },
    );

    if (invokeError) {
      setError(invokeError.message);
      if (!quiet) setItems([]);
    } else {
      setItems(data?.items ?? []);
    }

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();

    const onThreadStatesChanged = () => load(true);
    window.addEventListener("thread-states:changed", onThreadStatesChanged);

    const intervalId = window.setInterval(() => load(true), 10_000);
    return () => {
      window.removeEventListener("thread-states:changed", onThreadStatesChanged);
      window.clearInterval(intervalId);
    };
  }, [load]);

  const resolveItem = async (item: ReviewItem, resolution: "handled" | "dismissed") => {
    setResolvingId(item.id);

    const { error: invokeError } = await supabase.functions.invoke("review-resolve", {
      body: {
        id: item.id,
        thread_id: item.thread_id,
        provider: item.provider,
        resolution,
      },
    });

    if (invokeError) {
      toast({
        title: "Review update failed",
        description: invokeError.message,
        variant: "destructive",
      });
    } else {
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      toast({ title: resolution === "handled" ? "Marked handled" : "Dismissed" });
    }

    setResolvingId(null);
  };

  const countLabel = useMemo(() => `${items.length} open`, [items.length]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-primary" />
              Flagged messages
            </CardTitle>
            <CardDescription>Messages waiting for human review from the extension.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              {countLabel}
            </span>
            <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing || loading}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="sr-only">Refresh flagged messages</span>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading flagged messages...
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No flagged messages are waiting for review.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => {
              const itemUrl = getItemUrl(item);
              const isResolving = resolvingId === item.id;
              const reason = item.review_reason || item.reason || item.status_value || "Review needed";

              return (
                <li key={item.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <div className="space-y-1">
                        <p className="truncate text-sm font-semibold text-card-foreground">
                          {item.subject || "Untitled message"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {item.senderName || item.sender || item.provider} · {formatDate(item.review_opened_at || item.createdAt || item.updated_at)}
                        </p>
                      </div>
                      {item.snippet ? (
                        <p className="line-clamp-2 text-sm text-card-foreground/80">{item.snippet}</p>
                      ) : null}
                      <p className="text-xs font-medium text-muted-foreground">{reason}</p>
                      {item.review_summary ? (
                        <p className="text-xs text-muted-foreground">{item.review_summary}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {itemUrl ? (
                        <Button variant="ghost" size="sm" asChild>
                          <a href={itemUrl} target="_blank" rel="noreferrer" aria-label="Open message thread">
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </Button>
                      ) : null}
                      <Button variant="outline" size="sm" onClick={() => resolveItem(item, "dismissed")} disabled={isResolving}>
                        <ArchiveX className="h-4 w-4" />
                        Dismiss
                      </Button>
                      <Button size="sm" onClick={() => resolveItem(item, "handled")} disabled={isResolving}>
                        {isResolving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        Handled
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
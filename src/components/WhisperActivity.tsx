import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Mic, CheckCircle2, AlertTriangle, Trash2 } from "lucide-react";

type Row = {
  id: string;
  provider: string | null;
  mime_type: string | null;
  status: string;
  chars: number | null;
  duration_ms: number | null;
  error: string | null;
  transcript: string | null;
  created_at: string;
};

const WhisperActivity = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data } = await supabase
      .from("whisper_invocations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    setRows((data as Row[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const channel = supabase
      .channel("whisper-invocations")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "whisper_invocations" },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleDelete = async (id: string) => {
    const { error } = await supabase
      .from("whisper_invocations")
      .delete()
      .eq("id", id);
    if (error) {
      console.error("Failed to delete whisper invocation:", error);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 mb-4">
        <Mic className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold text-card-foreground">
          Whisper Activity
        </h2>
        <span className="ml-auto text-xs text-muted-foreground">
          Live · last 20
        </span>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No audio transcriptions yet. Send a voice note through the extension.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const ok = r.status === "success";
            return (
              <li
                key={r.id}
                className="rounded-md border border-border px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  {ok ? (
                    <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                  )}
                  <span className="font-mono text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleTimeString()}
                  </span>
                  <span className="text-card-foreground">
                    {r.provider ?? "?"} · {r.mime_type ?? "?"}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {ok
                      ? `${r.chars ?? 0} chars · ${r.duration_ms ?? 0}ms`
                      : r.error ?? r.status}
                  </span>
                  <button
                    onClick={() => handleDelete(r.id)}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    title="Delete"
                    aria-label="Delete whisper activity"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {ok && r.transcript ? (
                  <p className="mt-2 whitespace-pre-wrap text-card-foreground/90 text-sm border-l-2 border-primary pl-3">
                    {r.transcript}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default WhisperActivity;
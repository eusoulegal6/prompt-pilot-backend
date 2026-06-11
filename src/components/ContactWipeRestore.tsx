import { useCallback, useEffect, useState } from "react";
import { Trash2, RotateCcw, RefreshCw, Clock } from "lucide-react";

const FN_URL =
  "https://ocpphyjkstvfespxrajk.supabase.co/functions/v1/contact-wipe-restore";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jcHBoeWprc3R2ZmVzcHhyYWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODExMzUsImV4cCI6MjA5Mjc1NzEzNX0.wcqrpSVkgDZRPet_4yLcF5YYISsWqRacVNOHf_eW8uY";
const CONTACT_LABEL = "+595 971 570329";

type Status = {
  counts: Record<string, number>;
  backup_at: string | null;
};

const ContactWipeRestore = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (action: "status" | "wipe" | "restore" | "refresh_captured_at") => {
    setBusy(action);
    setError(null);
    if (action !== "status") setMessage(null);
    try {
      const res = await fetch(FN_URL, {
        method: "POST",
        headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      if (action === "status") {
        setStatus({ counts: body.counts, backup_at: body.backup_at });
      } else {
        setMessage(
          action === "wipe"
            ? `Wiped. Backed up ${body.backed_up} rows.`
            : action === "restore"
            ? `Restored ${body.restored} rows.`
            : `Updated ${body.updated_scans} scan snapshots.`,
        );
        await call("status");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    call("status");
  }, [call]);

  const total = status
    ? Object.values(status.counts).reduce((n, c) => n + c, 0)
    : 0;

  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-lg font-semibold text-card-foreground">
          Test Contact Snapshot
        </h2>
        <span className="text-xs text-muted-foreground">{CONTACT_LABEL}</span>
        <button
          onClick={() => call("status")}
          disabled={busy !== null}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-card-foreground hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy === "status" ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        {status ? (
          <>
            <span className="text-card-foreground font-medium">{total}</span> rows live ·{" "}
            {status.backup_at ? (
              <>backup from {new Date(status.backup_at).toLocaleString()}</>
            ) : (
              <>no backup yet</>
            )}
          </>
        ) : (
          "Loading…"
        )}
      </div>

      {status ? (
        <div className="flex flex-wrap gap-1 mb-4">
          {Object.entries(status.counts).map(([t, c]) => (
            <span
              key={t}
              className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-[11px]"
            >
              {t}: {c}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex gap-2">
        <button
          onClick={() => {
            if (confirm(`Wipe all data for ${CONTACT_LABEL}? A backup will be saved.`)) {
              call("wipe");
            }
          }}
          disabled={busy !== null || total === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-destructive text-destructive-foreground px-3 py-1.5 text-sm hover:bg-destructive/90 disabled:opacity-60"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {busy === "wipe" ? "Wiping…" : "Wipe contact"}
        </button>
        <button
          onClick={() => call("restore")}
          disabled={busy !== null || !status?.backup_at}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-card-foreground hover:bg-muted disabled:opacity-60"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {busy === "restore" ? "Restoring…" : "Restore backup"}
        </button>
        <button
          onClick={() => call("refresh_captured_at")}
          disabled={busy !== null || total === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-card-foreground hover:bg-muted disabled:opacity-60"
        >
          <Clock className="h-3.5 w-3.5" />
          {busy === "refresh_captured_at" ? "Updating…" : "Refresh timestamps"}
        </button>
      </div>

      {message ? (
        <p className="mt-3 text-xs text-muted-foreground">{message}</p>
      ) : null}
      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
    </section>
  );
};

export default ContactWipeRestore;
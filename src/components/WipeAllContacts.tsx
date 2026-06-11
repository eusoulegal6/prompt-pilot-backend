import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";

const FN_URL =
  "https://ocpphyjkstvfespxrajk.supabase.co/functions/v1/wipe-all-contacts";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jcHBoeWprc3R2ZmVzcHhyYWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODExMzUsImV4cCI6MjA5Mjc1NzEzNX0.wcqrpSVkgDZRPet_4yLcF5YYISsWqRacVNOHf_eW8uY";
const CONFIRM_PHRASE = "WIPE ALL CONTACTS";

const WipeAllContacts = () => {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (action: "status" | "wipe", confirm?: string) => {
      setBusy(action);
      setError(null);
      if (action !== "status") setMessage(null);
      try {
        const res = await fetch(FN_URL, {
          method: "POST",
          headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ action, confirm }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (action === "status") {
          setCounts(body.counts);
        } else {
          setMessage(`Wiped ${body.total} rows across ${Object.keys(body.deleted).length} tables.`);
          await call("status");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  useEffect(() => {
    call("status");
  }, [call]);

  const total = counts ? Object.values(counts).reduce((n, c) => n + c, 0) : 0;

  const onWipe = () => {
    const first = confirm(
      `This will permanently delete ALL contact data across every table (${total} rows). This cannot be undone. Continue?`,
    );
    if (!first) return;
    const phrase = prompt(`Type "${CONFIRM_PHRASE}" to confirm:`);
    if (phrase !== CONFIRM_PHRASE) {
      setError("Confirmation phrase did not match. Wipe cancelled.");
      return;
    }
    call("wipe", CONFIRM_PHRASE);
  };

  return (
    <section className="rounded-lg border border-destructive/40 bg-card p-6">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <h2 className="text-lg font-semibold text-card-foreground">Danger Zone</h2>
        <button
          onClick={() => call("status")}
          disabled={busy !== null}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-card-foreground hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy === "status" ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <p className="text-xs text-muted-foreground mb-3">
        Wipes every contact-related row globally: scans, snapshots, messages, thread states,
        sync events, appointments, reply logs, whisper invocations, and contact backups.
        There is no undo.
      </p>

      <div className="text-xs text-muted-foreground mb-3">
        {counts ? (
          <>
            <span className="text-card-foreground font-medium">{total}</span> rows live
          </>
        ) : (
          "Loading…"
        )}
      </div>

      {counts ? (
        <div className="flex flex-wrap gap-1 mb-4">
          {Object.entries(counts).map(([t, c]) => (
            <span
              key={t}
              className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-[11px]"
            >
              {t}: {c}
            </span>
          ))}
        </div>
      ) : null}

      <button
        onClick={onWipe}
        disabled={busy !== null || total === 0}
        className="inline-flex items-center gap-1.5 rounded-md bg-destructive text-destructive-foreground px-3 py-1.5 text-sm hover:bg-destructive/90 disabled:opacity-60"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {busy === "wipe" ? "Wiping…" : "Wipe all contacts"}
      </button>

      {message ? <p className="mt-3 text-xs text-muted-foreground">{message}</p> : null}
      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
    </section>
  );
};

export default WipeAllContacts;
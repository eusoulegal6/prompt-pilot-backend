import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const ManualDraftReply = () => {
  const [incomingMessage, setIncomingMessage] = useState("");
  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = incomingMessage.trim().length > 0 && instruction.trim().length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setDraft("");
    try {
      const { data, error: fnError } = await supabase.functions.invoke("draft-whatsapp-manual", {
        body: {
          incomingMessage: incomingMessage.trim().slice(0, 4000),
          instruction: instruction.trim().slice(0, 2000),
        },
      });
      if (fnError) throw new Error(fnError.message || "Request failed");
      const replyText = (data as { draft?: string } | null)?.draft?.trim() ?? "";
      if (!replyText) throw new Error("Empty draft returned");
      setDraft(replyText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const copyDraft = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
    } catch {
      /* noop */
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-6 space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-card-foreground">Draft a WhatsApp reply</h2>
        <p className="text-sm text-muted-foreground">
          Paste the incoming message and tell us how you want to reply. We'll draft it for you.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="incoming" className="text-sm font-medium text-card-foreground">
            Incoming message
          </label>
          <textarea
            id="incoming"
            value={incomingMessage}
            onChange={(e) => setIncomingMessage(e.target.value)}
            maxLength={4000}
            rows={4}
            className="w-full rounded-md border border-input bg-background p-2 text-sm text-foreground"
            placeholder="Paste the WhatsApp message you received…"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="instruction" className="text-sm font-medium text-card-foreground">
            How should we reply?
          </label>
          <textarea
            id="instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            maxLength={2000}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-2 text-sm text-foreground"
            placeholder="e.g. Politely confirm and propose Tuesday at 10am."
          />
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Drafting…" : "Draft reply"}
        </button>
      </form>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {draft && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-card-foreground">Suggested reply</span>
            <button
              type="button"
              onClick={copyDraft}
              className="text-xs px-2 py-1 rounded-md bg-secondary text-secondary-foreground hover:opacity-90"
            >
              Copy
            </button>
          </div>
          <div className="rounded-md border border-border bg-muted p-3 text-sm text-foreground whitespace-pre-wrap">
            {draft}
          </div>
        </div>
      )}
    </section>
  );
};

export default ManualDraftReply;
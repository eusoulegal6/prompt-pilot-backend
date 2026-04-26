import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { Copy, Loader2, Trash2 } from "lucide-react";

type ExtensionToken = {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
};

export default function ConnectExtension() {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [tokens, setTokens] = useState<ExtensionToken[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(true);

  const loadTokens = async () => {
    setLoadingTokens(true);
    const { data, error } = await supabase
      .from("extension_tokens")
      .select("id, label, created_at, last_used_at")
      .is("revoked_at", null)
      .order("created_at", { ascending: false });
    if (!error && data) setTokens(data as ExtensionToken[]);
    setLoadingTokens(false);
  };

  useEffect(() => {
    loadTokens();
  }, []);

  // Countdown
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        setCode(null);
        setExpiresAt(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const generateCode = async () => {
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("pair-create", { body: {} });
      if (error) throw error;
      if (data?.code) {
        setCode(data.code);
        setExpiresAt(new Date(data.expiresAt).getTime());
        toast({ title: "Pairing code ready", description: "Paste it into the extension within 10 minutes." });
      } else if (data?.error) {
        throw new Error(data.error);
      }
    } catch (err) {
      toast({
        title: "Failed to generate code",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  };

  const copyCode = async () => {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    toast({ title: "Copied", description: "Pairing code copied to clipboard." });
  };

  const revoke = async (id: string) => {
    const { error } = await supabase
      .from("extension_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      toast({ title: "Revoke failed", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Device revoked" });
    setTokens((prev) => prev.filter((t) => t.id !== id));
  };

  const fmtDate = (s: string | null) => {
    if (!s) return "Never";
    return new Date(s).toLocaleString();
  };

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Connect Extension</CardTitle>
          <CardDescription>
            Generate a one-time pairing code, then paste it into the Send Smart Chrome extension to authorize it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {code ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 p-6 flex items-center justify-between gap-4">
                <span className="font-mono text-3xl tracking-widest text-foreground select-all">{code}</span>
                <Button variant="outline" size="sm" onClick={copyCode}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Expires in{" "}
                <span className="font-medium text-foreground">
                  {mins}:{String(secs).padStart(2, "0")}
                </span>
                . Single use.
              </p>
              <Button variant="ghost" size="sm" onClick={generateCode} disabled={generating}>
                Generate a different code
              </Button>
            </div>
          ) : (
            <Button onClick={generateCode} disabled={generating}>
              {generating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Generate pairing code
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected devices</CardTitle>
          <CardDescription>Extensions currently authorized to draft replies on your behalf.</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingTokens ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading...
            </div>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">No devices connected yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {tokens.map((t) => (
                <li key={t.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{t.label ?? "Chrome Extension"}</p>
                    <p className="text-xs text-muted-foreground">
                      Connected {fmtDate(t.created_at)} · Last used {fmtDate(t.last_used_at)}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => revoke(t.id)}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

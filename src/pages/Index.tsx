import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { useAuthReady } from "@/hooks/useAuthReady";
import WhisperActivity from "@/components/WhisperActivity";
import MessageBatchesSection from "@/components/MessageBatchesSection";
import ContactsSection from "@/components/ContactsSection";
import ContactWipeRestore from "@/components/ContactWipeRestore";
import WipeAllContacts from "@/components/WipeAllContacts";

function LoginCard() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
  };

  const onGoogle = async () => {
    setBusy(true);
    setErr(null);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      setErr(result.error instanceof Error ? result.error.message : "Sign-in failed");
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-card-foreground">Admin sign in</h2>
        <p className="text-xs text-muted-foreground">This backend is restricted to admins.</p>
      </div>
      <form onSubmit={onEmail} className="space-y-3">
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <input
          type="password"
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        or
        <div className="h-px flex-1 bg-border" />
      </div>
      <button
        onClick={onGoogle}
        disabled={busy}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
      >
        Continue with Google
      </button>
      {err ? <p className="text-xs text-destructive">{err}</p> : null}
    </div>
  );
}

const Index = () => {
  const { user, isReady } = useAuthReady();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setIsAdmin(null);
      return;
    }
    supabase
      .rpc("is_app_admin", { _user_id: user.id })
      .then(({ data, error }) => {
        if (cancelled) return;
        setIsAdmin(!error && data === true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="text-left space-y-1">
            <h1 className="text-3xl font-bold text-foreground">WhatsReply</h1>
            <p className="text-muted-foreground text-sm">
              AI-powered chat reply drafting for Whatsapp.
            </p>
          </div>
          {user ? (
            <button
              onClick={signOut}
              className="px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground text-xs hover:opacity-90"
            >
              Sign out
            </button>
          ) : null}
        </div>

        {!isReady ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
          </div>
        ) : !user ? (
          <LoginCard />
        ) : isAdmin === null ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
          </div>
        ) : !isAdmin ? (
          <div className="rounded-lg border border-destructive/40 bg-card p-6 space-y-2">
            <h2 className="text-lg font-semibold text-card-foreground">Not authorized</h2>
            <p className="text-sm text-muted-foreground">
              {user.email} is signed in but is not an admin of this backend.
            </p>
          </div>
        ) : (
          <>
            <ContactsSection />
            <ContactWipeRestore />
            <MessageBatchesSection />
            <WhisperActivity />
            <WipeAllContacts />
          </>
        )}
      </div>
    </div>
  );
};

export default Index;

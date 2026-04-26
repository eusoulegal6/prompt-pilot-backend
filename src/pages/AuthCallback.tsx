import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

const AuthCallback = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;

    // If there are tokens in the hash, Supabase client picks them up via getSession
    supabase.auth.getSession().then(({ data: { session }, error: err }) => {
      // Clean the URL fragment
      if (hash) {
        window.history.replaceState(null, "", window.location.pathname);
      }

      if (err) {
        console.error("Auth callback error:", err.message);
        setError(err.message);
        return;
      }

      if (session) {
        navigate("/dashboard", { replace: true });
      } else {
        // No session yet — might still be processing; wait for auth state change
        const timeout = setTimeout(() => {
          // If still no session after 5s, redirect to login
          navigate("/", { replace: true });
        }, 5000);

        const {
          data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, newSession) => {
          clearTimeout(timeout);
          subscription.unsubscribe();
          if (newSession) {
            navigate("/dashboard", { replace: true });
          } else {
            navigate("/", { replace: true });
          }
        });

        return () => {
          clearTimeout(timeout);
          subscription.unsubscribe();
        };
      }
    });
  }, [navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center space-y-4 max-w-md px-4">
          <h1 className="text-xl font-semibold text-destructive">Authentication Error</h1>
          <p className="text-muted-foreground">{error}</p>
          <button
            onClick={() => window.location.assign("/")}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm"
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-2">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto" />
        <p className="text-muted-foreground text-sm">Completing sign-in…</p>
      </div>
    </div>
  );
};

export default AuthCallback;

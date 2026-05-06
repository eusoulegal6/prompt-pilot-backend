import { useEffect } from "react";
import { useAuthReady } from "@/hooks/useAuthReady";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import ConnectExtension from "@/components/ConnectExtension";
import WhisperActivity from "@/components/WhisperActivity";

const Dashboard = () => {
  const { user } = useAuthReady();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`thread-states-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "thread_states",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          // Notify any listeners (review-list / usage widgets) to refetch.
          window.dispatchEvent(
            new CustomEvent("thread-states:changed", { detail: payload })
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <button
            onClick={handleSignOut}
            className="px-4 py-2 rounded-md bg-secondary text-secondary-foreground text-sm hover:opacity-90"
          >
            Sign out
          </button>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">
          <p className="text-card-foreground">
            Welcome{user?.email ? `, ${user.email}` : ""}! You are signed in.
          </p>
        </div>
        <ConnectExtension />
        <WhisperActivity />
      </div>
    </div>
  );
};

export default Dashboard;

import { useAuthReady } from "@/hooks/useAuthReady";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import ConnectExtension from "@/components/ConnectExtension";

const Dashboard = () => {
  const { user } = useAuthReady();
  const navigate = useNavigate();

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
      </div>
    </div>
  );
};

export default Dashboard;

import { useAuthReady } from "@/hooks/useAuthReady";
import { Navigate } from "react-router-dom";

const Index = () => {
  const { user, isReady } = useAuthReady();

  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-md px-4">
        <h1 className="text-3xl font-bold text-foreground">Send Smart</h1>
        <p className="text-muted-foreground">
          AI-powered email reply drafting for Gmail. Sign up or log in to get started.
        </p>
        <p className="text-sm text-muted-foreground">
          Check your email for a confirmation link after signing up.
        </p>
      </div>
    </div>
  );
};

export default Index;

import { useAuthReady } from "@/hooks/useAuthReady";
import WhisperActivity from "@/components/WhisperActivity";
import MessageBatchesSection from "@/components/MessageBatchesSection";

const Index = () => {
  const { isReady } = useAuthReady();

  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-bold text-foreground">WhatsReply</h1>
          <p className="text-muted-foreground">
            AI-powered chat reply drafting for Whatsapp. Sign up or log in to get started.
          </p>
          <p className="text-sm text-muted-foreground">
            Check your email for a confirmation link after signing up.
          </p>
        </div>
        <MessageBatchesSection />
        <WhisperActivity />
      </div>
    </div>
  );
};

export default Index;

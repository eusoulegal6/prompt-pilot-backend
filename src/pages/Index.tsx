import WhisperActivity from "@/components/WhisperActivity";
import MessageBatchesSection from "@/components/MessageBatchesSection";
import ContactsSection from "@/components/ContactsSection";
import ContactWipeRestore from "@/components/ContactWipeRestore";
import WipeAllContacts from "@/components/WipeAllContacts";

const Index = () => {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-bold text-foreground">WhatsReply</h1>
          <p className="text-muted-foreground">
            AI-powered chat reply drafting for Whatsapp.
          </p>
        </div>
        <ContactsSection />
        <ContactWipeRestore />
        <MessageBatchesSection />
        <WhisperActivity />
        <WipeAllContacts />
      </div>
    </div>
  );
};

export default Index;

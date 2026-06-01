import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Calendar, RefreshCw } from "lucide-react";

type Appointment = {
  id: string;
  name: string;
  phone: string;
  service: string;
  date: string;
  time: string;
  booked_at: string;
  thread_id: string;
  created_at: string;
};

const APPOINTMENTS_URL =
  "https://ocpphyjkstvfespxrajk.supabase.co/functions/v1/appointments-list";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jcHBoeWprc3R2ZmVzcHhyYWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODExMzUsImV4cCI6MjA5Mjc1NzEzNX0.wcqrpSVkgDZRPet_4yLcF5YYISsWqRacVNOHf_eW8uY";

const AppointmentsList = () => {
  const [items, setItems] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      setError("Sign in to view appointments.");
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const res = await fetch(APPOINTMENTS_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: ANON_KEY,
        },
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "Failed to load appointments.");
      }
      setItems(json.appointments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold text-card-foreground">
            Upcoming appointments
          </h2>
        </div>
        <button
          onClick={load}
          disabled={refreshing}
          className="p-2 rounded-md hover:bg-muted disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No appointments yet.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((apt) => (
            <li
              key={apt.id}
              className="rounded-md border border-border bg-background p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-foreground">{apt.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {apt.service}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-foreground">
                    {apt.date}
                  </p>
                  <p className="text-sm text-muted-foreground">{apt.time}</p>
                </div>
              </div>
              {apt.phone && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {apt.phone}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default AppointmentsList;
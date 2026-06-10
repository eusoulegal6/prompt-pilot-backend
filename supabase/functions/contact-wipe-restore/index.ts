import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const THREAD_ID = "69295589584922@lid";
const TABLES = [
  "scan_messages",
  "chat_scans",
  "chat_snapshots",
  "thread_state_history",
  "thread_states",
  "sync_events",
  "appointments",
] as const;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SRK,
      Authorization: `Bearer ${SRK}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function selectAll(table: string) {
  const res = await rest(`${table}?thread_id=eq.${encodeURIComponent(THREAD_ID)}&select=*`);
  if (!res.ok) throw new Error(`select ${table}: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function deleteAll(table: string) {
  const res = await rest(`${table}?thread_id=eq.${encodeURIComponent(THREAD_ID)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  if (!res.ok && res.status !== 404) throw new Error(`delete ${table}: ${res.status} ${await res.text()}`);
}

async function insertRows(table: string, rows: unknown[]) {
  if (!rows.length) return;
  const res = await rest(table, {
    method: "POST",
    headers: { Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table}: ${res.status} ${await res.text()}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let action = "";
  try { action = (await req.json())?.action ?? ""; } catch { /* */ }

  try {
    if (action === "status") {
      const counts: Record<string, number> = {};
      for (const t of TABLES) {
        const r = await rest(`${t}?thread_id=eq.${encodeURIComponent(THREAD_ID)}&select=thread_id`, {
          headers: { Prefer: "count=exact", Range: "0-0" },
        });
        const cr = r.headers.get("content-range") ?? "*/0";
        counts[t] = parseInt(cr.split("/")[1] ?? "0", 10) || 0;
      }
      const b = await rest(`contact_backups?thread_id=eq.${encodeURIComponent(THREAD_ID)}&select=updated_at`);
      const backup = await b.json();
      return json({ ok: true, thread_id: THREAD_ID, counts, backup_at: backup?.[0]?.updated_at ?? null });
    }

    if (action === "wipe") {
      const data: Record<string, unknown[]> = {};
      for (const t of TABLES) data[t] = await selectAll(t);
      const total = Object.values(data).reduce((n, r) => n + r.length, 0);
      if (total > 0) {
        const up = await rest("contact_backups", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{ thread_id: THREAD_ID, data, updated_at: new Date().toISOString() }]),
        });
        if (!up.ok) throw new Error(`backup: ${up.status} ${await up.text()}`);
      }
      for (const t of TABLES) await deleteAll(t);
      return json({ ok: true, action: "wipe", backed_up: total });
    }

    if (action === "restore") {
      const b = await rest(`contact_backups?thread_id=eq.${encodeURIComponent(THREAD_ID)}&select=data`);
      const rows = await b.json();
      if (!rows?.[0]?.data) return json({ ok: false, error: "No backup available" }, 404);
      const data = rows[0].data as Record<string, unknown[]>;
      for (const t of TABLES) await deleteAll(t);
      let restored = 0;
      for (const t of [...TABLES].reverse()) {
        const r = data[t] ?? [];
        await insertRows(t, r);
        restored += r.length;
      }
      return json({ ok: true, action: "restore", restored });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
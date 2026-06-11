import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TABLES = [
  "scan_messages",
  "chat_scans",
  "chat_snapshots",
  "thread_state_history",
  "thread_states",
  "sync_events",
  "appointments",
  "reply_logs",
  "whisper_invocations",
  "contact_backups",
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
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SRK,
      Authorization: `Bearer ${SRK}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function countAll(table: string): Promise<number> {
  const r = await rest(`${table}?select=*`, {
    headers: { Prefer: "count=exact", Range: "0-0" },
  });
  const cr = r.headers.get("content-range") ?? "*/0";
  return parseInt(cr.split("/")[1] ?? "0", 10) || 0;
}

async function deleteAll(table: string) {
  // PostgREST requires a filter for DELETE; use a tautology on a likely-present column.
  // Fall back to a different filter if the table lacks `thread_id`.
  const tries = [
    `${table}?thread_id=not.is.null`,
    `${table}?id=not.is.null`,
    `${table}?created_at=not.is.null`,
  ];
  for (const q of tries) {
    const res = await rest(q, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    if (res.ok || res.status === 404) return;
    if (res.status !== 400) {
      throw new Error(`delete ${table}: ${res.status} ${await res.text()}`);
    }
  }
  throw new Error(`delete ${table}: no usable filter`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let action = "";
  let confirm = "";
  try {
    const body = await req.json();
    action = body?.action ?? "";
    confirm = body?.confirm ?? "";
  } catch { /* */ }

  try {
    if (action === "status") {
      const counts: Record<string, number> = {};
      for (const t of TABLES) counts[t] = await countAll(t);
      return json({ ok: true, counts });
    }

    if (action === "wipe") {
      if (confirm !== "WIPE ALL CONTACTS") {
        return json({ error: "Confirmation phrase required" }, 400);
      }
      const deleted: Record<string, number> = {};
      for (const t of TABLES) {
        deleted[t] = await countAll(t);
        await deleteAll(t);
      }
      const total = Object.values(deleted).reduce((n, c) => n + c, 0);
      return json({ ok: true, action: "wipe", deleted, total });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
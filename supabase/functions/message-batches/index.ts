import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const PARTNER_PROJECTS = [
  { ref: "uxhtrpwgfqknxqzhssoe", url: "https://uxhtrpwgfqknxqzhssoe.supabase.co" },
  { ref: "zzqdzubykkglytjdecqe", url: "https://zzqdzubykkglytjdecqe.supabase.co" },
  { ref: "ocpphyjkstvfespxrajk", url: "https://ocpphyjkstvfespxrajk.supabase.co" },
];

const partnerJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getPartnerJwks(url: string) {
  let jwks = partnerJwks.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
    partnerJwks.set(url, jwks);
  }
  return jwks;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extractSubFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

async function resolveUserId(req: Request, supabaseUrl: string, anonKey: string, serviceRoleKey: string): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  if (token.startsWith("ext_")) {
    const raw = token.slice(4);
    if (!raw) return null;
    const tokenHash = await sha256Hex(raw);
    const url = `${supabaseUrl}/rest/v1/extension_tokens?token_hash=eq.${tokenHash}&revoked_at=is.null&select=user_id`;
    const res = await fetch(url, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows[0]?.user_id ? rows[0].user_id : null;
  }
  const localClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: localUser } = await localClient.auth.getUser(token);
  if (localUser?.user?.id) return localUser.user.id;
  for (const p of PARTNER_PROJECTS) {
    try {
      const { payload } = await jwtVerify(token, getPartnerJwks(p.url), { issuer: `${p.url}/auth/v1` });
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      if (!sub) continue;
      const admin = createClient(supabaseUrl, serviceRoleKey);
      const bridgeEmail = `partner+${p.ref}+${sub}@bridge.sendsmart.local`;
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = list?.users?.find((u: { email?: string | null }) => u.email === bridgeEmail);
      if (found?.id) return found.id;
    } catch (_) { /* try next */ }
  }
  return extractSubFromJwt(token);
}

async function restGet(url: string, key: string) {
  const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`message-batches GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return [];
  }
  return await res.json();
}

async function restDelete(url: string, key: string): Promise<boolean> {
  const res = await fetch(url, { method: "DELETE", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" } });
  if (!res.ok) console.error(`message-batches DELETE ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.ok;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Server configuration error." }, 500);
  }

  const userId = await resolveUserId(req, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === "POST") {
    let action = "";
    try {
      const body = await req.json();
      action = typeof body?.action === "string" ? body.action : "";
    } catch { /* empty body */ }
    if (action !== "clear") return jsonResponse({ error: "Unknown action" }, 400);

    const userFilter = userId ? `?user_id=eq.${userId}` : "";
    const tables = ["scan_messages", "chat_snapshots", "chat_scans", "thread_state_history", "thread_states", "sync_events"];
    const results: Record<string, boolean> = {};
    for (const t of tables) {
      results[t] = await restDelete(`${SUPABASE_URL}/rest/v1/${t}${userFilter}`, SUPABASE_SERVICE_ROLE_KEY);
    }
    return jsonResponse({ ok: true, cleared: results });
  }

  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "batches";
  let limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  if (limit > 50) limit = 50;

  const userFilter = userId ? `&user_id=eq.${userId}` : "";

  if (view === "contacts") {
    const threadsUrl = `${SUPABASE_URL}/rest/v1/thread_states?select=thread_id,sender,subject,provider${userFilter}&limit=2000`;
    const messagesUrl = `${SUPABASE_URL}/rest/v1/scan_messages?select=id,thread_id,sender_id,sender,from_me,msg_timestamp,body,normalized_body,raw_body,msg_type,ack,has_reaction,is_forwarded,has_media,caption,mime_type,transcription,created_at${userFilter}&order=msg_timestamp.asc&limit=5000`;
    const [threads, contactMessages] = await Promise.all([
      restGet(threadsUrl, SUPABASE_SERVICE_ROLE_KEY),
      restGet(messagesUrl, SUPABASE_SERVICE_ROLE_KEY),
    ]);
    return jsonResponse({ ok: true, threads: threads ?? [], messages: contactMessages ?? [] });
  }

  const eventsUrl = `${SUPABASE_URL}/rest/v1/sync_events?select=event_id,event_type,provider,thread_id,scan_id,schema_version,payload_sha256,stored_message_count,received_at${userFilter}&order=received_at.desc&limit=${limit}`;
  const events = await restGet(eventsUrl, SUPABASE_SERVICE_ROLE_KEY);
  const eventIds = Array.isArray(events) ? events.map((e: { event_id: string }) => e.event_id).filter(Boolean) : [];

  let messages: unknown[] = [];
  if (eventIds.length > 0) {
    const inList = eventIds.map((id: string) => `"${id.replace(/"/g, '\\"')}"`).join(",");
    const msgUrl = `${SUPABASE_URL}/rest/v1/scan_messages?event_id=in.(${encodeURIComponent(inList)})${userFilter}&select=event_id,thread_id,message_id,ordinal,source_model_index,sender_id,from_me,msg_timestamp,raw_body,normalized_body,degraded&order=msg_timestamp.asc&limit=2000`;
    messages = await restGet(msgUrl, SUPABASE_SERVICE_ROLE_KEY);
  }

  return jsonResponse({ ok: true, events: events ?? [], messages: messages ?? [] });
});
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function extractUserIdFromJwt(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveUserId(
  req: Request,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];

  if (token.startsWith("ext_")) {
    const raw = token.slice(4);
    if (!raw) return null;
    const tokenHash = await sha256Hex(raw);
    const url = `${supabaseUrl}/rest/v1/extension_tokens?token_hash=eq.${tokenHash}&revoked_at=is.null&select=id,user_id`;
    const res = await fetch(url, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    fetch(`${supabaseUrl}/rest/v1/extension_tokens?id=eq.${rows[0].id}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    }).catch(() => {});
    return typeof rows[0].user_id === "string" ? rows[0].user_id : null;
  }

  return extractUserIdFromJwt(token);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "server_misconfigured" }, 500);

  const userId = await resolveUserId(req, supabaseUrl, serviceRoleKey);
  if (!userId) return jsonResponse({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const provider = (url.searchParams.get("provider") || "whatsapp").slice(0, 32);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 100);

  const q = new URLSearchParams({
    select:
      "thread_id,provider,draft_id,draft_preview,last_draft_at,last_auto_sent_message_key,subject,sender,thread_url",
    user_id: `eq.${userId}`,
    provider: `eq.${provider}`,
    auto_send: "eq.true",
    status_value: "eq.draft_ready",
    order: "last_draft_at.asc",
    limit: String(limit),
  });

  const res = await fetch(`${supabaseUrl}/rest/v1/thread_states?${q.toString()}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return jsonResponse({ error: "db_error", detail: text }, 502);
  }
  const rows = await res.json();
  const pending = (Array.isArray(rows) ? rows : []).filter(
    (r) => typeof r?.draft_id === "string" && r.draft_id && r.draft_id !== r.last_auto_sent_message_key,
  );
  return jsonResponse({ pending });
});

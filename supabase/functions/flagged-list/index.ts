import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function extractUserIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function resolveUserId(req: Request, supabaseUrl: string, serviceRoleKey: string): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  if (token.startsWith("ext_")) {
    const raw = token.slice(4);
    if (!raw) return null;
    try {
      const tokenHash = await sha256Hex(raw);
      const url = `${supabaseUrl}/rest/v1/extension_tokens?token_hash=eq.${tokenHash}&revoked_at=is.null&select=user_id`;
      const res = await fetch(url, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } });
      if (!res.ok) return null;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return rows[0].user_id ?? null;
    } catch {
      return null;
    }
  }
  return extractUserIdFromJwt(token);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("health") === "1") {
    return jsonResponse({ ok: true, function: "flagged-list" });
  }
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Server configuration error." }, 500);
  }

  const userId = await resolveUserId(req, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  let limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;

  const minAgeMinutes = parseInt(url.searchParams.get("min_age_minutes") ?? "0", 10);
  const cutoffIso = Number.isFinite(minAgeMinutes) && minAgeMinutes > 0
    ? new Date(Date.now() - minAgeMinutes * 60_000).toISOString()
    : "";

  const select = [
    "thread_id",
    "provider",
    "sender",
    "subject",
    "preview",
    "latest_message",
    "intent_category",
    "intent_confidence",
    "intent_reason",
    "intent_source",
    "intent_classified_at",
    "updated_at",
    "thread_url",
  ].join(",");

  // Filter: intent_category = 'misc' OR (intent_category = 'support' AND intent_confidence < 0.6)
  const orFilter = "or=(intent_category.eq.misc,and(intent_category.eq.support,intent_confidence.lt.0.6))";

  const params = new URLSearchParams();
  params.set("user_id", `eq.${userId}`);
  params.set("select", select);
  params.set("order", "updated_at.desc");
  params.set("limit", String(limit));
  if (cutoffIso) params.set("updated_at", `lte.${cutoffIso}`);

  const restUrl = `${SUPABASE_URL}/rest/v1/thread_states?${params.toString()}&${orFilter}`;

  try {
    const res = await fetch(restUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      console.error(`flagged-list rest ${res.status}: ${errText}`);
      return jsonResponse({ error: "Query failed" }, 502);
    }
    const items = await res.json();
    return jsonResponse({ ok: true, items: Array.isArray(items) ? items : [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`flagged-list ERROR user=${userId}: ${msg}`);
    return jsonResponse({ error: "Server error" }, 500);
  }
});
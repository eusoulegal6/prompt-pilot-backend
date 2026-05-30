import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
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
    return typeof rows[0].user_id === "string" ? rows[0].user_id : null;
  }

  return extractUserIdFromJwt(token);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "server_misconfigured" }, 500);

  const userId = await resolveUserId(req, supabaseUrl, serviceRoleKey);
  if (!userId) return jsonResponse({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const threadId = str(body.thread_id) || str(body.threadId);
  const provider = (str(body.provider) || "whatsapp").slice(0, 32);
  const draftId = str(body.draft_id) || str(body.draftId);
  const status = (str(body.status) || "sent").toLowerCase();
  const errorText = str(body.error).slice(0, 1000);

  if (!threadId) return jsonResponse({ error: "thread_id_required" }, 400);
  if (!draftId) return jsonResponse({ error: "draft_id_required" }, 400);
  if (!["sent", "error"].includes(status)) return jsonResponse({ error: "invalid_status" }, 400);

  // Only update if this row still matches the draft_id (avoid clobbering a newer draft).
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    provider: `eq.${provider}`,
    thread_id: `eq.${threadId}`,
    draft_id: `eq.${draftId}`,
  });

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> =
    status === "sent"
      ? {
          status_value: "sent",
          auto_send: false,
          last_auto_sent_at: nowIso,
          last_sent_at: nowIso,
          last_auto_sent_message_key: draftId,
          last_error: "",
        }
      : {
          status_value: "error",
          auto_send: false,
          last_error: errorText || "extension_send_failed",
        };

  const res = await fetch(`${supabaseUrl}/rest/v1/thread_states?${params.toString()}`, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return jsonResponse({ error: "db_error", detail: text }, 502);
  }
  const rows = await res.json();
  const updated = Array.isArray(rows) ? rows.length : 0;
  if (updated === 0) return jsonResponse({ error: "draft_not_found_or_superseded" }, 409);
  return jsonResponse({ updated, status });
});

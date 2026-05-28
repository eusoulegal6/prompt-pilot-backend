import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

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

const PARTNER_PROJECTS: Array<{ ref: string; url: string }> = [
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

async function tryPartnerVerify(token: string): Promise<{ partnerRef: string; sub: string } | null> {
  for (const partner of PARTNER_PROJECTS) {
    try {
      const { payload } = await jwtVerify(token, getPartnerJwks(partner.url), {
        issuer: `${partner.url}/auth/v1`,
      });
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      if (sub) return { partnerRef: partner.ref, sub };
    } catch (_) {
      // Try next trusted project.
    }
  }
  return null;
}

async function resolvePartnerUserId(admin: ReturnType<typeof createClient>, partnerRef: string, sub: string): Promise<string | null> {
  const bridgeEmail = `partner+${partnerRef}+${sub}@bridge.sendsmart.local`;
  const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) {
    console.error("flagged-list partner listUsers error:", error.message);
    return null;
  }
  const found = list?.users?.find((u: { email?: string | null }) => u.email === bridgeEmail);
  return found?.id ?? null;
}

async function resolveUserId(req: Request, supabaseUrl: string, anonKey: string, serviceRoleKey: string): Promise<string | null> {
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

  const localClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: localUser } = await localClient.auth.getUser(token);
  if (localUser?.user?.id) return localUser.user.id;

  const partner = await tryPartnerVerify(token);
  if (!partner) return extractUserIdFromJwt(token);
  const admin = createClient(supabaseUrl, serviceRoleKey);
  return await resolvePartnerUserId(admin, partner.partnerRef, partner.sub);
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
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Server configuration error." }, 500);
  }

  const userId = await resolveUserId(req, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY);
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
    "intent_subcategory",
    "intent_confidence",
    "intent_reason",
    "intent_source",
    "intent_classified_at",
    "customer_goal",
    "business_action",
    "needs_human_review",
    "intent_review_reason",
    "intent_urgency",
    "updated_at",
    "thread_url",
  ].join(",");

  // Surface anything the classifier flagged for human review, plus a safety net:
  // - high-risk subcategories (complaint, refund, human-agent, unclear)
  // - low-confidence classifications (< 0.55)
  // - legacy rows without the new flag: misc, or support with confidence < 0.6
  const orFilter =
    "or=(" +
    [
      "needs_human_review.eq.true",
      "intent_subcategory.in.(complaint,refund_or_return,human_agent_request,unclear)",
      "intent_confidence.lt.0.55",
      "intent_category.eq.misc",
      "and(intent_category.eq.support,intent_confidence.lt.0.6)",
    ].join(",") +
    ")";

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
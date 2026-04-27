import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { jwtVerify, createRemoteJWKSet } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const LIMIT = 100;

const PARTNER_PROJECTS: Array<{ ref: string; url: string }> = [
  { ref: "uxhtrpwgfqknxqzhssoe", url: "https://uxhtrpwgfqknxqzhssoe.supabase.co" },
  { ref: "zzqdzubykkglytjdecqe", url: "https://zzqdzubykkglytjdecqe.supabase.co" },
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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function tryPartnerVerify(token: string): Promise<{ partnerRef: string; sub: string } | null> {
  for (const partner of PARTNER_PROJECTS) {
    try {
      const { payload } = await jwtVerify(token, getPartnerJwks(partner.url), {
        issuer: `${partner.url}/auth/v1`,
      });
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      if (!sub) continue;
      return { partnerRef: partner.ref, sub };
    } catch (_) {
      // try next
    }
  }
  return null;
}

// deno-lint-ignore no-explicit-any
async function resolvePartnerUserId(admin: any, partnerRef: string, sub: string): Promise<string | null> {
  const bridgeEmail = `partner+${partnerRef}+${sub}@bridge.sendsmart.local`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: bridgeEmail,
    email_confirm: true,
    user_metadata: { partner_ref: partnerRef, partner_sub: sub, bridge: true },
  });
  if (created?.user?.id) return created.user.id;
  const msg = String(createErr?.message ?? "").toLowerCase();
  if (createErr && !msg.includes("already") && !msg.includes("registered") && !msg.includes("exists")) {
    console.error("thread-states-list partner createUser error:", createErr.message);
    return null;
  }
  // deno-lint-ignore no-explicit-any
  const { data: list, error: listErr } = await (admin.auth.admin as any).listUsers({ page: 1, perPage: 200 });
  if (listErr) {
    console.error("thread-states-list listUsers error:", listErr.message);
    return null;
  }
  const found = list?.users?.find((u: { email?: string | null }) => u.email === bridgeEmail);
  return found?.id ?? null;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// deno-lint-ignore no-explicit-any
async function resolveExtTokenUserId(admin: any, raw: string): Promise<string | null> {
  if (!raw) return null;
  try {
    const tokenHash = await sha256Hex(raw);
    const { data, error } = await admin
      .from("extension_tokens")
      .select("id,user_id")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .maybeSingle();
    if (error || !data) return null;
    admin.from("extension_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
    return data.user_id ?? null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Authentication required." }, 401);
  }
  const token = authHeader.replace("Bearer ", "");
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let userId: string | null = null;

  // 1) Extension pair token
  if (token.startsWith("ext_")) {
    userId = await resolveExtTokenUserId(admin, token.slice(4));
  }

  // 2) Local Send Smart auth (this project's JWT)
  if (!userId) {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser(token);
    if (userData?.user?.id) userId = userData.user.id;
  }

  // 3) Trusted partner JWT bridge
  if (!userId) {
    const partner = await tryPartnerVerify(token);
    if (partner) {
      userId = await resolvePartnerUserId(admin, partner.partnerRef, partner.sub);
    }
  }

  if (!userId) {
    return jsonResponse({ error: "Invalid session." }, 401);
  }

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const reviewOnly = url.searchParams.get("review") === "1";
  const sinceParam = url.searchParams.get("since");

  let q = admin
    .from("thread_states")
    .select(
      "id,provider,thread_id,subject,sender,latest_message,preview,unread,thread_url,source_url,queued_at,status_value,backend_decision,review_reason,review_summary,draft_preview,last_error,last_draft_at,last_sent_at,last_opened_at,last_auto_sent_at,review_active,review_resolved_at,extension_version,source,queue_scope,last_event_type,last_event_at,created_at,updated_at",
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(LIMIT);

  if (provider) q = q.eq("provider", provider);
  if (reviewOnly) q = q.eq("review_active", true);
  if (sinceParam) {
    const d = new Date(sinceParam);
    if (!Number.isNaN(d.getTime())) q = q.gt("updated_at", d.toISOString());
  }

  const { data, error } = await q;
  if (error) {
    console.error("thread-states-list query error:", error.message);
    return jsonResponse({ error: "Failed to read thread states." }, 500);
  }

  return jsonResponse({ items: data ?? [] });
});
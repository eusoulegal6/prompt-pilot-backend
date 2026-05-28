import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { jwtVerify, createRemoteJWKSet } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const FLAGGED_STATUSES = ["needs_review", "review_ready", "flagged", "review"];

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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

type AdminClient = ReturnType<typeof createClient>;

async function tryPartnerVerify(token: string): Promise<
  { partnerRef: string; sub: string } | null
> {
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

async function resolvePartnerUserId(
  admin: any,
  partnerRef: string,
  sub: string,
): Promise<string | null> {
  const bridgeEmail = `partner+${partnerRef}+${sub}@bridge.sendsmart.local`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: bridgeEmail,
    email_confirm: true,
    user_metadata: { partner_ref: partnerRef, partner_sub: sub, bridge: true },
  });
  if (created?.user?.id) return created.user.id;

  const msg = String(createErr?.message ?? "").toLowerCase();
  if (createErr && !msg.includes("already") && !msg.includes("registered") && !msg.includes("exists")) {
    console.error("review-resolve partner createUser error:", createErr.message);
    return null;
  }

  // deno-lint-ignore no-explicit-any
  const { data: list, error: listErr } = await (admin.auth.admin as any).listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) {
    console.error("review-resolve partner listUsers error:", listErr.message);
    return null;
  }
  const found = list?.users?.find((u: { email?: string | null }) => u.email === bridgeEmail);
  return found?.id ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Authentication required." }, 401);
  }
  const token = authHeader.replace("Bearer ", "");

  let body: { id?: unknown; thread_id?: unknown; provider?: unknown; resolution?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const rawId = typeof body.id === "string" ? body.id.trim() : "";
  let threadId = typeof body.thread_id === "string" ? body.thread_id.trim() : "";
  let provider = typeof body.provider === "string" ? body.provider.trim() : "";
  // id may be "<provider>:<thread_id>"; parse it as a fallback.
  if ((!threadId || !provider) && rawId.includes(":")) {
    const idx = rawId.indexOf(":");
    const p = rawId.slice(0, idx);
    const t = rawId.slice(idx + 1);
    if (!provider && p) provider = p;
    if (!threadId && t) threadId = t;
  }
  if (!threadId) {
    return jsonResponse({ ok: false, error: "Missing 'thread_id'." }, 400);
  }
  if (!provider) provider = "gmail";

  const resolutionRaw = typeof body.resolution === "string" ? body.resolution.trim() : "";
  const resolution = resolutionRaw === "dismissed" ? "dismissed" : "handled";
  const newStatus = resolution === "dismissed" ? "dismissed" : "resolved";

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1) Local Send Smart auth
  let userId: string | null = null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await userClient.auth.getUser(token);
  if (userData?.user?.id) {
    userId = userData.user.id;
  }

  // 2) Trusted partner JWT bridge
  if (!userId) {
    const partner = await tryPartnerVerify(token);
    if (partner) {
      userId = await resolvePartnerUserId(admin, partner.partnerRef, partner.sub);
      if (!userId) {
        return jsonResponse({ ok: false, error: "Failed to resolve partner user." }, 500);
      }
    }
  }

  if (!userId) {
    return jsonResponse({ ok: false, error: "Invalid session." }, 401);
  }

  const { data, error } = await admin
    .from("thread_states")
    .update({
      status_value: newStatus,
      review_active: false,
      review_resolved_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .eq("provider", provider)
    .in("status_value", FLAGGED_STATUSES)
    .select("id, thread_id, provider, status_value")
    .maybeSingle();

  if (error) {
    console.error("review-resolve update error:", error.message);
    return jsonResponse({ ok: false, error: "Failed to resolve review item." }, 500);
  }

  if (!data) {
    return jsonResponse({ ok: false, error: "Review item not found." }, 404);
  }

  return jsonResponse({
    ok: true,
    id: `${data.provider}:${data.thread_id}`,
    thread_id: data.thread_id,
    provider: data.provider,
    status_value: data.status_value,
    resolution,
  });
});

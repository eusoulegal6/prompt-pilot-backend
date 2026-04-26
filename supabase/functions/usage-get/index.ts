import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { jwtVerify, createRemoteJWKSet } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

// Keep these in sync with draft-gmail-reply
const QUOTA = {
  emails: 500,
  inputTokens: 2_000_000,
  outputTokens: 500_000,
};

const RECENT_LIMIT = 20;

const PARTNER_PROJECTS: Array<{ ref: string; url: string }> = [
  { ref: "uxhtrpwgfqknxqzhssoe", url: "https://uxhtrpwgfqknxqzhssoe.supabase.co" }, // Smart Reply Hub
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

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
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
  admin: AdminClient,
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
    console.error("usage-get partner createUser error:", createErr.message);
    return null;
  }

  // deno-lint-ignore no-explicit-any
  const { data: list, error: listErr } = await (admin.auth.admin as any).listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) {
    console.error("usage-get partner listUsers error:", listErr.message);
    return null;
  }
  const found = list?.users?.find((u: { email?: string | null }) => u.email === bridgeEmail);
  return found?.id ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "POST") {
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
        return jsonResponse({ error: "Failed to resolve partner user." }, 500);
      }
    }
  }

  if (!userId) {
    return jsonResponse({ error: "Invalid session." }, 401);
  }

  const period = currentPeriod();

  // Fetch usage counters + recent reply logs in parallel
  const [counterRes, logsRes] = await Promise.all([
    admin
      .from("usage_counters")
      .select("emails_used,input_tokens_used,output_tokens_used")
      .eq("user_id", userId)
      .eq("period", period)
      .maybeSingle(),
    admin
      .from("reply_logs")
      .select("created_at,subject,sender_email,decision")
      .eq("user_id", userId)
      .eq("period", period)
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT),
  ]);

  if (counterRes.error) {
    console.error("usage-get counter error:", counterRes.error.message);
    return jsonResponse({ error: "Failed to read usage." }, 500);
  }
  if (logsRes.error) {
    console.error("usage-get logs error:", logsRes.error.message);
    return jsonResponse({ error: "Failed to read reply logs." }, 500);
  }

  const c = counterRes.data ?? { emails_used: 0, input_tokens_used: 0, output_tokens_used: 0 };

  return jsonResponse({
    period,
    quota: {
      emails: QUOTA.emails,
      inputTokens: QUOTA.inputTokens,
      outputTokens: QUOTA.outputTokens,
    },
    used: {
      emails: Number(c.emails_used ?? 0),
      inputTokens: Number(c.input_tokens_used ?? 0),
      outputTokens: Number(c.output_tokens_used ?? 0),
    },
    recent: (logsRes.data ?? []).map((r) => ({
      createdAt: r.created_at,
      subject: r.subject,
      senderEmail: r.sender_email,
      decision: r.decision,
    })),
  });
});

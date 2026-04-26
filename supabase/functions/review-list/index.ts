import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { jwtVerify, createRemoteJWKSet } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const LIMIT = 50;
const SNIPPET_MAX = 200;

const PARTNER_PROJECTS: Array<{ ref: string; url: string }> = [
  { ref: "uxhtrpwgfqknxqzhssoe", url: "https://uxhtrpwgfqknxqzhssoe.supabase.co" },
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
    console.error("review-list partner createUser error:", createErr.message);
    return null;
  }

  // deno-lint-ignore no-explicit-any
  const { data: list, error: listErr } = await (admin.auth.admin as any).listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) {
    console.error("review-list partner listUsers error:", listErr.message);
    return null;
  }
  const found = list?.users?.find((u: { email?: string | null }) => u.email === bridgeEmail);
  return found?.id ?? null;
}

function parseSenderName(sender: string | null): string | null {
  if (!sender) return null;
  // Try "Name <email@x>" form
  const m = sender.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (m && m[1].trim()) return m[1].trim();
  return null;
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

  // Flagged-for-review = decisions other than a final 'reply' / 'sent' / 'dismissed'.
  // We treat 'review' and 'needs_review' as the flagged states; tolerant to either.
  const FLAGGED_DECISIONS = ["review", "needs_review", "flagged"];

  const { data, error } = await admin
    .from("reply_logs")
    .select("id,created_at,subject,sender_email,source_url,decision")
    .eq("user_id", userId)
    .in("decision", FLAGGED_DECISIONS)
    .order("created_at", { ascending: true })
    .limit(LIMIT);

  if (error) {
    console.error("review-list query error:", error.message);
    return jsonResponse({ error: "Failed to read review list." }, 500);
  }

  const items = (data ?? []).map((r) => {
    const senderName = parseSenderName(r.sender_email);
    // We don't store body content (privacy policy), so snippet stays null-safe.
    const snippet = r.subject
      ? String(r.subject).slice(0, SNIPPET_MAX)
      : "";
    return {
      id: r.id,
      createdAt: r.created_at,
      senderEmail: r.sender_email,
      senderName,
      subject: r.subject,
      snippet,
      reason: r.decision && r.decision !== "review" ? r.decision : null,
    };
  });

  return jsonResponse({ items });
});

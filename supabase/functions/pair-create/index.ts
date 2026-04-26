import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { jwtVerify, createRemoteJWKSet } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ACTIVE_CODES = 5;

// Trusted partner Supabase projects whose JWTs we accept.
// Users from these projects get an auto-provisioned Send Smart user on first use.
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

function generateCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

type AdminClient = ReturnType<typeof createClient>;

/**
 * Try to verify the JWT against any trusted partner project.
 * Returns { partnerRef, sub, email } on success, or null.
 */
async function tryPartnerVerify(token: string): Promise<
  { partnerRef: string; sub: string; email: string | null } | null
> {
  for (const partner of PARTNER_PROJECTS) {
    try {
      const { payload } = await jwtVerify(token, getPartnerJwks(partner.url), {
        issuer: `${partner.url}/auth/v1`,
      });
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      if (!sub) continue;
      const email = typeof payload.email === "string" ? payload.email : null;
      return { partnerRef: partner.ref, sub, email };
    } catch (_) {
      // Try next partner / fall through
    }
  }
  return null;
}

/**
 * Map a partner user to a deterministic Send Smart user, creating it if needed.
 * We key by email "partner+<ref>+<sub>@bridge.sendsmart.local" so the mapping
 * is stable and unique per partner user, even if their real email changes.
 */
async function resolvePartnerUserId(
  admin: AdminClient,
  partnerRef: string,
  sub: string,
): Promise<string | null> {
  const bridgeEmail = `partner+${partnerRef}+${sub}@bridge.sendsmart.local`;

  // Try to create. If it already exists, list & find.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: bridgeEmail,
    email_confirm: true,
    user_metadata: { partner_ref: partnerRef, partner_sub: sub, bridge: true },
  });
  if (created?.user?.id) return created.user.id;

  // If user already exists, look it up by email via listUsers (paged).
  const msg = String(createErr?.message ?? "").toLowerCase();
  if (createErr && !msg.includes("already") && !msg.includes("registered") && !msg.includes("exists")) {
    console.error("pair-create partner createUser error:", createErr.message);
    return null;
  }

  // Search for existing bridge user
  // listUsers supports email filter via query param in newer SDKs; fall back to scanning first page.
  // deno-lint-ignore no-explicit-any
  const { data: list, error: listErr } = await (admin.auth.admin as any).listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) {
    console.error("pair-create partner listUsers error:", listErr.message);
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

  // 1) Try local Send Smart auth
  let userId: string | null = null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await userClient.auth.getUser(token);
  if (userData?.user?.id) {
    userId = userData.user.id;
  }

  // 2) Fall back to trusted partner JWT (e.g. Smart Reply Hub)
  if (!userId) {
    const partner = await tryPartnerVerify(token);
    if (partner) {
      userId = await resolvePartnerUserId(admin, partner.partnerRef, partner.sub);
      if (!userId) {
        return jsonResponse({ error: "Failed to provision partner user." }, 500);
      }
    }
  }

  if (!userId) {
    return jsonResponse({ error: "Invalid session." }, 401);
  }

  // Rate limit: max N active (unconsumed, unexpired) codes per user
  const nowIso = new Date().toISOString();
  const { count } = await admin
    .from("extension_pair_codes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("consumed_at", null)
    .gt("expires_at", nowIso);

  if ((count ?? 0) >= MAX_ACTIVE_CODES) {
    return jsonResponse({ error: "Too many active pairing codes. Wait a few minutes and try again." }, 429);
  }

  // Generate code with collision retry
  let code = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    const { error } = await admin.from("extension_pair_codes").insert({
      code: candidate,
      user_id: userId,
      expires_at: expiresAt,
    });
    if (!error) {
      code = candidate;
      return jsonResponse({ code, expiresAt });
    }
    if (!String(error.message).includes("duplicate")) {
      console.error("pair-create insert error:", error.message);
      return jsonResponse({ error: "Failed to create pairing code." }, 500);
    }
  }
  return jsonResponse({ error: "Failed to create unique pairing code." }, 500);
});

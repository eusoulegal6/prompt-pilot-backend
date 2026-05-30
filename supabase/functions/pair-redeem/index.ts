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

// Trusted partner Supabase projects whose JWTs we accept (kept in sync with pair-create).
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
    } catch (_) { /* try next */ }
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
    console.error("pair-redeem partner createUser error:", createErr.message);
    return null;
  }
  const { data: list, error: listErr } = await (admin.auth.admin as any).listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) {
    console.error("pair-redeem partner listUsers error:", listErr.message);
    return null;
  }
  const found = list?.users?.find((u: { email?: string | null }) => u.email === bridgeEmail);
  return found?.id ?? null;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

  // Require an authenticated dashboard session so the extension token is bound
  // to the user actually signed in to the dashboard, not whoever originally
  // created the pairing code row.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Authentication required." }, 401);
  }
  const token = authHeader.replace("Bearer ", "");

  let body: { code?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const rawCode = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) : "Chrome Extension";
  if (!rawCode) {
    return jsonResponse({ error: "Pairing code is required." }, 400);
  }
  // Normalize: accept with or without dash
  const normalized = rawCode.replace(/[^A-Z0-9]/g, "");
  if (normalized.length !== 8) {
    return jsonResponse({ error: "Invalid pairing code format." }, 400);
  }
  const codeWithDash = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve the dashboard user (local Send Smart auth, then trusted partners).
  let dashboardUserId: string | null = null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await userClient.auth.getUser(token);
  if (userData?.user?.id) {
    dashboardUserId = userData.user.id;
  }
  if (!dashboardUserId) {
    const partner = await tryPartnerVerify(token);
    if (partner) {
      dashboardUserId = await resolvePartnerUserId(admin, partner.partnerRef, partner.sub);
    }
  }
  if (!dashboardUserId) {
    return jsonResponse({ error: "Invalid session." }, 401);
  }

  const { data: codeRow, error: lookupErr } = await admin
    .from("extension_pair_codes")
    .select("id, user_id, expires_at, consumed_at")
    .eq("code", codeWithDash)
    .maybeSingle();

  if (lookupErr) {
    console.error("pair-redeem lookup error:", lookupErr.message);
    return jsonResponse({ error: "Failed to validate code." }, 500);
  }
  if (!codeRow) {
    return jsonResponse({ error: "Invalid or expired pairing code." }, 400);
  }
  if (codeRow.consumed_at) {
    return jsonResponse({ error: "This pairing code has already been used." }, 400);
  }
  if (new Date(codeRow.expires_at).getTime() < Date.now()) {
    return jsonResponse({ error: "This pairing code has expired." }, 400);
  }

  // The code must belong to the same dashboard user that's redeeming it.
  if (codeRow.user_id !== dashboardUserId) {
    return jsonResponse({ error: "Pairing code does not belong to this account." }, 403);
  }

  // Mint token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const rawToken = bytesToBase64Url(tokenBytes);
  const tokenHash = await sha256Hex(rawToken);

  const { error: tokenErr } = await admin.from("extension_tokens").insert({
    user_id: dashboardUserId,
    token_hash: tokenHash,
    label,
  });
  if (tokenErr) {
    console.error("pair-redeem token insert error:", tokenErr.message);
    return jsonResponse({ error: "Failed to create extension token." }, 500);
  }

  // Mark code consumed
  const { error: consumeErr } = await admin
    .from("extension_pair_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", codeRow.id)
    .is("consumed_at", null);
  if (consumeErr) {
    console.warn("pair-redeem consume warning:", consumeErr.message);
  }

  // Fetch user email for friendly display
  let userEmail: string | null = null;
  try {
    const { data: u } = await admin.auth.admin.getUserById(dashboardUserId);
    userEmail = u?.user?.email ?? null;
  } catch (e) {
    console.warn("pair-redeem getUserById warning:", (e as Error).message);
  }

  const fullToken = `ext_${rawToken}`;
  return jsonResponse({
    // Canonical fields (used by Chrome extension)
    token: fullToken,
    userId: dashboardUserId,
    userEmail,
    // Back-compat alias
    extensionToken: fullToken,
  });
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { jwtVerify, createRemoteJWKSet } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

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
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getDashboardJwks(jwksUrl: string) {
  if (!cachedJwks) cachedJwks = createRemoteJWKSet(new URL(jwksUrl));
  return cachedJwks;
}

function deriveIssuer(jwksUrl: string): string {
  // jwksUrl looks like https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
  // issuer is https://<ref>.supabase.co/auth/v1
  return jwksUrl.replace(/\/\.well-known\/jwks\.json$/, "");
}

// Resolve / create a local user_id for a dashboard partner JWT (sub).
// Mirrors the bridge used in review-list / thread-states-list.
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
    console.error("dashboard-token-get partner createUser error:", createErr.message);
    return null;
  }
  // deno-lint-ignore no-explicit-any
  const { data: list, error: listErr } = await (admin.auth.admin as any).listUsers({ page: 1, perPage: 200 });
  if (listErr) {
    console.error("dashboard-token-get listUsers error:", listErr.message);
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
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const DASHBOARD_JWKS_URL = Deno.env.get("DASHBOARD_JWKS_URL");
  if (!DASHBOARD_JWKS_URL) {
    console.error("DASHBOARD_JWKS_URL is not configured.");
    return jsonResponse({ error: "Server configuration error." }, 500);
  }
  const DASHBOARD_ISSUER = deriveIssuer(DASHBOARD_JWKS_URL);
  // Partner ref derived from issuer host (e.g. zzqdzubykkglytjdecqe)
  const partnerRef = (() => {
    try {
      const host = new URL(DASHBOARD_ISSUER).host;
      return host.split(".")[0] || "dashboard";
    } catch {
      return "dashboard";
    }
  })();

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Authentication required." }, 401);
  }
  const token = authHeader.replace("Bearer ", "");

  // Verify the JWT against the dashboard project's JWKS.
  let sub: string | null = null;
  try {
    const { payload } = await jwtVerify(token, getDashboardJwks(DASHBOARD_JWKS_URL), {
      issuer: DASHBOARD_ISSUER,
    });
    sub = typeof payload.sub === "string" ? payload.sub : null;
  } catch (e) {
    console.warn("dashboard-token-get jwt verify failed:", (e as Error).message);
    return jsonResponse({ error: "Invalid session." }, 401);
  }
  if (!sub) {
    return jsonResponse({ error: "Invalid session." }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve the local backend user_id for this dashboard user.
  const userId = await resolvePartnerUserId(admin, partnerRef, sub);
  if (!userId) {
    return jsonResponse({ error: "Failed to resolve user." }, 500);
  }

  // Mint a fresh pair token for the dashboard. Only the hash is persisted;
  // we return the raw secret in this response so the dashboard can call the
  // backend functions with `Authorization: Bearer ext_<token>`.
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const rawToken = bytesToBase64Url(tokenBytes);
  const tokenHash = await sha256Hex(rawToken);

  const { error: insertErr } = await admin.from("extension_tokens").insert({
    user_id: userId,
    token_hash: tokenHash,
    label: "Dashboard",
  });
  if (insertErr) {
    console.error("dashboard-token-get insert error:", insertErr.message);
    return jsonResponse({ error: "Failed to mint token." }, 500);
  }

  const fullToken = `ext_${rawToken}`;
  return jsonResponse({
    token: fullToken,
    userId,
  });
});
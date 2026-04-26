import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  // Mint token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const rawToken = bytesToBase64Url(tokenBytes);
  const tokenHash = await sha256Hex(rawToken);

  const { error: tokenErr } = await admin.from("extension_tokens").insert({
    user_id: codeRow.user_id,
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
    const { data: userData } = await admin.auth.admin.getUserById(codeRow.user_id);
    userEmail = userData?.user?.email ?? null;
  } catch (e) {
    console.warn("pair-redeem getUserById warning:", (e as Error).message);
  }

  return jsonResponse({ extensionToken: `ext_${rawToken}`, userEmail });
});

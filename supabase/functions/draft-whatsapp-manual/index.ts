import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateText, stepCountIs, tool } from "npm:ai@5.0.26";
import { createAnthropic } from "npm:@ai-sdk/anthropic@2.0.10";
import { z } from "npm:zod@3.23.8";
import { jwtVerify, createRemoteJWKSet } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

const LIMITS = {
  incomingMessage: 4000,
  instruction: 2000,
};

const ANTHROPIC_TIMEOUT_MS = 30_000;
const MODEL = "claude-haiku-4-5-20251001";

const CALENDAR_FN =
  "https://zzqdzubykkglytjdecqe.supabase.co/functions/v1/calendar-query";

// Trusted partner Supabase projects whose JWTs we accept.
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

async function tryPartnerVerify(
  token: string,
): Promise<{ partnerRef: string; sub: string } | null> {
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

async function resolveBridgeUserId(
  admin: any,
  partnerRef: string,
  sub: string,
): Promise<string | null> {
  const bridgeEmail = `partner+${partnerRef}+${sub}@bridge.sendsmart.local`;
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (!listErr) {
    const found = list?.users?.find(
      (u: { email?: string | null }) => u.email === bridgeEmail,
    );
    if (found?.id) return found.id;
  } else {
    console.error("resolveBridgeUserId listUsers error:", listErr.message);
  }
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: bridgeEmail,
    email_confirm: true,
    user_metadata: { partner_ref: partnerRef, partner_sub: sub, bridge: true },
  });
  if (created?.user?.id) return created.user.id;
  if (createErr) {
    console.error("resolveBridgeUserId createUser error:", createErr.message);
  }
  return null;
}

function buildCalendarTools(userAccessToken: string) {
  const call = async (body: Record<string, unknown>) => {
    try {
      const r = await fetch(CALENDAR_FN, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAccessToken}`,
        },
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) return { error: "calendar_error", status: r.status, ...json };
      return json;
    } catch (e) {
      return { error: "calendar_unreachable", message: (e as Error)?.message };
    }
  };

  return {
    list_calendar_events: tool({
      description:
        "List the user's upcoming calendar events in a time window. Use when drafting replies that involve scheduling, availability, or referencing existing meetings.",
      inputSchema: z.object({
        from: z.string().datetime().describe("ISO start of window"),
        to: z.string().datetime().describe("ISO end of window"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: ({ from, to, limit }) =>
        call({ op: "events", from, to, limit }),
    }),
    check_calendar_freebusy: tool({
      description:
        "Check whether the user is free between `from` and `to`. Returns busy=true plus the conflicting events if any.",
      inputSchema: z.object({
        from: z.string().datetime(),
        to: z.string().datetime(),
      }),
      execute: ({ from, to }) => call({ op: "freebusy", from, to }),
    }),
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function cleanDraft(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[\s\S]*?\n([\s\S]*?)```$/gm, "$1").trim();
  if (text.startsWith("```") && text.endsWith("```")) text = text.slice(3, -3).trim();
  // Prefer content inside <reply>...</reply> tags if present.
  const tagged = text.match(/<reply>([\s\S]*?)<\/reply>/i);
  if (tagged && tagged[1].trim()) {
    text = tagged[1].trim();
  } else {
    // Strip leading meta/reasoning paragraphs ("I understand...", "Let me...", "The user...").
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const metaRe =
      /^(i (understand|see|notice|will|'ll|am going|need to)|let me|let's|the (user|sender|contact|message)|here('s| is)|okay,|sure,|first,|based on|since the|given that|i'll (draft|provide|respond|reply|write|craft))/i;
    while (paragraphs.length > 1 && metaRe.test(paragraphs[0])) {
      paragraphs.shift();
    }
    text = paragraphs.join("\n\n");
  }
  text = text.replace(/^(?:reply|response|message)\s*:\s*/i, "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text.replace(/\n{3,}/g, "\n\n");
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  // Auth — accept local Send Smart sessions or trusted partner JWTs.
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "server_misconfigured" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let userId: string | null = null;
  const partner = await tryPartnerVerify(token);
  if (partner) {
    userId = await resolveBridgeUserId(admin, partner.partnerRef, partner.sub);
  } else {
    userId = extractUserIdFromJwt(token);
  }
  if (!userId) return jsonResponse({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const incomingMessage = str(body.incomingMessage).slice(0, LIMITS.incomingMessage);
  const instruction = str(body.instruction).slice(0, LIMITS.instruction);
  const threadId = str(body.thread_id) || str(body.threadId);
  const provider = (str(body.provider) || "whatsapp").slice(0, 32);
  const autoSend = body.autoSend === true || body.auto_send === true;

  if (!incomingMessage) return jsonResponse({ error: "incomingMessage_required" }, 400);
  if (!instruction) return jsonResponse({ error: "instruction_required" }, 400);

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) return jsonResponse({ error: "server_misconfigured" }, 500);

  const systemPrompt = [
    "You draft a single WhatsApp reply on behalf of the user.",
    "Output ONLY the final reply, wrapped in <reply>...</reply> tags. Nothing before or after the tags.",
    "Do NOT include reasoning, analysis, preambles, explanations, or notes — inside or outside the tags. The contents of <reply> must be exactly what the user will send.",
    "No quotes, no labels, no markdown, no commentary.",
    "Match WhatsApp conventions: short, conversational, sentence-case, no greeting if mid-thread.",
    "Keep it under 3 short sentences unless clearly required.",
    "Never invent facts, prices, dates, or commitments.",
    "Follow the user's instruction strictly. If the instruction conflicts with safety, prefer a neutral reply.",
    "You can call check_calendar_freebusy before proposing any meeting time, and list_calendar_events to reference upcoming commitments. Today is " +
      new Date().toISOString() +
      ".",
  ].join(" ");

  const userBlock = [
    "Incoming WhatsApp message from the contact:",
    "<<<INCOMING>>>",
    incomingMessage,
    "<<<END>>>",
    "",
    "User instruction for the reply:",
    "<<<INSTRUCTION>>>",
    instruction,
    "<<<END>>>",
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  let rawText = "";
  try {
    const anthropic = createAnthropic({ apiKey: anthropicKey });
    const result = await generateText({
      model: anthropic(MODEL),
      system: systemPrompt,
      messages: [{ role: "user", content: userBlock }],
      tools: buildCalendarTools(token),
      stopWhen: stepCountIs(50),
      maxOutputTokens: 400,
      abortSignal: ctrl.signal,
    });
    rawText = result.text ?? "";
    try {
      const steps = (result as any).steps ?? [];
      const toolCalls = steps.flatMap((s: any) =>
        (s.toolCalls ?? []).map((c: any) => ({ name: c.toolName, args: c.args }))
      );
      console.log(
        "draft-whatsapp-manual tool usage",
        JSON.stringify({ stepCount: steps.length, toolCalls }),
      );
    } catch (_) { /* ignore */ }
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error)?.name === "AbortError";
    console.error("anthropic call failed", e);
    return jsonResponse(
      { error: aborted ? "anthropic_timeout" : "anthropic_error", message: (e as Error)?.message },
      aborted ? 504 : 502,
    );
  }
  clearTimeout(timer);

  const draft = cleanDraft(rawText);

  if (!draft) return jsonResponse({ error: "empty_draft" }, 502);

  // Persist as a pending draft so the extension can pick it up and auto-send.
  let draftId = "";
  if (threadId) {
    draftId = crypto.randomUUID();
    {
      const nowIso = new Date().toISOString();
      const { error: upsertErr } = await admin
        .from("thread_states")
        .upsert(
          {
            user_id: userId,
            provider,
            thread_id: threadId,
            draft_preview: draft,
            status_value: "draft_ready",
            auto_send: autoSend,
            draft_id: draftId,
            last_draft_at: nowIso,
            last_error: "",
          },
          { onConflict: "user_id,provider,thread_id" },
        );
      if (upsertErr) {
        return jsonResponse(
          { error: "persist_failed", message: upsertErr.message, draft },
          500,
        );
      }
    }
  }

  return jsonResponse({ draft, draft_id: draftId, model: MODEL });
});

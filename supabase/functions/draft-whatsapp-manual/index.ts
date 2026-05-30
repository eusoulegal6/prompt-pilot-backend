import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  // Auth — require a signed-in dashboard user.
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const userId = token ? extractUserIdFromJwt(token) : null;
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
    "Output ONLY the message text the user will send — no quotes, no labels, no markdown, no commentary.",
    "Match WhatsApp conventions: short, conversational, sentence-case, no greeting if mid-thread.",
    "Keep it under 3 short sentences unless clearly required.",
    "Never invent facts, prices, dates, or commitments.",
    "Follow the user's instruction strictly. If the instruction conflicts with safety, prefer a neutral reply.",
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
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: "user", content: userBlock }],
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error)?.name === "AbortError";
    return jsonResponse({ error: aborted ? "anthropic_timeout" : "anthropic_unreachable" }, 504);
  }
  clearTimeout(timer);

  if (!res.ok) {
    await res.text().catch(() => "");
    return jsonResponse({ error: "anthropic_error", status: res.status }, 502);
  }

  const data = await res.json().catch(() => null) as
    | { content?: Array<{ type?: string; text?: string }>; model?: string }
    | null;
  const raw = data?.content?.find((c) => c?.type === "text")?.text ?? "";
  const draft = cleanDraft(String(raw));

  if (!draft) return jsonResponse({ error: "empty_draft" }, 502);

  // Persist as a pending draft so the extension can pick it up and auto-send.
  let draftId = "";
  if (threadId) {
    draftId = crypto.randomUUID();
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && serviceKey) {
      const admin = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
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

  return jsonResponse({ draft, draft_id: draftId, model: data?.model ?? MODEL });
});

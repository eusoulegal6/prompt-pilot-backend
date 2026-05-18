import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

const CATEGORIES = [
  "appointment",
  "greeting",
  "pricing",
  "complaint",
  "support",
  "order",
  "payment",
  "cancellation",
  "escalation",
  "menu_bot",
  "broadcast_or_notification",
  "sensitive_request",
  "needs_human_judgment",
] as const;
type Category = typeof CATEGORIES[number];
const CATEGORY_SET = new Set<string>(CATEGORIES);

const LIMITS = {
  message: 4000,
  context: 2000,
  provider: 100,
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function extractUserIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveUserId(req: Request, supabaseUrl: string, serviceRoleKey: string): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  if (token.startsWith("ext_")) {
    const raw = token.slice(4);
    if (!raw) return null;
    try {
      const tokenHash = await sha256Hex(raw);
      const url = `${supabaseUrl}/rest/v1/extension_tokens?token_hash=eq.${tokenHash}&revoked_at=is.null&select=user_id`;
      const res = await fetch(url, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } });
      if (!res.ok) return null;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return rows[0].user_id ?? null;
    } catch {
      return null;
    }
  }
  return extractUserIdFromJwt(token);
}

const SYSTEM_PROMPT = `You classify the LATEST inbound customer message into exactly ONE category.

Allowed categories (return the slug exactly as listed):
- appointment: booking, scheduling, rescheduling, confirming an appointment/visit/meeting.
- greeting: hi/hello/good morning with no actual request yet.
- pricing: asking about price, quote, cost, discount, packages, "how much".
- complaint: expressing dissatisfaction, anger, or a problem with the service/product.
- support: technical or operational help, "how do I…", troubleshooting, account access.
- order: placing/checking/modifying a product or service order, delivery status.
- payment: invoices, receipts, payment links, refunds, payment confirmations.
- cancellation: cancelling an appointment, order, subscription, or service.
- escalation: explicitly asking for a human/manager/supervisor/agent.
- menu_bot: IVR-style numbered menus ("press 1 for…", "reply 2 to…").
- broadcast_or_notification: marketing blasts, newsletters, mass notifications, promotional content.
- sensitive_request: legal, medical, financial advice, threats, self-harm, harassment — anything requiring careful human handling.
- needs_human_judgment: ambiguous, long, multi-topic, or anything that clearly does not fit the above.

PRECEDENCE RULES (apply in order — first match wins):
1. If the user explicitly asks for a human/manager/agent → escalation.
2. If the content is legal/medical/financial advice, threats, self-harm, or harassment → sensitive_request.
3. If the sender is clearly a system/bot (OTP, automated confirmation, marketing blast) → broadcast_or_notification / menu_bot.
4. If the user wants to cancel AND mentions payment/refund → cancellation.
5. If the user is angry/dissatisfied AND also asks something else → complaint.
6. If the message is just a salutation with no request → greeting (even if context has other topics).
7. If the message covers 3+ distinct asks or is genuinely ambiguous → needs_human_judgment.
8. Otherwise pick the single best topical category (appointment, pricing, support, order, payment).

IMPORTANT:
- Classify the LATEST inbound message only. Prior context is background, not the subject.
- Do not invent categories. If unsure between two, prefer the more specific one; if still unsure, use needs_human_judgment.

EXAMPLES:
Input: "Hi, can I book a haircut for Saturday at 3pm?"
Output: {"category":"appointment","confidence":0.95,"reason":"booking request with time"}

Input: "this is the third time I'm writing, can I please speak to a manager"
Output: {"category":"escalation","confidence":0.97,"reason":"explicit request for manager"}

Input: "I want to cancel my order and get my money back"
Output: {"category":"cancellation","confidence":0.9,"reason":"cancel + refund → cancellation per rule 4"}

Input: "Your code is 482910. Do not share it."
Output: {"category":"automation","confidence":0.98,"reason":"OTP from a system"}

Input: "Hello 👋"
Output: {"category":"greeting","confidence":0.95,"reason":"salutation only"}

Input: "How much for 50 units shipped to Berlin, and do you offer net-30?"
Output: {"category":"pricing","confidence":0.85,"reason":"quote request"}

Input: "I've been charged twice for invoice #1234"
Output: {"category":"payment","confidence":0.9,"reason":"billing issue on invoice"}

Reply with ONLY a compact JSON object: {"category":"<slug>","confidence":<0..1>,"reason":"<short>"}.
No prose, no markdown, no code fences.`;

async function classifyWithClaude(apiKey: string, message: string, context: string, provider: string) {
  const userBlock = [
    provider ? `Provider: ${provider}` : "",
    context ? `Background context (prior thread, DO NOT classify this):\n${context}` : "",
    `<<<LATEST MESSAGE TO CLASSIFY>>>\n${message}\n<<<END>>>`,
  ].filter(Boolean).join("\n\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userBlock }],
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    throw new Error(`anthropic ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text: string = data?.content?.[0]?.text ?? "";
  return {
    text,
    inputTokens: data?.usage?.input_tokens ?? 0,
    outputTokens: data?.usage?.output_tokens ?? 0,
  };
}

function parseClassification(text: string): { category: Category; confidence: number; reason: string } {
  let cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];
  let parsed: { category?: unknown; confidence?: unknown; reason?: unknown } = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // ignore
  }
  const rawCat = typeof parsed.category === "string" ? parsed.category.trim().toLowerCase() : "";
  const category: Category = CATEGORY_SET.has(rawCat) ? rawCat as Category : "other";
  let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 280) : "";
  return { category, confidence, reason };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET") {
    return jsonResponse({ ok: true, function: "classify-message", categories: CATEGORIES });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Server configuration error." }, 500);
  }

  const userId = await resolveUserId(req, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    body = raw as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const message = truncate(str(body.message), LIMITS.message);
  const context = truncate(str(body.context), LIMITS.context);
  const provider = truncate(str(body.provider), LIMITS.provider);

  if (!message) {
    return jsonResponse({ error: "Missing 'message'." }, 400);
  }

  const started = Date.now();
  try {
    const { text, inputTokens, outputTokens } = await classifyWithClaude(
      ANTHROPIC_API_KEY, message, context, provider,
    );
    const result = parseClassification(text);
    console.log(
      `classify-message OK ${Date.now() - started}ms user=${userId} provider=${provider} cat=${result.category} conf=${result.confidence} in_tok=${inputTokens} out_tok=${outputTokens}`,
    );
    return jsonResponse({
      ok: true,
      category: result.category,
      confidence: result.confidence,
      reason: result.reason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`classify-message ERROR ${Date.now() - started}ms user=${userId}: ${msg}`);
    return jsonResponse({ error: "Classification failed", detail: msg.slice(0, 200) }, 502);
  }
});

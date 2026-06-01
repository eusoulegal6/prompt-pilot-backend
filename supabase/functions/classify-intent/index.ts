import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

// Fine-grained customer-service intents (subcategory).
const INTENTS = [
  "greeting_only",
  "appointment_new",
  "appointment_reschedule",
  "appointment_cancel",
  "pricing_question",
  "product_or_service_question",
  "order_status",
  "payment_or_billing",
  "refund_or_return",
  "complaint",
  "technical_support",
  "human_agent_request",
  "spam_or_irrelevant",
  "unclear",
] as const;
type Intent = typeof INTENTS[number];
const INTENT_SET = new Set<string>(INTENTS);

const URGENCIES = ["low", "medium", "high"] as const;
type Urgency = typeof URGENCIES[number];
const URGENCY_SET = new Set<string>(URGENCIES);

// Broad dashboard buckets. Keeps the existing intent_category contract stable.
const BROAD_CATEGORIES = ["appointment", "support", "flagged", "misc"] as const;
type BroadCategory = typeof BROAD_CATEGORIES[number];

function broadCategoryFor(intent: Intent): BroadCategory {
  switch (intent) {
    case "appointment_new":
    case "appointment_reschedule":
    case "appointment_cancel":
      return "appointment";
    case "pricing_question":
    case "product_or_service_question":
    case "order_status":
    case "payment_or_billing":
    case "refund_or_return":
    case "technical_support":
      return "support";
    case "complaint":
    case "human_agent_request":
      return "flagged";
    case "greeting_only":
    case "spam_or_irrelevant":
    case "unclear":
    default:
      return "misc";
  }
}

// Server-side fallback: when the model forgets needs_human_review, this catches the
// obvious cases. Anything ambiguous or low-confidence is also surfaced.
function shouldFlag(intent: Intent, confidence: number, modelFlag: boolean): boolean {
  if (modelFlag) return true;
  if (intent === "complaint") return true;
  if (intent === "refund_or_return") return true;
  if (intent === "human_agent_request") return true;
  if (intent === "unclear") return true;
  if (intent === "payment_or_billing") return true;
  if (confidence < 0.55) return true;
  return false;
}

const LIMITS = {
  message: 4000,
  context: 2000,
  provider: 100,
  source: 32,
};

const THREAD_ID_LIMIT = 256;

const ALLOWED_SOURCES = new Set(["text", "voice", "voice_transcript", "transcript", "audio"]);

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

const SYSTEM_PROMPT = `You are a customer-service intent classifier.

Your job is NOT to detect keywords. Your job is to understand what the customer is trying to accomplish and what action the business should take next. The message may come from typed text or from a transcribed voice note — treat both the same. Transcripts may contain filler words, disfluencies, or minor speech-to-text errors; classify the underlying intent.

Classify the LATEST inbound customer message into exactly one intent.

Intent definitions:

- greeting_only: pure salutation, no request yet ("Hi", "Good morning", "Hello, how are you?").
- appointment_new: customer wants to book / schedule / reserve / check availability for a NEW appointment, visit, call, consultation, meeting, or service.
- appointment_reschedule: customer already has something scheduled and wants to change the date or time.
- appointment_cancel: customer wants to cancel a scheduled appointment / visit / call / booking.
- pricing_question: asking about price, quote, cost, plans, fees, discount, or payment amount.
- product_or_service_question: asking what the business offers, how something works, requirements, location, opening hours, availability of a service, general information.
- order_status: asking about an existing order, delivery, shipment, purchase, or service progress.
- payment_or_billing: payment problems, invoices, charges, receipts, failed payments, billing confusion.
- refund_or_return: asking for money back / refund / return / reversal / reimbursement.
- complaint: expresses dissatisfaction, frustration, bad experience, poor service, delay, broken promise, negative feedback.
- technical_support: reports something not working in a product, app, login, account, website, device, system, or technical process.
- human_agent_request: explicitly asks for a person, manager, attendant, representative, or human help.
- spam_or_irrelevant: spam, bot-like, unrelated, promotional, nonsense, not a customer-service conversation.
- unclear: may be from a real customer, but intent is too ambiguous to know what they need.

Rules:
- Choose the intent based on the customer's main GOAL, not by keyword matching.
- Do NOT classify as appointment_* only because a date or time appears. If the date/time appears while complaining, paying, or asking about an order, classify according to the real issue.
- If the message has multiple intents, choose the one that requires the most immediate business action.
- Complaints, refund requests, payment/billing issues, human-agent requests, and unclear messages usually need human review.
- Greetings do not need human review unless combined with another request.
- Prior context is background, not the subject — classify the LATEST inbound message.

Return ONLY valid JSON. No markdown, no code fences, no prose outside the object.

Schema:
{
  "intent": "greeting_only | appointment_new | appointment_reschedule | appointment_cancel | pricing_question | product_or_service_question | order_status | payment_or_billing | refund_or_return | complaint | technical_support | human_agent_request | spam_or_irrelevant | unclear",
  "confidence": number between 0 and 1,
  "customer_goal": "short explanation of what the customer wants (<= 240 chars)",
  "business_action": "what the business should do next (<= 240 chars)",
  "needs_human_review": boolean,
  "review_reason": "short reason or empty string (<= 240 chars)",
  "urgency": "low | medium | high"
}

Example:
Input: "I paid yesterday at 3pm and still didn't receive confirmation."
Output: {"intent":"payment_or_billing","confidence":0.94,"customer_goal":"Wants help with a missing payment confirmation.","business_action":"Check payment status and send confirmation or next steps.","needs_human_review":true,"review_reason":"Payment issue may require account verification.","urgency":"medium"}`;

async function classifyWithClaude(
  apiKey: string,
  message: string,
  context: string,
  provider: string,
  source: string,
) {
  const sourceLabel = source === "voice" || source === "voice_transcript" || source === "transcript" || source === "audio"
    ? "voice_transcript"
    : "text";

  const userBlock = [
    provider ? `Provider: ${provider}` : "",
    `Source: ${sourceLabel}`,
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
        max_tokens: 400,
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

type Classification = {
  intent: Intent;
  category: BroadCategory;
  confidence: number;
  customer_goal: string;
  business_action: string;
  needs_human_review: boolean;
  review_reason: string;
  urgency: Urgency;
  reason: string;
};

function parseClassification(text: string): Classification {
  let cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // ignore
  }

  // Accept either the new `intent` field or the legacy `category` field.
  const rawIntent =
    (typeof parsed.intent === "string" && parsed.intent.trim().toLowerCase()) ||
    (typeof parsed.category === "string" && parsed.category.trim().toLowerCase()) ||
    "";
  const intent: Intent = INTENT_SET.has(rawIntent) ? (rawIntent as Intent) : "unclear";

  let confidence = typeof parsed.confidence === "number" ? parsed.confidence : Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  const customer_goal = typeof parsed.customer_goal === "string" ? parsed.customer_goal.slice(0, 280) : "";
  const business_action = typeof parsed.business_action === "string" ? parsed.business_action.slice(0, 280) : "";
  const review_reason = typeof parsed.review_reason === "string" ? parsed.review_reason.slice(0, 280) : "";
  const rawUrgency = typeof parsed.urgency === "string" ? parsed.urgency.trim().toLowerCase() : "";
  const urgency: Urgency = URGENCY_SET.has(rawUrgency) ? (rawUrgency as Urgency) : "medium";
  const modelFlag = Boolean(parsed.needs_human_review);
  const needs_human_review = shouldFlag(intent, confidence, modelFlag);

  // Keep `reason` for backward-compatible logging / display.
  const legacyReason = typeof parsed.reason === "string" ? parsed.reason : (review_reason || customer_goal);
  const reason = legacyReason.slice(0, 280);

  return {
    intent,
    category: broadCategoryFor(intent),
    confidence,
    customer_goal,
    business_action,
    needs_human_review,
    review_reason,
    urgency,
    reason,
  };
}

function buildPersistBody(result: Classification, source: string) {
  return {
    intent_category: result.category,
    intent_subcategory: result.intent,
    intent_confidence: result.confidence,
    intent_reason: result.reason,
    intent_source: source,
    intent_classified_at: new Date().toISOString(),
    customer_goal: result.customer_goal,
    business_action: result.business_action,
    needs_human_review: result.needs_human_review,
    intent_review_reason: result.review_reason,
    intent_urgency: result.urgency,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET") {
    return jsonResponse({ ok: true, function: "classify-intent", intents: INTENTS, categories: BROAD_CATEGORIES });
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

  // Backfill mode: classify existing thread_states rows that have no intent_category yet.
  if (body.action === "backfill" || body.backfill === true) {
    let limit = Number(body.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = 25;
    if (limit > 100) limit = 100;

    const listUrl = `${SUPABASE_URL}/rest/v1/thread_states` +
      `?user_id=eq.${userId}` +
      `&or=(intent_category.is.null,intent_category.eq.)` +
      `&select=id,provider,thread_id,sender,latest_message,preview,subject` +
      `&order=updated_at.desc&limit=${limit}`;
    const listRes = await fetch(listUrl, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!listRes.ok) {
      const t = (await listRes.text()).slice(0, 300);
      return jsonResponse({ error: "List failed", detail: t }, 502);
    }
    const rows = await listRes.json() as Array<Record<string, unknown>>;
    const results: Array<Record<string, unknown>> = [];
    let classified = 0;
    let skipped = 0;
    let failed = 0;
    for (const row of rows) {
      const rowId = str(row.id);
      const provider = truncate(str(row.provider), LIMITS.provider);
      const msg = truncate(str(row.latest_message) || str(row.preview) || str(row.subject), LIMITS.message);
      if (!msg || !rowId) { skipped++; continue; }
      try {
        const { text } = await classifyWithClaude(ANTHROPIC_API_KEY, msg, "", provider, "text");
        const result = parseClassification(text);
        const patchBody = buildPersistBody(result, "backfill");
        const patchUrl = `${SUPABASE_URL}/rest/v1/thread_states?id=eq.${rowId}&user_id=eq.${userId}`;
        const pr = await fetch(patchUrl, {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(patchBody),
        });
        if (!pr.ok) { failed++; results.push({ id: rowId, error: `patch ${pr.status}` }); continue; }
        classified++;
        results.push({ id: rowId, intent: result.intent, category: result.category, confidence: result.confidence, needs_human_review: result.needs_human_review });
      } catch (e) {
        failed++;
        results.push({ id: rowId, error: e instanceof Error ? e.message.slice(0, 120) : "error" });
      }
    }
    console.log(`classify-intent backfill user=${userId} processed=${rows.length} classified=${classified} failed=${failed} skipped=${skipped}`);
    return jsonResponse({ ok: true, mode: "backfill", processed: rows.length, classified, failed, skipped, results });
  }

  // Accept `message` or `transcript` (alias for voice notes).
  const messageRaw = str(body.message) || str(body.transcript) || str(body.text);
  const message = truncate(messageRaw, LIMITS.message);
  const context = truncate(str(body.context), LIMITS.context);
  const provider = truncate(str(body.provider), LIMITS.provider);
  const sourceRaw = truncate(str(body.source), LIMITS.source).toLowerCase();
  const source = ALLOWED_SOURCES.has(sourceRaw) ? sourceRaw : (str(body.transcript) ? "voice_transcript" : "text");
  const threadId = truncate(str(body.thread_id), THREAD_ID_LIMIT);
  const persist = Boolean(threadId && provider);

  if (!message) {
    return jsonResponse({ error: "Missing 'message' or 'transcript'." }, 400);
  }

  const started = Date.now();
  try {
    const { text, inputTokens, outputTokens } = await classifyWithClaude(
      ANTHROPIC_API_KEY,
      message,
      context,
      provider,
      source,
    );
    const result = parseClassification(text);

    if (persist) {
      try {
        const patchBody = buildPersistBody(result, source);
        const url = `${SUPABASE_URL}/rest/v1/thread_states?user_id=eq.${userId}&provider=eq.${encodeURIComponent(provider)}&thread_id=eq.${encodeURIComponent(threadId)}`;
        await fetch(url, {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(patchBody),
        });
      } catch (e) {
        console.error(`classify-intent persist failed user=${userId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(
      `classify-intent OK ${Date.now() - started}ms user=${userId} provider=${provider} source=${source} intent=${result.intent} cat=${result.category} conf=${result.confidence} review=${result.needs_human_review} urgency=${result.urgency} in_tok=${inputTokens} out_tok=${outputTokens}`,
    );
    return jsonResponse({
      ok: true,
      intent: result.intent,
      category: result.category,
      confidence: result.confidence,
      customer_goal: result.customer_goal,
      business_action: result.business_action,
      needs_human_review: result.needs_human_review,
      review_reason: result.review_reason,
      urgency: result.urgency,
      reason: result.reason,
      source,
      persisted: persist,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`classify-intent ERROR ${Date.now() - started}ms user=${userId}: ${msg}`);
    return jsonResponse({ error: "Classification failed", detail: msg.slice(0, 200) }, 502);
  }
});
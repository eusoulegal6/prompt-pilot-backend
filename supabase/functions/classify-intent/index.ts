import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

const CATEGORIES = ["appointment", "greeting", "support", "misc"] as const;
type Category = typeof CATEGORIES[number];
const CATEGORY_SET = new Set<string>(CATEGORIES);

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

const SYSTEM_PROMPT = `You classify the LATEST inbound customer message into exactly ONE of FOUR categories.
The message may come from a typed text or from a transcribed voice note — treat both the same. Transcripts may
contain filler words ("uh", "um"), disfluencies, or minor speech-to-text errors; classify the underlying intent.

Allowed categories (return the slug exactly):
- appointment: booking, scheduling, rescheduling, confirming, or cancelling a visit / meeting / call / reservation.
  Mentions of dates, times, availability ("tomorrow at 3", "next Tuesday", "are you free…"), or location for a visit.
- greeting: a salutation or social pleasantry with NO concrete request yet ("hi", "hello", "good morning",
  "how are you", "thanks", an emoji-only reply).
- support: the user needs help, has a problem, asks "how do I…", reports something broken, asks about pricing,
  orders, payments, refunds, complaints, technical/operational questions, or anything where a service answer is expected.
- misc: anything that clearly doesn't fit the three above — small talk beyond a greeting, spam, automated/bot
  messages, off-topic chatter, jokes, forwards, ambiguous or multi-topic messages.

PRECEDENCE (first match wins):
1. Explicit scheduling intent (book / reschedule / cancel a time slot, propose a date/time) → appointment.
2. Pure salutation with no follow-up request → greeting.
3. Any concrete service/help/billing/product question or complaint → support.
4. Otherwise → misc.

IMPORTANT:
- Classify the LATEST inbound message only. Prior context is background, not the subject.
- Do not invent categories. If genuinely unsure between support and misc, prefer misc.
- If unsure between appointment and support, prefer appointment when a specific time/date is proposed.

EXAMPLES:
Input: "Hi, can I book a haircut for Saturday at 3pm?"
Output: {"category":"appointment","confidence":0.95,"reason":"booking with time"}

Input: "uhh hello, good morning"
Output: {"category":"greeting","confidence":0.95,"reason":"salutation only"}

Input: "my invoice was charged twice, can you refund one?"
Output: {"category":"support","confidence":0.92,"reason":"billing problem"}

Input: "lol that meme yesterday was wild"
Output: {"category":"misc","confidence":0.85,"reason":"off-topic small talk"}

Reply with ONLY a compact JSON object: {"category":"<slug>","confidence":<0..1>,"reason":"<short>"}.
No prose, no markdown, no code fences.`;

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
        max_tokens: 150,
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
  const category: Category = CATEGORY_SET.has(rawCat) ? (rawCat as Category) : "misc";
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
    return jsonResponse({ ok: true, function: "classify-intent", categories: CATEGORIES });
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
        const patchBody = {
          intent_category: result.category,
          intent_confidence: result.confidence,
          intent_reason: result.reason,
          intent_source: "backfill",
          intent_classified_at: new Date().toISOString(),
        };
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
        results.push({ id: rowId, category: result.category, confidence: result.confidence });
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
        const patchBody = {
          intent_category: result.category,
          intent_confidence: result.confidence,
          intent_reason: result.reason,
          intent_source: source,
          intent_classified_at: new Date().toISOString(),
        };
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
      `classify-intent OK ${Date.now() - started}ms user=${userId} provider=${provider} source=${source} cat=${result.category} conf=${result.confidence} in_tok=${inputTokens} out_tok=${outputTokens}`,
    );
    return jsonResponse({
      ok: true,
      category: result.category,
      confidence: result.confidence,
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
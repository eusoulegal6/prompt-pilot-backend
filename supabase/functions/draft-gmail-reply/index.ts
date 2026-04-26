import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

// --- Truncation limits (characters) ---
const LIMITS = {
  subject: 300,
  senderName: 200,
  senderEmail: 320,
  latestMessage: 12000,
  threadMessage: 8000,
  threadMaxCount: 10,
  identity: 500,
  replyStyle: 100,
  knowledge: 4000,
  signature: 1000,
  extraInstructions: 2000,
  sourceUrl: 2000,
};

// --- Quota limits (generous, abuse-prevention only) ---
const QUOTA_EMAILS_PER_MONTH = 500;
const QUOTA_INPUT_TOKENS_PER_MONTH = 2_000_000;
const QUOTA_OUTPUT_TOKENS_PER_MONTH = 500_000;

const ANTHROPIC_TIMEOUT_MS = 30_000;

// --- SUPABASE_SERVICE_ROLE_KEY must be added as a secret in the project dashboard ---
// Go to Project Settings → Edge Functions → Secrets and add SUPABASE_SERVICE_ROLE_KEY.
// SUPABASE_URL is injected automatically by Supabase.

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v.trim() : fallback;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function cleanDraft(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[\s\S]*?\n([\s\S]*?)```$/gm, "$1").trim();
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.slice(3, -3).trim();
  }
  text = text.replace(/^Subject:\s*[^\n]*\n*/i, "").trim();
  text = text.replace(/\n{3,}/g, "\n\n");
  return text;
}

/** Extract user_id from JWT bearer token without importing a library. */
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
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolves the user_id from the Authorization header.
 * Supports two token types:
 *  - Standard Supabase JWT: `Bearer <jwt>`
 *  - Extension pairing token: `Bearer ext_<token>` (validated against extension_tokens table)
 */
async function resolveUserId(
  req: Request,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];

  // Extension token path
  if (token.startsWith("ext_")) {
    const raw = token.slice(4);
    if (!raw) return null;
    try {
      const tokenHash = await sha256Hex(raw);
      const url = `${supabaseUrl}/rest/v1/extension_tokens?token_hash=eq.${tokenHash}&revoked_at=is.null&select=id,user_id`;
      const res = await fetch(url, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      });
      if (!res.ok) {
        console.warn(`Extension token lookup failed status=${res.status}`);
        return null;
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0];
      // Fire-and-forget last_used_at update
      fetch(`${supabaseUrl}/rest/v1/extension_tokens?id=eq.${row.id}`, {
        method: "PATCH",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      }).catch((e) => console.warn("last_used_at update failed:", (e as Error).message));
      return row.user_id ?? null;
    } catch (e) {
      console.warn("Extension token validation error:", (e as Error).message);
      return null;
    }
  }

  // Standard Supabase JWT path
  return extractUserIdFromJwt(token);
}

/** Get current YYYY-MM period string. */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Check quota for user. Returns null if OK, or an error response if exceeded. Fails open. */
async function checkQuota(userId: string, period: string, supabaseUrl: string, serviceRoleKey: string): Promise<Response | null> {
  try {
    const url = `${supabaseUrl}/rest/v1/usage_counters?user_id=eq.${userId}&period=eq.${period}&select=emails_used,input_tokens_used,output_tokens_used`;
    const res = await fetch(url, {
      headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
      },
    });
    if (!res.ok) {
      console.warn(`Quota check failed status=${res.status}, allowing request`);
      return null; // fail open
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null; // no usage yet

    const row = rows[0];
    if (
      (row.emails_used ?? 0) >= QUOTA_EMAILS_PER_MONTH ||
      (row.input_tokens_used ?? 0) >= QUOTA_INPUT_TOKENS_PER_MONTH ||
      (row.output_tokens_used ?? 0) >= QUOTA_OUTPUT_TOKENS_PER_MONTH
    ) {
      return jsonResponse({
        error: `Monthly reply limit reached (${QUOTA_EMAILS_PER_MONTH} emails). Your quota resets at the start of next month.`,
        quotaExceeded: true,
      }, 429);
    }
    return null;
  } catch (err) {
    console.warn("Quota check error, allowing request:", (err as Error).message);
    return null; // fail open
  }
}

/** Fire-and-forget: upsert usage_counters and insert reply_log. */
function recordUsage(
  userId: string,
  period: string,
  inputTokens: number,
  outputTokens: number,
  meta: { subject: string; senderEmail: string; sourceUrl: string; decision?: string },
  supabaseUrl: string,
  serviceRoleKey: string,
) {
  const decision = meta.decision || "reply";
  const headers = {
    "apikey": serviceRoleKey,
    "Authorization": `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  // 1. Upsert usage_counters — only count actual replies toward email quota
  const isReply = decision === "reply";
  const upsertBody = JSON.stringify({
    user_id: userId,
    period,
    emails_used: isReply ? 1 : 0,
    input_tokens_used: inputTokens,
    output_tokens_used: outputTokens,
  });

  fetch(`${supabaseUrl}/rest/v1/usage_counters`, {
    method: "POST",
    headers: { ...headers, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: upsertBody,
  })
    .then(async (res) => {
      if (res.status === 201 || res.status === 200) {
        // New row created or returned existing — if existing, we need to increment
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0) {
          const existing = rows[0];
          // If the row already had usage, the upsert replaced it with 1/inputTokens/outputTokens.
          // We need to PATCH to set the correct accumulated values.
          if (existing.emails_used > (isReply ? 1 : 0) || existing.input_tokens_used > inputTokens || existing.output_tokens_used > outputTokens) {
            // Row already had higher values — the upsert overwrote. This shouldn't happen with
            // merge-duplicates, but as a safety net we skip. The RPC approach below handles it.
            return;
          }
        }
      } else {
        // Conflict or existing row — increment via PATCH using raw SQL RPC
        // Fall back: read current, then patch
        const getRes = await fetch(
          `${supabaseUrl}/rest/v1/usage_counters?user_id=eq.${userId}&period=eq.${period}&select=id,emails_used,input_tokens_used,output_tokens_used`,
          { headers },
        );
        if (getRes.ok) {
          const rows = await getRes.json();
          if (Array.isArray(rows) && rows.length > 0) {
            const row = rows[0];
            await fetch(`${supabaseUrl}/rest/v1/usage_counters?id=eq.${row.id}`, {
              method: "PATCH",
              headers: { ...headers, "Prefer": "return=minimal" },
              body: JSON.stringify({
                emails_used: (row.emails_used ?? 0) + (isReply ? 1 : 0),
                input_tokens_used: (row.input_tokens_used ?? 0) + inputTokens,
                output_tokens_used: (row.output_tokens_used ?? 0) + outputTokens,
              }),
            });
          }
        }
      }
    })
    .catch((err) => console.warn("Usage upsert error:", (err as Error).message));

  // 2. Insert reply_log
  fetch(`${supabaseUrl}/rest/v1/reply_logs`, {
    method: "POST",
    headers: { ...headers, "Prefer": "return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      period,
      subject: meta.subject?.slice(0, 300) || null,
      sender_email: meta.senderEmail?.slice(0, 320) || null,
      source_url: meta.sourceUrl?.slice(0, 2000) || null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      decision,
    }),
  }).catch((err) => console.warn("Reply log insert error:", (err as Error).message));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }

  if (req.method === "GET") {
    return jsonResponse({ ok: true, function: "draft-gmail-reply" });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const startTime = Date.now();

  // --- Authenticate (supports Supabase JWT or `ext_` extension token) ---
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return jsonResponse({ error: "Server configuration error." }, 500);
  }
  const userId = await resolveUserId(req, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!userId) {
    return jsonResponse({ error: "Authentication required." }, 401);
  }

  // --- Parse body ---
  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }
    body = raw as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  // --- Extract & normalize ---
  const subject = truncate(str(body.subject, "(No subject)"), LIMITS.subject);
  const senderName = truncate(str(body.senderName), LIMITS.senderName);
  const senderEmail = truncate(str(body.senderEmail), LIMITS.senderEmail);
  const latestMessage = truncate(str(body.latestMessage), LIMITS.latestMessage);
  const sourceUrl = truncate(str(body.sourceUrl), LIMITS.sourceUrl);
  const identity = truncate(str(body.identity), LIMITS.identity);
  const replyStyle = truncate(str(body.replyStyle, "professional"), LIMITS.replyStyle);
  const knowledge = truncate(str(body.knowledge), LIMITS.knowledge);
  const signature = truncate(str(body.signature), LIMITS.signature);
  const extraInstructions = truncate(str(body.extraInstructions), LIMITS.extraInstructions);

  const threadMessages: string[] = (
    Array.isArray(body.threadMessages)
      ? body.threadMessages
          .filter((m: unknown) => typeof m === "string")
          .map((m: string) => m.trim())
          .filter(Boolean)
          .slice(0, LIMITS.threadMaxCount)
          .map((m: string) => truncate(m, LIMITS.threadMessage))
      : []
  );

  // --- Decision: log-only path (no AI call) for "review" or "skip" ---
  const decisionRaw = str(body.decision, "reply").toLowerCase();
  const decision = ["reply", "review", "skip"].includes(decisionRaw) ? decisionRaw : "reply";
  const period = currentPeriod();

  if (decision !== "reply") {
    // Log-only: extension is reporting a flagged/skipped email. No AI, no quota check.
    console.log(`Log-only: user=${userId} decision=${decision} subject_len=${subject.length}`);
    recordUsage(userId, period, 0, 0, { subject, senderEmail, sourceUrl, decision }, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    return jsonResponse({ ok: true, logged: true, decision });
  }

  // --- Must have content (only required for actual reply generation) ---
  if (!latestMessage && threadMessages.length === 0) {
    console.log("Rejected: no content provided");
    return jsonResponse({ error: "Not enough content: provide \"latestMessage\" or at least one non-empty entry in \"threadMessages\"." }, 400);
  }

  // --- Quota check ---
  const quotaBlock = await checkQuota(userId, period, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (quotaBlock) return quotaBlock;

  // --- Build prompt ---
  const threadContext =
    threadMessages.length > 0
      ? `\n\nPrevious messages in the thread (oldest first):\n${threadMessages.map((m, i) => `--- Message ${i + 1} ---\n${m}`).join("\n\n")}`
      : "";

  const fromLine = senderName && senderEmail
    ? `From: ${senderName} <${senderEmail}>`
    : senderName ? `From: ${senderName}` : senderEmail ? `From: ${senderEmail}` : "";

  const identityBlock = identity ? `\nYou are replying as: ${identity}` : "";
  const knowledgeBlock = knowledge ? `\nRelevant background knowledge:\n${knowledge}` : "";
  const styleBlock = `\nReply style: ${replyStyle}`;
  const extraBlock = extraInstructions ? `\nAdditional instructions: ${extraInstructions}` : "";
  const signatureBlock = signature ? `\nAppend this signature at the end of the reply, separated by a blank line:\n${signature}` : "";

  const systemPrompt = `You are a professional email assistant. Your job is to draft a reply to an email.

Rules:
- Return ONLY the email body text. No subject line, no greeting prefix like "Subject:", no markdown, no code fences, no disclaimers.
- Preserve all facts from the original email. Do not invent commitments or promises the sender did not make.
- Be concise, clear, and natural.
- Match the tone indicated by the reply style.
- If a signature is provided, append it naturally at the end after a blank line.${identityBlock}${styleBlock}${knowledgeBlock}${extraBlock}${signatureBlock}`;

  const userPrompt = `Email subject: ${subject}
${fromLine ? fromLine + "\n" : ""}${sourceUrl ? `Source: ${sourceUrl}\n` : ""}${threadContext}
${latestMessage ? `\nLatest message to reply to:\n${latestMessage}` : "\nDraft a reply based on the thread messages above."}

Draft a reply now.`;

  // --- Call Anthropic ---
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY secret");
    return jsonResponse({ error: "Server configuration error." }, 500);
  }

  const model = "claude-sonnet-4-20250514";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    console.log(`Request: user=${userId} period=${period} subject_len=${subject.length} latest_len=${latestMessage.length} thread_count=${threadMessages.length} style="${replyStyle}"`);

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!anthropicRes.ok) {
      const status = anthropicRes.status;
      const errSnippet = (await anthropicRes.text()).slice(0, 200);
      console.error(`Anthropic error status=${status} snippet=${errSnippet}`);

      if (status === 429) return jsonResponse({ error: "Rate limited. Try again shortly." }, 429);
      if (status === 401) return jsonResponse({ error: "Server configuration error." }, 500);
      if (status >= 500) return jsonResponse({ error: "AI service temporarily unavailable." }, 502);
      return jsonResponse({ error: "AI generation failed." }, 502);
    }

    const anthropicData = await anthropicRes.json();
    const rawDraft = anthropicData.content?.[0]?.text ?? "";
    const draft = cleanDraft(rawDraft);

    if (!draft) {
      console.error(`Empty draft after cleanup, raw_len=${rawDraft.length} stop_reason=${anthropicData.stop_reason ?? "unknown"}`);
      return jsonResponse({ error: "AI returned an empty response." }, 502);
    }

    // --- Read actual token usage ---
    const inputTokens = anthropicData.usage?.input_tokens ?? 0;
    const outputTokens = anthropicData.usage?.output_tokens ?? 0;

    const elapsed = Date.now() - startTime;
    console.log(`OK ${elapsed}ms user=${userId} period=${period} draft_len=${draft.length} in_tok=${inputTokens} out_tok=${outputTokens}`);

    // --- Fire-and-forget: record usage ---
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      recordUsage(userId, period, inputTokens, outputTokens, { subject, senderEmail, sourceUrl, decision: "reply" }, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    }

    return jsonResponse({ draft, model });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") {
      console.error(`Anthropic timeout after ${ANTHROPIC_TIMEOUT_MS}ms`);
      return jsonResponse({ error: "AI request timed out. Try again." }, 504);
    }
    console.error("Anthropic request failed:", (err as Error).message);
    return jsonResponse({ error: "Failed to reach AI service." }, 502);
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

// --- Truncation limits (characters) — tuned for WhatsApp ---
const LIMITS = {
  contactName: 200,
  latestMessage: 4000,
  threadMessage: 2000,
  threadMaxCount: 20,
  identity: 500,
  replyStyle: 100,
  knowledge: 4000,
  signature: 200,
  extraInstructions: 2000,
  sourceUrl: 2000,
  chatTitle: 200,
};

// --- Quota limits (shared with email path; counted in same usage_counters) ---
const QUOTA_EMAILS_PER_MONTH = 500;
const QUOTA_INPUT_TOKENS_PER_MONTH = 2_000_000;
const QUOTA_OUTPUT_TOKENS_PER_MONTH = 500_000;

const ANTHROPIC_TIMEOUT_MS = 30_000;

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
  // Strip code fences
  text = text.replace(/^```[\s\S]*?\n([\s\S]*?)```$/gm, "$1").trim();
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.slice(3, -3).trim();
  }
  // Strip leading quote/labels the model sometimes emits
  text = text.replace(/^(?:reply|response|message)\s*:\s*/i, "").trim();
  // Strip surrounding quotes
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\n{3,}/g, "\n\n");
  return text;
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
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolves user_id from Authorization. Supports:
 *  - Supabase JWT: `Bearer <jwt>`
 *  - Extension token: `Bearer ext_<token>`
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

  return extractUserIdFromJwt(token);
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function checkQuota(
  userId: string,
  period: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Response | null> {
  try {
    const url = `${supabaseUrl}/rest/v1/usage_counters?user_id=eq.${userId}&period=eq.${period}&select=emails_used,input_tokens_used,output_tokens_used`;
    const res = await fetch(url, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (
      (row.emails_used ?? 0) >= QUOTA_EMAILS_PER_MONTH ||
      (row.input_tokens_used ?? 0) >= QUOTA_INPUT_TOKENS_PER_MONTH ||
      (row.output_tokens_used ?? 0) >= QUOTA_OUTPUT_TOKENS_PER_MONTH
    ) {
      return jsonResponse(
        {
          error: `Monthly reply limit reached (${QUOTA_EMAILS_PER_MONTH} replies). Your quota resets at the start of next month.`,
          quotaExceeded: true,
        },
        429,
      );
    }
    return null;
  } catch (err) {
    console.warn("Quota check error, allowing request:", (err as Error).message);
    return null;
  }
}

function recordUsage(
  userId: string,
  period: string,
  inputTokens: number,
  outputTokens: number,
  meta: { subject: string; senderEmail: string; sourceUrl: string; decision: string; latestMessage?: string },
  supabaseUrl: string,
  serviceRoleKey: string,
) {
  const decision = meta.decision || "reply";
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  const isReply = decision === "reply";

  // Read-then-patch increment (matches draft-gmail-reply pattern)
  fetch(
    `${supabaseUrl}/rest/v1/usage_counters?user_id=eq.${userId}&period=eq.${period}&select=id,emails_used,input_tokens_used,output_tokens_used`,
    { headers },
  )
    .then(async (getRes) => {
      const rows = getRes.ok ? await getRes.json() : [];
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        await fetch(`${supabaseUrl}/rest/v1/usage_counters?id=eq.${row.id}`, {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify({
            emails_used: (row.emails_used ?? 0) + (isReply ? 1 : 0),
            input_tokens_used: (row.input_tokens_used ?? 0) + inputTokens,
            output_tokens_used: (row.output_tokens_used ?? 0) + outputTokens,
          }),
        });
      } else {
        await fetch(`${supabaseUrl}/rest/v1/usage_counters`, {
          method: "POST",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: userId,
            period,
            app_key: "whatsreply",
            emails_used: isReply ? 1 : 0,
            input_tokens_used: inputTokens,
            output_tokens_used: outputTokens,
          }),
        });
      }
    })
    .catch((err) => console.warn("Usage upsert error:", (err as Error).message));

  fetch(`${supabaseUrl}/rest/v1/reply_logs`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      period,
      subject: meta.subject?.slice(0, 300) || null,
      sender_email: meta.senderEmail?.slice(0, 320) || null,
      source_url: meta.sourceUrl?.slice(0, 2000) || null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      decision,
      latest_message: meta.latestMessage ? meta.latestMessage.slice(0, 4000) : null,
    }),
  }).catch((err) => console.warn("Reply log insert error:", (err as Error).message));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET") {
    return jsonResponse({ ok: true, function: "draft-whatsapp-reply" });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const startTime = Date.now();

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

  // --- Extract & normalize WhatsApp-shaped fields ---
  const contactName = truncate(str(body.contactName ?? body.senderName), LIMITS.contactName);
  const chatTitle = truncate(str(body.chatTitle), LIMITS.chatTitle);
  const isGroup = body.isGroup === true;
  const latestMessage = truncate(str(body.latestMessage), LIMITS.latestMessage);
  const sourceUrl = truncate(str(body.sourceUrl), LIMITS.sourceUrl);
  const identity = truncate(str(body.identity), LIMITS.identity);
  const replyStyle = truncate(str(body.replyStyle, "casual"), LIMITS.replyStyle);
  const knowledge = truncate(str(body.knowledge), LIMITS.knowledge);
  const signature = truncate(str(body.signature), LIMITS.signature);
  const extraInstructions = truncate(str(body.extraInstructions), LIMITS.extraInstructions);

  // threadMessages can be either:
  //   ["text", "text", ...]
  //   [{ from: "Name" | "me", text: "..." }, ...]
  const rawThread = Array.isArray(body.threadMessages) ? body.threadMessages : [];
  const threadMessages: string[] = rawThread
    .slice(-LIMITS.threadMaxCount)
    .map((m: unknown) => {
      if (typeof m === "string") return m.trim();
      if (m && typeof m === "object") {
        const obj = m as { from?: unknown; text?: unknown; sender?: unknown; body?: unknown };
        const from = str(obj.from ?? obj.sender);
        const text = str(obj.text ?? obj.body);
        if (!text) return "";
        return from ? `${from}: ${text}` : text;
      }
      return "";
    })
    .filter(Boolean)
    .map((m: string) => truncate(m, LIMITS.threadMessage));

  const decisionRaw = str(body.decision, "reply").toLowerCase();
  const decision = ["reply", "review", "skip"].includes(decisionRaw) ? decisionRaw : "reply";
  const period = currentPeriod();

  if (decision !== "reply") {
    console.log(`Log-only: user=${userId} decision=${decision} contact_len=${contactName.length}`);
    recordUsage(
      userId,
      period,
      0,
      0,
      { subject: chatTitle || contactName, senderEmail: contactName, sourceUrl, decision, latestMessage },
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
    );
    return jsonResponse({ ok: true, logged: true, decision });
  }

  if (!latestMessage && threadMessages.length === 0) {
    return jsonResponse(
      { error: 'Not enough content: provide "latestMessage" or at least one entry in "threadMessages".' },
      400,
    );
  }

  const quotaBlock = await checkQuota(userId, period, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (quotaBlock) return quotaBlock;

  // --- Build WhatsApp prompt ---
  const chatHeader = isGroup
    ? `WhatsApp group chat${chatTitle ? `: "${chatTitle}"` : ""}.`
    : contactName
    ? `WhatsApp 1:1 chat with ${contactName}.`
    : "WhatsApp chat.";

  const threadContext =
    threadMessages.length > 0
      ? `\n\nRecent messages (oldest first):\n${threadMessages.map((m) => `- ${m}`).join("\n")}`
      : "";

  const identityBlock = identity ? `\nYou are replying as: ${identity}` : "";
  const knowledgeBlock = knowledge ? `\nRelevant background knowledge:\n${knowledge}` : "";
  const styleBlock = `\nTone: ${replyStyle}`;
  const extraBlock = extraInstructions ? `\nAdditional instructions: ${extraInstructions}` : "";
  const signatureBlock = signature
    ? `\nIf appropriate, end with this signature on a new line: ${signature}`
    : "";

  const systemPrompt = `You are drafting a reply on WhatsApp.

Rules:
- Return ONLY the message text the user will send. No quotes, no labels like "Reply:", no markdown formatting, no code fences, no commentary.
- Match WhatsApp conventions: short, conversational, sentence-case, occasional emoji only if the existing thread uses them.
- Never invent facts, prices, dates, or commitments not present in the thread.
- Do not add a greeting if the conversation is mid-thread.
- Keep it under 3 short sentences unless the situation clearly requires more.${identityBlock}${styleBlock}${knowledgeBlock}${extraBlock}${signatureBlock}`;

  const userPrompt = `${chatHeader}${threadContext}
${latestMessage ? `\nLatest incoming message to reply to:\n${latestMessage}` : "\nDraft a reply based on the recent messages above."}

Draft the reply now.`;

  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY secret");
    return jsonResponse({ error: "Server configuration error." }, 500);
  }

  const model = "claude-sonnet-4-20250514";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    console.log(
      `WA Request: user=${userId} period=${period} contact_len=${contactName.length} latest_len=${latestMessage.length} thread_count=${threadMessages.length} style="${replyStyle}" group=${isGroup}`,
    );

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
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
      console.error(
        `Empty draft after cleanup, raw_len=${rawDraft.length} stop_reason=${anthropicData.stop_reason ?? "unknown"}`,
      );
      return jsonResponse({ error: "AI returned an empty response." }, 502);
    }

    const inputTokens = anthropicData.usage?.input_tokens ?? 0;
    const outputTokens = anthropicData.usage?.output_tokens ?? 0;

    const elapsed = Date.now() - startTime;
    console.log(
      `WA OK ${elapsed}ms user=${userId} period=${period} draft_len=${draft.length} in_tok=${inputTokens} out_tok=${outputTokens}`,
    );

    recordUsage(
      userId,
      period,
      inputTokens,
      outputTokens,
      { subject: chatTitle || contactName, senderEmail: contactName, sourceUrl, decision: "reply", latestMessage },
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
    );

    return jsonResponse({ draft, model, inputTokens, outputTokens });
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
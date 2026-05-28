import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

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
  chatTitle: 200,
  providerLabel: 100,
};

// Media understanding limits
const MEDIA_LIMITS = {
  maxItems: 6,
  maxBytesPerItem: 8 * 1024 * 1024, // 8 MB
  maxTotalBytes: 20 * 1024 * 1024,  // 20 MB combined
  perItemTimeoutMs: 20_000,
  annotationMaxLen: 1500,
};
const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
]);
const ALLOWED_AUDIO_MIME = new Set([
  "audio/ogg", "audio/oga", "audio/mpeg", "audio/mp3", "audio/mp4",
  "audio/m4a", "audio/x-m4a", "audio/wav", "audio/webm", "audio/aac", "audio/flac",
]);

function logWhisperInvocation(row: {
  userId?: string;
  provider?: string;
  mimeType?: string;
  status: "success" | "error" | "empty";
  chars?: number;
  durationMs?: number;
  error?: string;
  transcript?: string;
}) {
  // Fire-and-forget insert; do not log audio content or transcripts.
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    fetch(`${url}/rest/v1/whisper_invocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: row.userId ?? null,
        provider: row.provider ?? null,
        mime_type: row.mimeType ?? null,
        status: row.status,
        chars: row.chars ?? null,
        duration_ms: row.durationMs ?? null,
        error: row.error ?? null,
        transcript: row.transcript ?? null,
      }),
    }).catch(() => {});
  } catch {
    // ignore
  }
}

const QUOTA_EMAILS_PER_MONTH = 500;
const QUOTA_INPUT_TOKENS_PER_MONTH = 2_000_000;
const QUOTA_OUTPUT_TOKENS_PER_MONTH = 500_000;
const ANTHROPIC_TIMEOUT_MS = 30_000;

const ALLOWED_REVIEW_REASONS = new Set([
  "automated_system",
  "menu_bot",
  "broadcast_or_notification",
  "missing_context",
  "sensitive_request",
  "needs_human_judgment",
  "no_reply",
]);

const REFUSAL_REGEX =
  /(i\s+(should|cannot|can'?t|won'?t)\s+(draft|reply|respond|provide))|(this\s+(appears|seems)\s+to\s+be\s+(an\s+)?(automated|system|bot))|(no\s+(visible\s+)?options\s+to\s+respond)|(cannot\s+generate\s+(a\s+)?reply)|(as\s+an\s+ai)/i;

function clampReason(r: string): string {
  return ALLOWED_REVIEW_REASONS.has(r) ? r : "needs_human_judgment";
}

function looksLikeRefusal(s: string): boolean {
  return REFUSAL_REGEX.test(s);
}

// WhatsApp voice messages arrive from the extension as just the bidi-wrapped
// duration (e.g. "‪0:05‬"). Normalize to "[Voice message 0:05]" so the
// dashboard activity panel can render a meaningful preview.
const VOICE_DURATION_REGEX = /^\s*[\u202a-\u202e\u2066-\u2069]*\d{1,2}:\d{2}[\u202a-\u202e\u2066-\u2069]*\s*$/;
function normalizeLatestMessage(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (VOICE_DURATION_REGEX.test(trimmed)) {
    const duration = trimmed.replace(/[\u202a-\u202e\u2066-\u2069]/g, "").trim();
    return `[Voice message ${duration}]`;
  }
  return trimmed.slice(0, 4000);
}

function tryParseModelJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)```$/i, "$1").trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Try to extract the first {...} block
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // fallthrough
      }
    }
  }
  return null;
}

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
  if (text.startsWith("```") && text.endsWith("```")) text = text.slice(3, -3).trim();
  text = text.replace(/^(?:reply|response|message)\s*:\s*/i, "").trim();
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

// ------- Media understanding ----------

type MediaInput = {
  key?: string;
  dataId?: string;
  kind: "image" | "audio";
  from?: string;
  direction?: string;
  text?: string;
  caption?: string;
  mediaLabel?: string;
  fileName?: string;
  durationSec?: number;
  mimeType: string;
  dataUrl: string;
  byteLength?: number;
};

type MediaAnnotation = {
  key?: string;
  dataId?: string;
  text?: string;
  annotation: string;
  kind?: "image" | "audio";
  understood?: string;
  mediaLabel?: string;
  mimeType?: string;
};

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+)(?:;[^,]*)?,(.+)$/i.exec(dataUrl ?? "");
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const payload = m[2];
  // We expect base64; if no ;base64 marker, bail (URL-encoded media is not supported).
  if (!/;base64,/i.test(dataUrl)) return null;
  return { mime, base64: payload };
}

function sanitizeMediaInputs(raw: unknown): MediaInput[] {
  if (!Array.isArray(raw)) return [];
  const out: MediaInput[] = [];
  let totalBytes = 0;
  for (const item of raw) {
    if (out.length >= MEDIA_LIMITS.maxItems) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = String(o.kind ?? "").toLowerCase();
    if (kind !== "image" && kind !== "audio") continue;
    const mimeType = String(o.mimeType ?? "").toLowerCase();
    const dataUrl = typeof o.dataUrl === "string" ? o.dataUrl : "";
    if (!dataUrl) continue;
    if (kind === "image" && !ALLOWED_IMAGE_MIME.has(mimeType)) continue;
    if (kind === "audio" && !ALLOWED_AUDIO_MIME.has(mimeType)) continue;

    const parsed = parseDataUrl(dataUrl);
    if (!parsed) continue;
    // Approximate decoded size from base64 length.
    const approxBytes = Math.floor((parsed.base64.length * 3) / 4);
    if (approxBytes > MEDIA_LIMITS.maxBytesPerItem) continue;
    if (totalBytes + approxBytes > MEDIA_LIMITS.maxTotalBytes) break;
    totalBytes += approxBytes;

    out.push({
      key: typeof o.key === "string" ? o.key.slice(0, 200) : undefined,
      dataId: typeof o.dataId === "string" ? o.dataId.slice(0, 200) : undefined,
      kind: kind as "image" | "audio",
      from: typeof o.from === "string" ? o.from.slice(0, 200) : undefined,
      direction: typeof o.direction === "string" ? o.direction.slice(0, 32) : undefined,
      text: typeof o.text === "string" ? o.text.slice(0, 500) : undefined,
      caption: typeof o.caption === "string" ? o.caption.slice(0, 500) : undefined,
      mediaLabel: typeof o.mediaLabel === "string" ? o.mediaLabel.slice(0, 200) : undefined,
      fileName: typeof o.fileName === "string" ? o.fileName.slice(0, 200) : undefined,
      durationSec: typeof o.durationSec === "number" ? o.durationSec : undefined,
      mimeType,
      dataUrl,
    });
  }
  return out;
}

async function understandMediaItem(
  item: MediaInput,
  lovableApiKey: string,
  anthropicApiKey: string | null,
  ctx?: { userId?: string; provider?: string },
): Promise<string | null> {
  const parsed = parseDataUrl(item.dataUrl);
  if (!parsed) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_LIMITS.perItemTimeoutMs);
  try {
    if (item.kind === "image") {
      // Images go through Anthropic (Claude) for highest fidelity vision + OCR.
      if (!anthropicApiKey) {
        console.warn("ANTHROPIC_API_KEY missing; skipping image understanding");
        return null;
      }
      const instruction = "Describe this image factually in 1-3 short sentences. If there is readable text (a receipt, screenshot, sign, document, etc.), transcribe the important text verbatim under an 'OCR:' line. Do not speculate about people. No preamble.";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 600,
          system: "You extract information from images for a downstream reply-drafting assistant. Be concise and factual.",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: parsed.mime, data: parsed.base64 },
                },
                { type: "text", text: instruction },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`anthropic image understanding failed mime=${item.mimeType} status=${res.status}`);
        return null;
      }
      const data = await res.json();
      const text = data?.content?.[0]?.text;
      if (typeof text !== "string" || !text.trim()) return null;
      return truncate(text.trim(), MEDIA_LIMITS.annotationMaxLen);
    }

    // Audio: transcribe via OpenAI Whisper.
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
    if (!openaiApiKey) {
      console.warn("OPENAI_API_KEY missing; skipping audio transcription");
      return null;
    }
    const whisperStart = Date.now();
    // Decode base64 to bytes
    const binary = atob(parsed.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ext = (parsed.mime.split("/")[1] || "ogg").split(";")[0];
    const filename = `audio.${ext === "mpeg" ? "mp3" : ext}`;
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: parsed.mime }), filename);
    form.append("model", "whisper-1");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiApiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`whisper audio transcription failed mime=${item.mimeType} status=${res.status}`);
      logWhisperInvocation({
        userId: ctx?.userId,
        provider: ctx?.provider,
        mimeType: item.mimeType,
        status: "error",
        durationMs: Date.now() - whisperStart,
        error: `http_${res.status}`,
      });
      return null;
    }
    const data = await res.json();
    const text = data?.text;
    if (typeof text !== "string" || !text.trim()) {
      logWhisperInvocation({
        userId: ctx?.userId,
        provider: ctx?.provider,
        mimeType: item.mimeType,
        status: "empty",
        durationMs: Date.now() - whisperStart,
      });
      return null;
    }
    console.info(`whisper audio transcription succeeded mime=${item.mimeType} chars=${text.trim().length}`);
    logWhisperInvocation({
      userId: ctx?.userId,
      provider: ctx?.provider,
      mimeType: item.mimeType,
      status: "success",
      chars: text.trim().length,
      durationMs: Date.now() - whisperStart,
      transcript: text.trim(),
    });
    return truncate(text.trim(), MEDIA_LIMITS.annotationMaxLen);
  } catch (e) {
    console.warn(`media understanding error kind=${item.kind} mime=${item.mimeType}: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildMediaAnnotations(
  items: MediaInput[],
  ctx?: { userId?: string; provider?: string },
): Promise<MediaAnnotation[]> {
  if (items.length === 0) return [];
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY") ?? "";
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const openaiApiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!anthropicApiKey && !openaiApiKey) {
    console.warn("No media-understanding API keys configured; skipping");
    return [];
  }
  const results = await Promise.all(items.map(async (item) => {
    const label = item.kind === "image"
      ? (item.mediaLabel || "Image")
      : (item.mediaLabel || (item.durationSec ? `Voice message ${Math.floor(item.durationSec / 60)}:${String(item.durationSec % 60).padStart(2, "0")}` : "Voice message"));
    const understood = await understandMediaItem(item, lovableApiKey, anthropicApiKey || null, ctx);
    if (!understood) return null;
    const header = item.kind === "image"
      ? `[Image] ${label}`
      : `[${label}]`;
    const captionLine = item.caption ? `\nCaption: ${item.caption}` : "";
    const body = item.kind === "image"
      ? `Visual summary: ${understood}`
      : `Transcript: ${understood}`;
    const fromPrefix = item.from ? `${item.from}: ` : "";
    const annotation = truncate(
      `${fromPrefix}${header}${captionLine}\n${body}`,
      MEDIA_LIMITS.annotationMaxLen,
    );
    return {
      key: item.key,
      dataId: item.dataId,
      text: item.text,
      annotation,
      kind: item.kind,
      understood,
      mediaLabel: label,
      mimeType: item.mimeType,
    } as MediaAnnotation;
  }));
  return results.filter((r): r is MediaAnnotation => r !== null);
}

function mergeAnnotationsIntoThread(
  thread: string[],
  annotations: MediaAnnotation[],
): { thread: string[]; leftover: MediaAnnotation[] } {
  if (annotations.length === 0) return { thread, leftover: [] };
  const used = new Set<number>();
  const out = [...thread];
  const leftover: MediaAnnotation[] = [];
  for (const ann of annotations) {
    let matched = -1;
    if (ann.text) {
      for (let i = 0; i < out.length; i++) {
        if (used.has(i)) continue;
        if (out[i].includes(ann.text)) { matched = i; break; }
      }
    }
    if (matched >= 0) {
      used.add(matched);
      out[matched] = truncate(`${out[matched]}\n  ↳ ${ann.annotation.replace(/\n/g, "\n     ")}`, LIMITS.threadMessage + MEDIA_LIMITS.annotationMaxLen);
    } else {
      leftover.push(ann);
    }
  }
  return { thread: out, leftover };
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
  meta: { subject: string; senderEmail: string; sourceUrl: string; decision: string; appKey: string; latestMessage?: string },
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
            app_key: meta.appKey,
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
      latest_message: normalizeLatestMessage(meta.latestMessage),
    }),
  }).catch((err) => console.warn("Reply log insert error:", (err as Error).message));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET") {
    return jsonResponse({ ok: true, function: "draft-reply" });
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

  // --- Extension body shape:
  // { provider, providerLabel, chatTitle, latestMessage, messages, instructions, replySettings }
  const provider = str(body.provider, "whatsapp").toLowerCase();
  const providerLabel = truncate(str(body.providerLabel, provider), LIMITS.providerLabel);
  const threadObj =
    body.thread && typeof body.thread === "object" && !Array.isArray(body.thread)
      ? (body.thread as Record<string, unknown>)
      : {};
  const threadId = truncate(str(body.threadId ?? body.thread_id ?? threadObj.threadId ?? threadObj.id), 300);
  const chatTitle = truncate(str(body.chatTitle ?? threadObj.chatTitle ?? threadObj.subject), LIMITS.chatTitle);
  const latestMessage = truncate(str(body.latestMessage), LIMITS.latestMessage);
  let sourceUrl = truncate(str(body.sourceUrl ?? threadObj.sourceUrl ?? threadObj.thread_url), 2000);
  let contactName = truncate(
    str(body.contactName ?? body.senderName ?? body.sender ?? threadObj.sender ?? threadObj.contactName),
    LIMITS.chatTitle,
  );
  let senderEmail = truncate(
    str(body.senderEmail ?? body.contactName ?? body.senderName ?? threadObj.sender),
    320,
  );
  let subjectField = truncate(
    str(body.subject ?? body.chatTitle ?? body.contactName ?? threadObj.subject ?? threadObj.chatTitle),
    300,
  );

  // Fallback: if extension didn't include metadata (common for voice-message review pings),
  // hydrate from thread_states by threadId.
  if (threadId && (!subjectField || !senderEmail || !sourceUrl)) {
    try {
      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/thread_states?user_id=eq.${userId}&thread_id=eq.${encodeURIComponent(threadId)}&provider=eq.${encodeURIComponent(provider)}&select=sender,subject,source_url,thread_url&limit=1`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );
      if (lookupRes.ok) {
        const rows = (await lookupRes.json()) as Array<{
          sender?: string;
          subject?: string;
          source_url?: string;
          thread_url?: string;
        }>;
        const r = rows?.[0];
        if (r) {
          if (!subjectField) subjectField = truncate(str(r.subject ?? r.sender), 300);
          if (!senderEmail) senderEmail = truncate(str(r.sender), 320);
          if (!sourceUrl) sourceUrl = truncate(str(r.source_url ?? r.thread_url), 2000);
          if (!contactName) contactName = truncate(str(r.sender), LIMITS.chatTitle);
        }
      }
    } catch (e) {
      console.warn("thread_states hydrate failed:", (e as Error).message);
    }
  }

  // Debug: log presence of metadata fields so we can confirm extension payload.
  console.log(
    `draft-reply payload-meta provider=${str(body.provider)} threadId_len=${threadId.length} keys=[${Object.keys(body).join(",")}] chatTitle_len=${chatTitle.length} contactName_len=${contactName.length} sourceUrl_len=${sourceUrl.length} subject_len=${subjectField.length} senderEmail_len=${senderEmail.length}`,
  );

  const replySettings =
    body.replySettings && typeof body.replySettings === "object" && !Array.isArray(body.replySettings)
      ? (body.replySettings as Record<string, unknown>)
      : {};
  const identity = truncate(str(replySettings.identity ?? body.identity), LIMITS.identity);
  const replyStyle = truncate(
    str(replySettings.replyStyle ?? replySettings.tone ?? body.replyStyle, "casual"),
    LIMITS.replyStyle,
  );
  const knowledge = truncate(str(replySettings.knowledge ?? body.knowledge), LIMITS.knowledge);
  const signature = truncate(str(replySettings.signature ?? body.signature), LIMITS.signature);
  const extraInstructions = truncate(
    str(body.instructions ?? replySettings.extraInstructions ?? body.extraInstructions),
    LIMITS.extraInstructions,
  );

  // messages: same shape as draft-whatsapp-reply threadMessages
  const rawThread = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.threadMessages)
    ? body.threadMessages
    : [];
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
  const appKey = provider === "whatsapp" ? "whatsreply" : provider || "whatsreply";

  if (decision !== "reply") {
    const reviewSummary = truncate(str(body.reviewSummary), 500);
    const reviewReason = truncate(str(body.reviewReason), 100);
    console.log(
      `draft-reply log-only user=${userId} decision=${decision} provider=${provider} reason="${reviewReason}"`,
    );
    recordUsage(
      userId,
      period,
      0,
      0,
      { subject: subjectField || chatTitle, senderEmail: senderEmail || chatTitle, sourceUrl, decision, appKey, latestMessage },
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
    );
    // Fallback: ensure the dashboard sees this flagged thread even if the
    // extension skips its sync-thread-state call (e.g. token expired, thread
    // not in local state). Upsert a minimal thread_states row mirroring what
    // sync-thread-state would have written for a `review_flagged` event.
    if (userId && threadId && decision === "review") {
      const nowIso = new Date().toISOString();
      const upsertBody: Record<string, unknown> = {
        user_id: userId,
        provider,
        thread_id: threadId,
        subject: subjectField || chatTitle || null,
        sender: contactName || null,
        latest_message: latestMessage || null,
        preview: latestMessage || null,
        source_url: sourceUrl || null,
        status_value: "review_ready",
        backend_decision: "review",
        review_reason: reviewReason || "needs_human_judgment",
        review_summary: reviewSummary || "Flagged for human review.",
        review_active: true,
        review_opened_at: nowIso,
        review_resolved_at: null,
        last_event_type: "review_flagged",
        last_event_at: nowIso,
        source: "draft-reply-fallback",
      };
      fetch(
        `${SUPABASE_URL}/rest/v1/thread_states?on_conflict=user_id,provider,thread_id`,
        {
          method: "POST",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify([upsertBody]),
        },
      ).catch((e) =>
        console.warn("draft-reply fallback thread_states upsert failed:", (e as Error).message),
      );
    }
    if (decision === "review") {
      return jsonResponse({
        decision: "review",
        reviewSummary: reviewSummary || "Flagged for human review.",
        reviewReason: reviewReason || "unclear",
      });
    }
    // skip
    return jsonResponse({
      decision: "skip",
      reviewSummary,
      reviewReason,
    });
  }

  if (!latestMessage && threadMessages.length === 0) {
    return jsonResponse(
      { error: 'Not enough content: provide "latestMessage" or at least one entry in "messages".' },
      400,
    );
  }

  const quotaBlock = await checkQuota(userId, period, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (quotaBlock) return quotaBlock;

  // ---- Media understanding (optional, best-effort) ----
  const mediaInputs = sanitizeMediaInputs(body.mediaInputs);
  let augmentedThread = threadMessages;
  let augmentedLatest = latestMessage;
  let mediaAnnotationsCount = 0;
  let mediaAnnotationsAll: MediaAnnotation[] = [];
  if (mediaInputs.length > 0) {
    try {
      const annotations = await buildMediaAnnotations(mediaInputs, { userId, provider });
      mediaAnnotationsCount = annotations.length;
      mediaAnnotationsAll = annotations;
      if (annotations.length > 0) {
        const merged = mergeAnnotationsIntoThread(threadMessages, annotations);
        augmentedThread = merged.thread;
        // For unmatched annotations, append them as additional context lines
        // and, if the latest message is a placeholder like "[Image]" / "[Voice message ...]",
        // promote the most recent annotation into augmentedLatest so the model has substance to reply to.
        const placeholderLatest = /^\s*\[(image|voice message|audio|video|sticker|document)\b/i.test(latestMessage);
        if (merged.leftover.length > 0) {
          augmentedThread = [
            ...augmentedThread,
            ...merged.leftover.map((a) => truncate(a.annotation, LIMITS.threadMessage + MEDIA_LIMITS.annotationMaxLen)),
          ];
        }
        if (placeholderLatest) {
          const last = annotations[annotations.length - 1];
          augmentedLatest = truncate(
            `${latestMessage}\n${last.annotation}`,
            LIMITS.latestMessage + MEDIA_LIMITS.annotationMaxLen,
          );
        }
      }
    } catch (e) {
      console.warn("media understanding pipeline failed, continuing text-only:", (e as Error).message);
    }
  }

  const chatHeader = chatTitle
    ? `${providerLabel} chat: "${chatTitle}".`
    : `${providerLabel} chat.`;
  const threadContext =
    augmentedThread.length > 0
      ? `\n\nRecent messages (oldest first):\n${augmentedThread.map((m) => `- ${m}`).join("\n")}`
      : "";
  const identityBlock = identity ? `\nYou are replying as: ${identity}` : "";
  const knowledgeBlock = knowledge ? `\nRelevant background knowledge:\n${knowledge}` : "";
  const styleBlock = `\nTone: ${replyStyle}`;
  const extraBlock = extraInstructions ? `\nAdditional instructions: ${extraInstructions}` : "";
  const signatureBlock = signature
    ? `\nIf appropriate, end with this signature on a new line: ${signature}`
    : "";

  const systemPrompt = `You are an assistant that decides whether to draft a reply on ${providerLabel}, and if so, drafts it.

Return ONE JSON object only. No markdown, no code fences, no commentary outside the JSON. It MUST match exactly one of:

  { "decision": "reply",  "draft": "<message text>" }
  { "decision": "review", "reviewReason": "<snake_case>", "reviewSummary": "<short sentence>" }
  { "decision": "skip",   "reviewReason": "<snake_case>", "reviewSummary": "<short sentence>" }

Choose "review" or "skip" (NOT "reply") when the latest incoming message is:
- automated, menu-driven, OTP, or a bot prompt        -> "menu_bot" or "automated_system"
- a broadcast / notification / system message         -> "broadcast_or_notification"
- missing context to safely respond                   -> "missing_context"
- sensitive (legal, medical, financial advice, etc.)  -> "sensitive_request"
- something that needs human judgment                 -> "needs_human_judgment"
- a thread where no reply is appropriate              -> "no_reply"

If decision is "reply":
- "draft" is ONLY the message text the user will send. No quotes, no labels like "Reply:", no markdown, no commentary.
- Match ${providerLabel} conventions: short, conversational, sentence-case, occasional emoji only if the existing thread uses them.
- Never invent facts, prices, dates, or commitments not present in the thread.
- Do not add a greeting if the conversation is mid-thread.
- Keep it under 3 short sentences unless the situation clearly requires more.
- Never put refusal or explanation text into "draft". If you would refuse, return decision "review" instead with an appropriate reviewReason.${identityBlock}${styleBlock}${knowledgeBlock}${extraBlock}${signatureBlock}`;

  const userPrompt = `${chatHeader}${threadContext}
${augmentedLatest ? `\nLatest incoming message to reply to:\n${augmentedLatest}` : "\nDraft a reply based on the recent messages above."}

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
      `draft-reply Request: user=${userId} provider=${provider} period=${period} latest_len=${latestMessage.length} thread_count=${threadMessages.length} media_in=${mediaInputs.length} media_ok=${mediaAnnotationsCount} style="${replyStyle}"`,
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
    const rawText = anthropicData.content?.[0]?.text ?? "";
    const inputTokens = anthropicData.usage?.input_tokens ?? 0;
    const outputTokens = anthropicData.usage?.output_tokens ?? 0;
    const elapsed = Date.now() - startTime;

    // Resolve final decision payload
    let finalDecision: "reply" | "review" | "skip" = "reply";
    let finalDraft = "";
    let finalReason = "";
    let finalSummary = "";

    const parsed = tryParseModelJson(rawText);
    if (parsed) {
      const dRaw = String(parsed.decision ?? "").toLowerCase();
      if (dRaw === "reply" || dRaw === "review" || dRaw === "skip") {
        finalDecision = dRaw;
      } else {
        finalDecision = "review";
        finalReason = "needs_human_judgment";
        finalSummary = "Model returned an unexpected decision; please review.";
      }
      if (finalDecision === "reply") {
        finalDraft = cleanDraft(String(parsed.draft ?? ""));
        if (!finalDraft || looksLikeRefusal(finalDraft)) {
          finalDecision = "review";
          finalReason = "automated_system";
          finalSummary = "Automated or menu-driven message; do not auto-reply.";
          finalDraft = "";
        }
      } else {
        finalReason = clampReason(String(parsed.reviewReason ?? "").toLowerCase());
        finalSummary = truncate(String(parsed.reviewSummary ?? finalSummary ?? ""), 500) ||
          (finalDecision === "skip" ? "Message should not be auto-replied." : "Flagged for human review.");
      }
    } else {
      // Model didn't return JSON. Treat raw as a candidate draft.
      const candidate = cleanDraft(rawText);
      if (!candidate) {
        console.error(
          `Empty draft after cleanup, raw_len=${rawText.length} stop_reason=${anthropicData.stop_reason ?? "unknown"}`,
        );
        return jsonResponse({ error: "AI returned an empty response." }, 502);
      }
      if (looksLikeRefusal(candidate)) {
        finalDecision = "review";
        finalReason = "automated_system";
        finalSummary = "Automated or menu-driven message; do not auto-reply.";
      } else {
        finalDecision = "reply";
        finalDraft = candidate;
      }
    }

    console.log(
      `draft-reply OK ${elapsed}ms user=${userId} provider=${provider} decision=${finalDecision} draft_len=${finalDraft.length} reason="${finalReason}" in_tok=${inputTokens} out_tok=${outputTokens}`,
    );

    recordUsage(
      userId,
      period,
      inputTokens,
      outputTokens,
      { subject: subjectField || chatTitle, senderEmail: senderEmail || chatTitle, sourceUrl, decision: finalDecision, appKey, latestMessage },
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
    );

    const mediaTranscripts = mediaAnnotationsAll
      .filter((a) => a.kind === "audio" && a.understood)
      .map((a) => ({
        key: a.key,
        dataId: a.dataId,
        mediaLabel: a.mediaLabel,
        mimeType: a.mimeType,
        transcript: a.understood,
      }));
    const mediaAnnotationsOut = mediaAnnotationsAll.map((a) => ({
      key: a.key,
      dataId: a.dataId,
      kind: a.kind,
      mediaLabel: a.mediaLabel,
      mimeType: a.mimeType,
      annotation: a.annotation,
    }));

    if (finalDecision === "reply") {
      return jsonResponse({ decision: "reply", draft: finalDraft, model, inputTokens, outputTokens, mediaTranscripts, mediaAnnotations: mediaAnnotationsOut });
    }
    return jsonResponse({
      decision: finalDecision,
      reviewReason: finalReason,
      reviewSummary: finalSummary,
      model,
      inputTokens,
      outputTokens,
      mediaTranscripts,
      mediaAnnotations: mediaAnnotationsOut,
    });
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
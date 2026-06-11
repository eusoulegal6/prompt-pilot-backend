import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-idempotency-key, x-payload-sha256, x-schema-version",
  "Access-Control-Max-Age": "86400",
};

const ALLOWED_EVENTS = new Set([
  "chat_snapshot",
  "chat_scanned",
  "chat_message_delta",
]);

const ALLOWED_STATUS = new Set([
  "queued",
  "drafting",
  "drafted",
  "review_ready",
  "sending",
  "sent",
  "skipped",
  "error",
]);

const ALLOWED_BACKEND_DECISIONS = new Set(["reply", "review", "skip", ""]);

const LIMITS = {
  threadId: 400,
  text: 1000,
  preview: 1200,
  url: 2000,
  short: 200,
  reason: 100,
  summary: 500,
  error: 1000,
  msgKey: 400,
};

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
  return s.length > max ? s.slice(0, max) : s;
}

function bool(v: unknown): boolean {
  return v === true;
}

// Derive a display name from a thread_id when the client didn't send one.
// Examples:
//   "whatsapp:assistente picpay|https://…avatar.jpg" -> "assistente picpay"
//   "whatsapp:+55 22 98134-0128|https://…"            -> "+55 22 98134-0128"
//   "Maria"                                            -> "Maria"
//   "12345@c.us"                                       -> "12345"
function deriveSenderFromThreadId(threadId: string): string {
  let s = (threadId || "").trim();
  if (!s) return "";
  // strip provider prefix
  s = s.replace(/^(whatsapp|gmail|imessage|telegram|instagram|messenger):/i, "");
  // take the part before the avatar URL separator
  const pipe = s.indexOf("|");
  if (pipe >= 0) s = s.slice(0, pipe);
  // strip jid suffixes like @c.us / @lid / @s.whatsapp.net
  s = s.replace(/@[\w.]+$/, "");
  return s.trim();
}

function isoOrNull(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

// --- Whisper transcription for ptt voice notes -------------------------
// Fire-and-forget: don't block the sync pipeline. Decode the data URL,
// POST to OpenAI Whisper, then PATCH the scan_messages row.
const VOICE_DATA_URL_RE = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i;

function decodeVoiceDataUrl(
  dataUrl: string,
): { bytes: Uint8Array; mimeType: string } | null {
  const m = VOICE_DATA_URL_RE.exec(dataUrl.trim());
  if (!m) return null;
  const mimeType = m[1] || "audio/ogg";
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mimeType };
  } catch {
    return null;
  }
}

function filenameForMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("ogg")) return "voice.ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "voice.mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "voice.m4a";
  if (m.includes("wav")) return "voice.wav";
  if (m.includes("webm")) return "voice.webm";
  return "voice.ogg";
}

async function transcribeAndStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  openaiKey: string,
  scanMessageId: string,
  threadId: string,
  voiceBlob: Record<string, unknown>,
): Promise<void> {
  const dataUrl = typeof voiceBlob.dataUrl === "string" ? voiceBlob.dataUrl : "";
  if (!dataUrl) return;
  const decoded = decodeVoiceDataUrl(dataUrl);
  if (!decoded || decoded.bytes.byteLength === 0) return;

  const declaredMime = typeof voiceBlob.mimeType === "string" && voiceBlob.mimeType
    ? (voiceBlob.mimeType as string)
    : decoded.mimeType;
  const filename = filenameForMime(declaredMime);

  const form = new FormData();
  form.append(
    "file",
    new Blob([decoded.bytes], { type: declaredMime }),
    filename,
  );
  form.append("model", "whisper-1");
  form.append("response_format", "text");

  let transcription = "";
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      console.warn(
        `whisper transcription failed status=${res.status} thread=${threadId} body=${errText}`,
      );
      return;
    }
    transcription = (await res.text()).trim();
  } catch (e) {
    console.warn(`whisper fetch error: ${(e as Error).message}`);
    return;
  }
  if (!transcription) return;

  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/scan_messages?id=eq.${scanMessageId}&transcription=is.null`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ transcription }),
    },
  );
  if (!patchRes.ok) {
    console.warn(
      `transcription patch failed status=${patchRes.status} id=${scanMessageId}`,
    );
  }
}

function scheduleTranscriptions(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  threadId: string,
  candidates: { messageId: string; voiceBlob: Record<string, unknown> }[],
): void {
  if (candidates.length === 0) return;
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    console.warn("OPENAI_API_KEY not configured; skipping voice transcription");
    return;
  }

  const task = (async () => {
    // Look up DB ids + current transcription state to honor the dedup rule.
    const ids = candidates.map((c) => c.messageId);
    const inList = ids.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(",");
    const lookupUrl =
      `${supabaseUrl}/rest/v1/scan_messages?user_id=eq.${userId}` +
      `&thread_id=eq.${encodeURIComponent(threadId)}` +
      `&message_id=in.(${encodeURIComponent(inList)})` +
      `&select=id,message_id,transcription`;
    const r = await fetch(lookupUrl, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!r.ok) {
      console.warn(`transcription lookup failed status=${r.status}`);
      return;
    }
    const rows = await r.json();
    if (!Array.isArray(rows)) return;
    const byMessageId = new Map<string, { id: string; transcription: string | null }>();
    for (const row of rows) {
      if (row && typeof row.message_id === "string" && typeof row.id === "string") {
        byMessageId.set(row.message_id, { id: row.id, transcription: row.transcription ?? null });
      }
    }
    for (const c of candidates) {
      const target = byMessageId.get(c.messageId);
      if (!target) continue;
      if (target.transcription && target.transcription.length > 0) continue; // dedup
      try {
        await transcribeAndStore(
          supabaseUrl,
          serviceRoleKey,
          openaiKey,
          target.id,
          threadId,
          c.voiceBlob,
        );
      } catch (e) {
        console.warn(`transcription task error: ${(e as Error).message}`);
      }
    }
  })();

  // Deno Deploy / Supabase Edge Runtime: keep the task alive after response.
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(task);
  } else {
    task.catch((e) => console.warn(`transcription task rejected: ${(e as Error).message}`));
  }
}
// ------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Canonical JSON for hash verification (json-sort-v1):
// - recursively sort object keys lexicographically
// - preserve array order
// - compact stringify (no whitespace)
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = canonicalize(obj[k]);
    return out;
  }
  return value;
}

async function computePayloadHash(body: Record<string, unknown>): Promise<string> {
  // Clone shallowly + strip the two hash fields per the contract.
  const clone: Record<string, unknown> = { ...body };
  delete clone.payloadSha256;
  if (clone.integrity && typeof clone.integrity === "object" && !Array.isArray(clone.integrity)) {
    const integrity = { ...(clone.integrity as Record<string, unknown>) };
    delete integrity.payloadSha256;
    clone.integrity = integrity;
  }
  return await sha256Hex(JSON.stringify(canonicalize(clone)));
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
      if (!res.ok) return null;
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
      }).catch(() => {});
      return row.user_id ?? null;
    } catch {
      return null;
    }
  }

  return extractUserIdFromJwt(token);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET") {
    return jsonResponse({ ok: true, function: "sync-thread-state" });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ ok: false, error: "Server configuration error." }, 500);
  }

  const userId = await resolveUserId(req, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!userId) {
    return jsonResponse({ ok: false, error: "Authentication required." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
    }
    body = raw as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const eventType = str(body.eventType);
  if (!ALLOWED_EVENTS.has(eventType)) {
    return jsonResponse({ ok: false, error: "Invalid eventType." }, 400);
  }

  // --- Integrity contract v2 ---------------------------------------------
  const headerHash = (req.headers.get("x-payload-sha256") || "").trim().toLowerCase();
  const headerEventId = (req.headers.get("x-idempotency-key") || "").trim();
  const headerSchemaVersion = parseInt(req.headers.get("x-schema-version") || "", 10);

  const schemaVersion = typeof body.schemaVersion === "number"
    ? (body.schemaVersion as number)
    : (Number.isFinite(headerSchemaVersion) ? headerSchemaVersion : 0);
  const eventId = truncate(str(body.eventId) || headerEventId, 200);
  const scanId = truncate(str(body.scanId), 200);
  const bodyHash = str(body.payloadSha256).toLowerCase();
  const integrityObj = (body.integrity && typeof body.integrity === "object" && !Array.isArray(body.integrity))
    ? (body.integrity as Record<string, unknown>)
    : null;
  const integrityHash = integrityObj ? str(integrityObj.payloadSha256).toLowerCase() : "";

  const isV2 = schemaVersion >= 2 || Boolean(bodyHash) || Boolean(eventId);
  let verified = false;
  let computedHash = "";

  if (isV2) {
    if (!eventId) {
      return jsonResponse({ ok: false, error: "eventId is required for schemaVersion>=2." }, 400);
    }
    if (!bodyHash) {
      return jsonResponse({ ok: false, error: "payloadSha256 is required for schemaVersion>=2." }, 400);
    }
    if (integrityHash && integrityHash !== bodyHash) {
      return jsonResponse({ ok: false, error: "integrity.payloadSha256 does not match payloadSha256." }, 400);
    }
    if (headerHash && headerHash !== bodyHash) {
      return jsonResponse({ ok: false, error: "x-payload-sha256 header does not match payloadSha256." }, 400);
    }
    try {
      computedHash = await computePayloadHash(body);
    } catch (e) {
      console.error("hash compute failed:", (e as Error).message);
      return jsonResponse({ ok: false, error: "Failed to verify payload hash." }, 400);
    }
    if (computedHash !== bodyHash) {
      return jsonResponse({
        ok: false,
        error: "Computed payload hash does not match payloadSha256.",
        expected: bodyHash,
        computed: computedHash,
      }, 400);
    }
    if (headerEventId && headerEventId !== eventId) {
      return jsonResponse({ ok: false, error: "x-idempotency-key does not match body eventId." }, 400);
    }
    verified = true;
  } else {
    console.log("sync-thread-state legacy_unverified event received (no schemaVersion/payloadSha256)");
  }
  // ------------------------------------------------------------------------

  const provider = str(body.provider, "whatsapp").toLowerCase() || "whatsapp";
  const queueScope = str(body.queueScope, "all");
  const extensionVersion = truncate(str(body.extensionVersion), LIMITS.short);
  const source = truncate(str(body.source, "chrome-extension"), LIMITS.short);
  const occurredAt = isoOrNull(body.occurredAt) ?? new Date().toISOString();

  const thread = (body.thread && typeof body.thread === "object" && !Array.isArray(body.thread))
    ? (body.thread as Record<string, unknown>)
    : {};
  const status = (body.status && typeof body.status === "object" && !Array.isArray(body.status))
    ? (body.status as Record<string, unknown>)
    : {};
  const snapshot = (body.snapshot && typeof body.snapshot === "object" && !Array.isArray(body.snapshot))
    ? (body.snapshot as Record<string, unknown>)
    : null;
  const scan = (body.scan && typeof body.scan === "object" && !Array.isArray(body.scan))
    ? (body.scan as Record<string, unknown>)
    : null;
  const delta = (body.delta && typeof body.delta === "object" && !Array.isArray(body.delta))
    ? (body.delta as Record<string, unknown>)
    : null;

  if (eventType === "chat_snapshot" && !snapshot) {
    return jsonResponse({ ok: false, error: "snapshot is required for chat_snapshot events." }, 400);
  }
  if (eventType === "chat_scanned") {
    if (!scan) {
      return jsonResponse({ ok: false, error: "scan is required for chat_scanned events." }, 400);
    }
    if (!Array.isArray(scan.messages)) {
      return jsonResponse({ ok: false, error: "scan.messages must be an array." }, 400);
    }
  }
  if (eventType === "chat_message_delta") {
    if (!delta) {
      return jsonResponse({ ok: false, error: "delta is required for chat_message_delta events." }, 400);
    }
    const dm = delta.message;
    if (!dm || typeof dm !== "object" || Array.isArray(dm)) {
      return jsonResponse({ ok: false, error: "delta.message is required." }, 400);
    }
  }

  const threadId = truncate(str(thread.threadId), LIMITS.threadId);
  if (!threadId) {
    return jsonResponse({ ok: false, error: "thread.threadId is required." }, 400);
  }

  const subject = truncate(str(thread.subject), LIMITS.text);
  let sender = truncate(str(thread.sender), LIMITS.text);
  if (!sender) {
    sender = truncate(str((thread as Record<string, unknown>).contactName), LIMITS.text);
  }
  if (!sender) {
    sender = truncate(deriveSenderFromThreadId(threadId), LIMITS.text);
  }
  const latestMessage = truncate(str(thread.latestMessage), LIMITS.text);
  const preview = truncate(str(thread.preview), LIMITS.preview);
  const unread = bool(thread.unread);
  const threadUrl = truncate(str(thread.threadUrl), LIMITS.url);
  const sourceUrl = truncate(str(thread.sourceUrl), LIMITS.url);
  const queuedAt = isoOrNull(thread.queuedAt);

  const statusValueRaw = str(status.value, "queued");
  const statusValue = ALLOWED_STATUS.has(statusValueRaw) ? statusValueRaw : "queued";
  const backendDecisionRaw = str(status.backendDecision);
  const backendDecision = ALLOWED_BACKEND_DECISIONS.has(backendDecisionRaw) ? backendDecisionRaw : "";
  const reviewReason = truncate(str(status.reviewReason), LIMITS.reason);
  const reviewSummary = truncate(str(status.reviewSummary), LIMITS.summary);
  const draftPreview = truncate(str(status.draftPreview), LIMITS.preview);
  const lastError = truncate(str(status.lastError), LIMITS.error);
  const lastDraftAt = isoOrNull(status.lastDraftAt);
  const lastSentAt = isoOrNull(status.lastSentAt);
  const lastOpenedAt = isoOrNull(status.lastOpenedAt);
  const lastAutoSentAt = isoOrNull(status.lastAutoSentAt);
  const lastHandledMessageKey = truncate(str(status.lastHandledMessageKey), LIMITS.msgKey);
  const lastAutoSentMessageKey = truncate(str(status.lastAutoSentMessageKey), LIMITS.msgKey);

  // Only chat_snapshot / chat_scanned events are accepted now.
  // Review state is purely a function of the current status value.
  const reviewActive: boolean = statusValue === "review_ready";
  const reviewResolvedAt: string | null = null;
  const reviewOpenedAt: string | null = null;

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  // --- Idempotency: short-circuit if this eventId was already stored -----
  if (verified && eventId) {
    try {
      const lookupUrl =
        `${SUPABASE_URL}/rest/v1/sync_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id,payload_sha256,stored_message_count,event_type,user_id`;
      const r = await fetch(lookupUrl, { headers });
      if (r.ok) {
        const rows = await r.json();
        if (Array.isArray(rows) && rows.length > 0) {
          const existing = rows[0] as Record<string, unknown>;
          if (existing.user_id && existing.user_id !== userId) {
            return jsonResponse({ ok: false, error: "eventId belongs to another account." }, 409);
          }
          if ((existing.payload_sha256 as string) !== bodyHash) {
            return jsonResponse({
              ok: false,
              error: "eventId already used with a different payload hash.",
              eventId,
            }, 409);
          }
          // Same event + same hash: replay the original receipt.
          const receipt: Record<string, unknown> = {
            ok: true,
            eventId,
            payloadSha256: bodyHash,
            replay: true,
          };
          if (
            existing.event_type === "chat_scanned" ||
            existing.event_type === "chat_message_delta"
          ) {
            receipt.storedMessageCount = (existing.stored_message_count as number) ?? 0;
          }
          return jsonResponse(receipt);
        }
      }
    } catch (e) {
      console.warn("idempotency lookup failed:", (e as Error).message);
    }
  }
  // ----------------------------------------------------------------------

  const upsertBody: Record<string, unknown> = {
    user_id: userId,
    provider,
    thread_id: threadId,
    subject,
    sender,
    latest_message: latestMessage,
    preview,
    unread,
    thread_url: threadUrl,
    source_url: sourceUrl,
    queued_at: queuedAt,
    status_value: statusValue,
    backend_decision: backendDecision,
    review_reason: reviewReason,
    review_summary: reviewSummary,
    draft_preview: draftPreview,
    last_error: lastError,
    last_draft_at: lastDraftAt,
    last_sent_at: lastSentAt,
    last_opened_at: lastOpenedAt,
    last_auto_sent_at: lastAutoSentAt,
    last_handled_message_key: lastHandledMessageKey,
    last_auto_sent_message_key: lastAutoSentMessageKey,
    review_active: reviewActive,
    review_resolved_at: reviewResolvedAt,
    extension_version: extensionVersion,
    source,
    queue_scope: queueScope,
    last_event_type: eventType,
    last_event_at: occurredAt,
  };
  if (reviewOpenedAt) {
    upsertBody.review_opened_at = reviewOpenedAt;
  }

  // Snapshot denormalization onto thread_states (chat_snapshot events)
  let snapLastMessage: Record<string, unknown> = {};
  if (snapshot) {
    const capturedAt = isoOrNull(snapshot.capturedAt) ?? occurredAt;
    const unreadCount = typeof snapshot.unreadCount === "number" ? snapshot.unreadCount : null;
    const lm = (snapshot.lastMessage && typeof snapshot.lastMessage === "object" && !Array.isArray(snapshot.lastMessage))
      ? (snapshot.lastMessage as Record<string, unknown>)
      : {};
    snapLastMessage = lm;
    upsertBody.last_snapshot = snapshot;
    upsertBody.snapshot_captured_at = capturedAt;
    upsertBody.snapshot_unread_count = unreadCount;
    upsertBody.snapshot_body = truncate(str(lm.body), LIMITS.text);
    upsertBody.snapshot_from_me = typeof lm.fromMe === "boolean" ? lm.fromMe : null;
    upsertBody.snapshot_msg_type = truncate(str(lm.type), LIMITS.short);
    upsertBody.snapshot_ack = typeof lm.ack === "number" ? lm.ack : null;
    upsertBody.snapshot_msg_timestamp = typeof lm.timestamp === "number" ? lm.timestamp : null;
    upsertBody.snapshot_has_reaction = lm.hasReaction === true;
    upsertBody.snapshot_is_forwarded = lm.isForwarded === true;
    // Snapshots don't carry status — keep status_value sensible
    if (eventType === "chat_snapshot" && !status.value) {
      upsertBody.status_value = "queued";
    }
  }

  // Scan denormalization onto thread_states (chat_scanned events)
  let scanMessages: unknown[] = [];
  let scanCapturedAt: string | null = null;
  let scanMessageCount = 0;
  if (scan) {
    scanCapturedAt = isoOrNull(scan.capturedAt) ?? occurredAt;
    scanMessages = Array.isArray(scan.messages) ? scan.messages : [];
    scanMessageCount = typeof scan.messageCount === "number"
      ? scan.messageCount
      : scanMessages.length;
    upsertBody.last_scan = scan;
    upsertBody.scan_captured_at = scanCapturedAt;
    upsertBody.scan_message_count = scanMessageCount;
    if (eventType === "chat_scanned" && !status.value) {
      upsertBody.status_value = "queued";
    }
  }

  // Delta denormalization onto thread_states (chat_message_delta events)
  let deltaMessage: Record<string, unknown> = {};
  let deltaDirection = "";
  let deltaCapturedAt: string | null = null;
  if (delta) {
    deltaMessage = (delta.message && typeof delta.message === "object" && !Array.isArray(delta.message))
      ? (delta.message as Record<string, unknown>)
      : {};
    deltaDirection = str(delta.direction).toLowerCase();
    deltaCapturedAt = isoOrNull(delta.capturedAt) ?? occurredAt;
    const dmBody = truncate(str(deltaMessage.rawBody) || str(deltaMessage.body), LIMITS.text);
    const dmFromMe = typeof deltaMessage.fromMe === "boolean"
      ? deltaMessage.fromMe as boolean
      : (deltaDirection === "outgoing" ? true : deltaDirection === "incoming" ? false : null);
    const dmTs = typeof deltaMessage.timestamp === "number" ? deltaMessage.timestamp : null;
    if (dmBody) {
      upsertBody.latest_message = dmBody;
      upsertBody.preview = upsertBody.preview || truncate(dmBody, LIMITS.preview);
    }
    upsertBody.snapshot_captured_at = deltaCapturedAt;
    upsertBody.snapshot_body = dmBody;
    upsertBody.snapshot_from_me = dmFromMe;
    upsertBody.snapshot_msg_type = truncate(str(deltaMessage.type), LIMITS.short);
    upsertBody.snapshot_msg_timestamp = dmTs;
    if (eventType === "chat_message_delta" && !status.value) {
      upsertBody.status_value = "queued";
    }
  }

  // Upsert by (user_id, provider, thread_id)
  const upsertUrl =
    `${SUPABASE_URL}/rest/v1/thread_states?on_conflict=user_id,provider,thread_id`;

  const upsertRes = await fetch(upsertUrl, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([upsertBody]),
  });

  if (!upsertRes.ok) {
    const text = (await upsertRes.text()).slice(0, 300);
    console.error(`sync-thread-state upsert failed status=${upsertRes.status} body=${text}`);
    return jsonResponse({ ok: false, error: "Failed to persist thread state." }, 500);
  }

  let threadStateId: string | null = null;
  try {
    const rows = await upsertRes.json();
    if (Array.isArray(rows) && rows.length > 0 && typeof rows[0]?.id === "string") {
      threadStateId = rows[0].id;
    }
  } catch {
    // ignore parse error
  }

  // Append history (best-effort, don't fail the request if this errors)
  if (threadStateId) {
    fetch(`${SUPABASE_URL}/rest/v1/thread_state_history`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        thread_state_id: threadStateId,
        user_id: userId,
        provider,
        thread_id: threadId,
        event_type: eventType,
        status_value: statusValue,
        backend_decision: backendDecision,
        review_reason: reviewReason,
        review_summary: reviewSummary,
        occurred_at: occurredAt,
        payload: body,
      }),
    }).catch((e) => console.warn("history insert failed:", (e as Error).message));
  }

  // Append to chat_snapshots time-series (best-effort)
  if (snapshot) {
    const lm = snapLastMessage;
    fetch(`${SUPABASE_URL}/rest/v1/chat_snapshots`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        provider,
        thread_id: threadId,
        captured_at: isoOrNull(snapshot.capturedAt) ?? occurredAt,
        unread_count: typeof snapshot.unreadCount === "number" ? snapshot.unreadCount : 0,
        from_me: typeof lm.fromMe === "boolean" ? lm.fromMe : null,
        body: truncate(str(lm.body), LIMITS.text),
        msg_type: truncate(str(lm.type), LIMITS.short),
        ack: typeof lm.ack === "number" ? lm.ack : null,
        has_reaction: lm.hasReaction === true,
        is_forwarded: lm.isForwarded === true,
        msg_timestamp: typeof lm.timestamp === "number" ? lm.timestamp : null,
        source,
        extension_version: extensionVersion,
        raw_payload: body,
      }),
    }).catch((e) => console.warn("chat_snapshot insert failed:", (e as Error).message));
  }

  // Append to chat_scans time-series (best-effort)
  if (scan) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_scans`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        provider,
        thread_id: threadId,
        captured_at: scanCapturedAt ?? occurredAt,
        message_count: scanMessageCount,
        messages: scanMessages,
        source,
        extension_version: extensionVersion,
        raw_payload: body,
      }),
    }).catch((e) => console.warn("chat_scan insert failed:", (e as Error).message));
  }

  // --- Verified persistence: sync_events + per-message identity ---------
  let storedMessageCount = 0;
  if (verified) {
    // 1) Insert the sync_events row first (FK target for scan_messages).
    const eventInsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sync_events`,
      {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({
          event_id: eventId,
          user_id: userId,
          provider,
          thread_id: threadId,
          event_type: eventType,
          scan_id: scanId || null,
          schema_version: schemaVersion,
          payload_sha256: bodyHash,
          stored_message_count: null,
        }),
      },
    );
    if (!eventInsertRes.ok) {
      const text = (await eventInsertRes.text()).slice(0, 300);
      console.error(`sync_events insert failed status=${eventInsertRes.status} body=${text}`);
      return jsonResponse({ ok: false, error: "Failed to persist sync event." }, 500);
    }

    // 2) For chat_scanned, persist per-message identity rows.
    if (eventType === "chat_scanned" && Array.isArray(scanMessages) && scanMessages.length > 0) {
      const rowsToInsert = scanMessages.map((m, i) => {
        const msg = (m && typeof m === "object") ? (m as Record<string, unknown>) : {};
        const messageIdRaw = truncate(str(msg.messageId) || str(msg.id), LIMITS.msgKey);
        const messageId = messageIdRaw || null;
        const rawBody = truncate(str(msg.body) || str(msg.rawBody), LIMITS.text);
        const normalized = truncate(str(msg.normalizedBody) || rawBody, LIMITS.text);
        return {
          user_id: userId,
          provider,
          thread_id: threadId,
          event_id: eventId,
          message_id: messageId,
          ordinal: typeof msg.ordinal === "number" ? msg.ordinal : i,
          source_model_index: typeof msg.sourceModelIndex === "number" ? msg.sourceModelIndex : null,
          sender_id: truncate(str(msg.senderId), LIMITS.text) || null,
          from_me: typeof msg.fromMe === "boolean" ? msg.fromMe : null,
          msg_timestamp: typeof msg.timestamp === "number" ? msg.timestamp : null,
          raw_body: rawBody,
          normalized_body: normalized,
          degraded: !messageId,
        };
      });

      // Bug 2: persist the rich metadata fields the extension ships.
      const enrichedRows = rowsToInsert.map((row, i) => {
        const msg = (scanMessages[i] && typeof scanMessages[i] === "object")
          ? (scanMessages[i] as Record<string, unknown>)
          : {};
        return {
          ...row,
          body: truncate(str(msg.body), LIMITS.text) || null,
          sender: truncate(str(msg.sender), LIMITS.text) || null,
          msg_type: truncate(str(msg.type), LIMITS.short) || null,
          ack: typeof msg.ack === "number" ? msg.ack : null,
          has_reaction: typeof msg.hasReaction === "boolean" ? msg.hasReaction : null,
          is_forwarded: typeof msg.isForwarded === "boolean" ? msg.isForwarded : null,
          has_media: typeof msg.hasMedia === "boolean" ? msg.hasMedia : null,
          caption: truncate(str(msg.caption), LIMITS.text) || null,
          normalized_caption: truncate(str(msg.normalizedCaption), LIMITS.text) || null,
          subtype: truncate(str(msg.subtype), LIMITS.short) || null,
          mime_type: truncate(str(msg.mimeType), LIMITS.short) || null,
        };
      });

      // Pre-filter out messages whose message_id already exists for this
      // (user_id, thread_id). The partial unique index on (user_id, thread_id,
      // message_id) WHERE message_id IS NOT NULL prevents duplicates across
      // events, and PostgREST can't on_conflict against a partial index, so we
      // filter client-side. Degraded rows (no message_id) are always inserted
      // and de-duped by (event_id, ordinal) for safe replays.
      const candidateIds = Array.from(
        new Set(enrichedRows.map((r) => r.message_id).filter((x): x is string => !!x)),
      );
      const existingIds = new Set<string>();
      if (candidateIds.length > 0) {
        const inList = candidateIds.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(",");
        const lookupUrl =
          `${SUPABASE_URL}/rest/v1/scan_messages?user_id=eq.${userId}&thread_id=eq.${encodeURIComponent(threadId)}&message_id=in.(${encodeURIComponent(inList)})&select=message_id`;
        const r = await fetch(lookupUrl, { headers });
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr)) {
            for (const row of arr) {
              if (row && typeof row.message_id === "string") existingIds.add(row.message_id);
            }
          }
        }
      }
      // Also de-duplicate within the same batch (defensive — the partial
      // unique index on (user_id, thread_id, message_id) would otherwise
      // reject the whole insert if the extension ever shipped duplicates).
      const seenInBatch = new Set<string>();
      const skippedExisting: string[] = [];
      const skippedDuplicateInBatch: string[] = [];
      const rowsFiltered = enrichedRows.filter((r) => {
        if (!r.message_id) return true; // degraded — always insert
        if (existingIds.has(r.message_id)) {
          skippedExisting.push(r.message_id);
          return false;
        }
        if (seenInBatch.has(r.message_id)) {
          skippedDuplicateInBatch.push(r.message_id);
          return false;
        }
        seenInBatch.add(r.message_id);
        return true;
      });

      if (rowsFiltered.length > 0) {
        const msgInsertRes = await fetch(
          `${SUPABASE_URL}/rest/v1/scan_messages?on_conflict=event_id,ordinal`,
          {
            method: "POST",
            headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(rowsFiltered),
          },
        );
        if (!msgInsertRes.ok) {
          const text = (await msgInsertRes.text()).slice(0, 300);
          console.error(`scan_messages insert failed status=${msgInsertRes.status} body=${text}`);
          // Roll back the sync_events row so a retry can succeed cleanly.
          await fetch(
            `${SUPABASE_URL}/rest/v1/sync_events?event_id=eq.${encodeURIComponent(eventId)}`,
            { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } },
          ).catch(() => {});
          return jsonResponse({ ok: false, error: "Failed to persist scan messages." }, 500);
        }
      }
      // stored_message_count reflects the actual INSERT count for this event,
      // NOT the payload's messageCount. Re-scans of the same thread therefore
      // legitimately report 0 when every message is already in scan_messages.
      storedMessageCount = rowsFiltered.length;
      const degradedCount = enrichedRows.filter((r) => !r.message_id).length;
      console.log(
        `scan_messages received=${enrichedRows.length} inserted=${rowsFiltered.length} ` +
          `skipped_existing=${skippedExisting.length} skipped_dup_in_batch=${skippedDuplicateInBatch.length} ` +
          `degraded=${degradedCount} thread=${threadId} event=${eventId}` +
          (skippedExisting.length > 0 ? ` existing_ids=${skippedExisting.slice(0, 10).join(",")}` : "") +
          (skippedDuplicateInBatch.length > 0 ? ` dup_ids=${skippedDuplicateInBatch.slice(0, 10).join(",")}` : ""),
      );

      // Patch the count back onto sync_events for replay receipts.
      fetch(
        `${SUPABASE_URL}/rest/v1/sync_events?event_id=eq.${encodeURIComponent(eventId)}`,
        {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify({ stored_message_count: storedMessageCount }),
        },
      ).catch((e) => console.warn("sync_events count patch failed:", (e as Error).message));

      // Fire-and-forget Whisper transcription for ptt voice notes that
      // shipped a non-empty voiceBlob.dataUrl. Only target rows we just
      // inserted (rowsFiltered) so re-scans don't re-transcribe.
      const voiceCandidates: { messageId: string; voiceBlob: Record<string, unknown> }[] = [];
      const insertedIds = new Set(
        rowsFiltered.map((r) => r.message_id).filter((x): x is string => !!x),
      );
      for (let i = 0; i < scanMessages.length; i++) {
        const msg = (scanMessages[i] && typeof scanMessages[i] === "object")
          ? (scanMessages[i] as Record<string, unknown>)
          : null;
        if (!msg) continue;
        if (str(msg.type).toLowerCase() !== "ptt") continue;
        const vb = msg.voiceBlob;
        if (!vb || typeof vb !== "object" || Array.isArray(vb)) continue;
        const vbObj = vb as Record<string, unknown>;
        const dataUrl = typeof vbObj.dataUrl === "string" ? vbObj.dataUrl.trim() : "";
        if (!dataUrl) continue;
        const mid = truncate(str(msg.messageId) || str(msg.id), LIMITS.msgKey);
        if (!mid || !insertedIds.has(mid)) continue;
        voiceCandidates.push({ messageId: mid, voiceBlob: vbObj });
      }
      scheduleTranscriptions(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        userId,
        threadId,
        voiceCandidates,
      );
    }

    // 3) For chat_message_delta, persist the single new message (deduped).
    if (eventType === "chat_message_delta" && delta) {
      const messageIdRaw = truncate(
        str(deltaMessage.messageId) || str(deltaMessage.id),
        LIMITS.msgKey,
      );
      if (!messageIdRaw) {
        // Roll back the sync_events row so a retry can succeed cleanly.
        await fetch(
          `${SUPABASE_URL}/rest/v1/sync_events?event_id=eq.${encodeURIComponent(eventId)}`,
          { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } },
        ).catch(() => {});
        return jsonResponse({ ok: false, error: "delta.message.messageId is required." }, 400);
      }

      const rawBody = truncate(
        str(deltaMessage.rawBody) || str(deltaMessage.body),
        LIMITS.text,
      );
      const normalized = truncate(str(deltaMessage.normalizedBody) || rawBody, LIMITS.text);
      const fromMe = typeof deltaMessage.fromMe === "boolean"
        ? (deltaMessage.fromMe as boolean)
        : (deltaDirection === "outgoing" ? true : deltaDirection === "incoming" ? false : null);

      // Dedup by (user_id, thread_id, message_id) — partial unique index.
      const inList = `"${messageIdRaw.replace(/"/g, '\\"')}"`;
      const lookupUrl =
        `${SUPABASE_URL}/rest/v1/scan_messages?user_id=eq.${userId}&thread_id=eq.${encodeURIComponent(threadId)}&message_id=in.(${encodeURIComponent(inList)})&select=message_id`;
      let alreadyExists = false;
      try {
        const r = await fetch(lookupUrl, { headers });
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr) && arr.length > 0) alreadyExists = true;
        }
      } catch {
        // best-effort; on_conflict below still protects safe replays
      }

      if (!alreadyExists) {
        const row = {
          user_id: userId,
          provider,
          thread_id: threadId,
          event_id: eventId,
          message_id: messageIdRaw,
          ordinal: 0,
          source_model_index: null,
          sender_id: truncate(str(deltaMessage.senderId), LIMITS.text) || null,
          from_me: fromMe,
          msg_timestamp: typeof deltaMessage.timestamp === "number"
            ? deltaMessage.timestamp
            : null,
          raw_body: rawBody,
          normalized_body: normalized,
          degraded: false,
          body: truncate(str(deltaMessage.body), LIMITS.text) || null,
          sender: truncate(str(deltaMessage.sender), LIMITS.text) || null,
          msg_type: truncate(str(deltaMessage.type), LIMITS.short) || null,
          ack: typeof deltaMessage.ack === "number" ? deltaMessage.ack : null,
          has_reaction: typeof deltaMessage.hasReaction === "boolean" ? deltaMessage.hasReaction : null,
          is_forwarded: typeof deltaMessage.isForwarded === "boolean" ? deltaMessage.isForwarded : null,
          has_media: typeof deltaMessage.hasMedia === "boolean" ? deltaMessage.hasMedia : null,
          caption: truncate(str(deltaMessage.caption), LIMITS.text) || null,
          normalized_caption: truncate(str(deltaMessage.normalizedCaption), LIMITS.text) || null,
          subtype: truncate(str(deltaMessage.subtype), LIMITS.short) || null,
          mime_type: truncate(str(deltaMessage.mimeType), LIMITS.short) || null,
        };
        const msgInsertRes = await fetch(
          `${SUPABASE_URL}/rest/v1/scan_messages?on_conflict=event_id,ordinal`,
          {
            method: "POST",
            headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify([row]),
          },
        );
        if (!msgInsertRes.ok) {
          const text = (await msgInsertRes.text()).slice(0, 300);
          console.error(`scan_messages delta insert failed status=${msgInsertRes.status} body=${text}`);
          await fetch(
            `${SUPABASE_URL}/rest/v1/sync_events?event_id=eq.${encodeURIComponent(eventId)}`,
            { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } },
          ).catch(() => {});
          return jsonResponse({ ok: false, error: "Failed to persist delta message." }, 500);
        }
        storedMessageCount = 1;
      } else {
        storedMessageCount = 0;
      }

      // Fire-and-forget Whisper transcription for ptt deltas.
      if (
        storedMessageCount === 1 &&
        str(deltaMessage.type).toLowerCase() === "ptt"
      ) {
        const vb = deltaMessage.voiceBlob;
        if (vb && typeof vb === "object" && !Array.isArray(vb)) {
          const vbObj = vb as Record<string, unknown>;
          const dataUrl = typeof vbObj.dataUrl === "string" ? vbObj.dataUrl.trim() : "";
          if (dataUrl) {
            scheduleTranscriptions(
              SUPABASE_URL,
              SUPABASE_SERVICE_ROLE_KEY,
              userId,
              threadId,
              [{ messageId: messageIdRaw, voiceBlob: vbObj }],
            );
          }
        }
      }

      fetch(
        `${SUPABASE_URL}/rest/v1/sync_events?event_id=eq.${encodeURIComponent(eventId)}`,
        {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify({ stored_message_count: storedMessageCount }),
        },
      ).catch((e) => console.warn("sync_events count patch failed:", (e as Error).message));
      console.log(
        `chat_message_delta persisted=${storedMessageCount} skipped_existing=${alreadyExists ? 1 : 0} event=${eventId} msg=${messageIdRaw}`,
      );
    }
  }
  // ----------------------------------------------------------------------

  // Fire-and-forget intent classification when a new inbound message arrives.
  // Triggers on chat_snapshot / chat_scanned events whose newest inbound content
  // is fresher than the last intent_classified_at on the thread.
  if (
    eventType === "chat_snapshot" ||
    eventType === "chat_scanned" ||
    eventType === "chat_message_delta"
  ) {
    try {
      // Get the previously stored classification timestamp from the upsert response.
      // (We already read rows[0] above for threadStateId — refetch the field here cheaply.)
      let priorClassifiedAt: string | null = null;
      if (threadStateId) {
        const readUrl = `${SUPABASE_URL}/rest/v1/thread_states?id=eq.${threadStateId}&select=intent_classified_at`;
        const r = await fetch(readUrl, { headers });
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr) && arr[0]) priorClassifiedAt = arr[0].intent_classified_at ?? null;
        }
      }

      // Pick the freshest inbound message text + capture time.
      let inboundText = "";
      let inboundAt: string | null = null;
      let contextText = "";

      if (eventType === "chat_snapshot" && snapshot) {
        const lm = snapLastMessage;
        const fromMe = typeof lm.fromMe === "boolean" ? lm.fromMe : false;
        if (!fromMe) {
          inboundText = truncate(str(lm.body), LIMITS.text);
          inboundAt = isoOrNull(snapshot.capturedAt) ?? occurredAt;
        }
      } else if (eventType === "chat_message_delta" && delta) {
        const fromMe = typeof deltaMessage.fromMe === "boolean"
          ? (deltaMessage.fromMe as boolean)
          : deltaDirection === "outgoing";
        if (!fromMe) {
          inboundText = truncate(
            str(deltaMessage.rawBody) || str(deltaMessage.body),
            LIMITS.text,
          );
          inboundAt = deltaCapturedAt ?? occurredAt;
        }
      } else if (eventType === "chat_scanned" && Array.isArray(scanMessages)) {
        // Intent is defined by the SUM of all messages in the thread.
        // Build the full transcript (oldest→newest) and pass it as context;
        // the latest inbound becomes the trigger `message`. No per-message
        // truncation beyond a generous cap so the classifier sees the whole
        // conversation.
        const msgs = scanMessages as Array<Record<string, unknown>>;
        const transcriptParts: string[] = [];
        const MAX_PER_MSG = 600;
        const MAX_TOTAL_CHARS = 12000;
        let total = 0;
        // Walk newest→oldest to find latest inbound trigger.
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || typeof m !== "object") continue;
          if (m.fromMe !== true && !inboundText) {
            const txt = str(m.body);
            if (txt) {
              inboundText = truncate(txt, LIMITS.text);
              inboundAt = scanCapturedAt ?? occurredAt;
              break;
            }
          }
        }
        // Build full transcript oldest→newest, capped.
        for (const m of msgs) {
          if (!m || typeof m !== "object") continue;
          const fromMe = m.fromMe === true;
          const txt = str(m.body);
          if (!txt) continue;
          const line = `${fromMe ? "business" : "customer"}: ${txt.slice(0, MAX_PER_MSG)}`;
          if (total + line.length + 1 > MAX_TOTAL_CHARS) break;
          transcriptParts.push(line);
          total += line.length + 1;
        }
        contextText = transcriptParts.join("\n");
      }

      const shouldClassify = Boolean(inboundText) &&
        (!priorClassifiedAt || (inboundAt && new Date(inboundAt) > new Date(priorClassifiedAt)));

      if (shouldClassify) {
        const classifyPromise = fetch(`${SUPABASE_URL}/functions/v1/classify-intent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            user_id: userId,
            provider,
            thread_id: threadId,
            message: inboundText,
            context: contextText,
            source: eventType === "chat_scanned" ? "scan" : "snapshot",
          }),
        }).then(async (r) => {
          if (!r.ok) {
            const t = (await r.text()).slice(0, 300);
            console.warn(`classify-intent ${r.status}: ${t}`);
          }
        }).catch((e) => console.warn("classify-intent dispatch failed:", (e as Error).message));
        // Ensure the background request actually completes after we return.
        const rt = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
        if (rt && typeof rt.waitUntil === "function") {
          rt.waitUntil(classifyPromise);
        } else {
          await classifyPromise;
        }
        console.log(`classify-intent dispatched user=${userId} thread=${threadId} event=${eventType} ctx_len=${contextText.length}`);
      }
    } catch (e) {
      console.warn("classify-intent gating failed:", (e as Error).message);
    }
  }

  console.log(
    `sync-thread-state OK user=${userId} provider=${provider} thread=${threadId} event=${eventType} status=${statusValue} review_active=${reviewActive}`,
  );

  if (verified) {
    const receipt: Record<string, unknown> = {
      ok: true,
      eventId,
      payloadSha256: bodyHash,
    };
    if (eventType === "chat_scanned") {
      receipt.storedMessageCount = storedMessageCount;
    }
    if (eventType === "chat_message_delta") {
      receipt.storedMessageCount = storedMessageCount;
    }
    return jsonResponse(receipt);
  }
  return jsonResponse({ ok: true, legacy: true });
});
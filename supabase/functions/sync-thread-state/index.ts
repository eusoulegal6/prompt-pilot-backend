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

  const threadId = truncate(str(thread.threadId), LIMITS.threadId);
  if (!threadId) {
    return jsonResponse({ ok: false, error: "thread.threadId is required." }, 400);
  }

  const subject = truncate(str(thread.subject), LIMITS.text);
  let sender = truncate(str(thread.sender), LIMITS.text);
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

  // Fire-and-forget intent classification when a new inbound message arrives.
  // Triggers on chat_snapshot / chat_scanned events whose newest inbound content
  // is fresher than the last intent_classified_at on the thread.
  if (eventType === "chat_snapshot" || eventType === "chat_scanned") {
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

  return jsonResponse({ ok: true });
});
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

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

async function tryPartnerVerify(token: string): Promise<{ partnerRef: string; sub: string } | null> {
  for (const partner of PARTNER_PROJECTS) {
    try {
      const { payload } = await jwtVerify(token, getPartnerJwks(partner.url), {
        issuer: `${partner.url}/auth/v1`,
      });
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      if (sub) return { partnerRef: partner.ref, sub };
    } catch (_) {
      // Try next trusted project.
    }
  }
  return null;
}

async function resolvePartnerUserId(admin: ReturnType<typeof createClient>, partnerRef: string, sub: string): Promise<string | null> {
  const bridgeEmail = `partner+${partnerRef}+${sub}@bridge.sendsmart.local`;
  const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) {
    console.error("flagged-list partner listUsers error:", error.message);
    return null;
  }
  const found = list?.users?.find((u: { email?: string | null }) => u.email === bridgeEmail);
  return found?.id ?? null;
}

async function resolveUserId(req: Request, supabaseUrl: string, anonKey: string, serviceRoleKey: string): Promise<string | null> {
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

  const localClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: localUser } = await localClient.auth.getUser(token);
  if (localUser?.user?.id) return localUser.user.id;

  const partner = await tryPartnerVerify(token);
  if (!partner) return extractUserIdFromJwt(token);
  const admin = createClient(supabaseUrl, serviceRoleKey);
  return await resolvePartnerUserId(admin, partner.partnerRef, partner.sub);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("health") === "1") {
    return jsonResponse({ ok: true, function: "flagged-list" });
  }
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Server configuration error." }, 500);
  }

  const userId = await resolveUserId(req, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  let limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;

  const minAgeMinutes = parseInt(url.searchParams.get("min_age_minutes") ?? "0", 10);
  const cutoffIso = Number.isFinite(minAgeMinutes) && minAgeMinutes > 0
    ? new Date(Date.now() - minAgeMinutes * 60_000).toISOString()
    : "";

  const select = [
    "thread_id",
    "provider",
    "sender",
    "subject",
    "preview",
    "latest_message",
    "intent_category",
    "intent_subcategory",
    "intent_confidence",
    "intent_reason",
    "intent_source",
    "intent_classified_at",
    "customer_goal",
    "business_action",
    "needs_human_review",
    "intent_review_reason",
    "intent_urgency",
    "updated_at",
    "thread_url",
  ].join(",");

  // Surface any thread that has been classified, plus anything flagged for review.
  // Previously this filter only returned low-confidence / flagged rows, which hid
  // confident classifications (e.g. appointment @ 0.98) from the dashboard.
  const orFilter =
    "or=(" +
    [
      "needs_human_review.eq.true",
      "intent_category.not.is.null",
      "intent_subcategory.not.is.null",
    ].join(",") +
    ")";

  const params = new URLSearchParams();
  params.set("user_id", `eq.${userId}`);
  params.set("select", select);
  params.set("order", "updated_at.desc");
  params.set("limit", String(limit));
  if (cutoffIso) params.set("updated_at", `lte.${cutoffIso}`);

  const restUrl = `${SUPABASE_URL}/rest/v1/thread_states?${params.toString()}&${orFilter}`;

  try {
    const res = await fetch(restUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      console.error(`flagged-list rest ${res.status}: ${errText}`);
      return jsonResponse({ error: "Query failed" }, 502);
    }
    const items = await res.json();
    const rawList: Array<Record<string, unknown>> = Array.isArray(items) ? items : [];

    // Filter out unknown senders - if there's no sender name, don't surface to the frontend.
    const isUnknownSender = (item: Record<string, unknown>): boolean => {
      const sender = typeof item.sender === "string" ? item.sender.trim() : "";
      if (!sender) return true;
      const lower = sender.toLowerCase();
      if (lower === "unknown" || lower === "unknown sender") return true;
      // jid-like values with no human name (e.g. "80393332084875@lid", "12345@c.us")
      if (/^[\d+\-\s]+@[a-z.]+$/i.test(sender)) return true;
      return false;
    };
    const itemList = rawList.filter((item) => !isUnknownSender(item));

    // Enrich each thread with recent messages from chat_snapshots + latest scan.
    if (itemList.length > 0) {
      const threadIds = Array.from(new Set(itemList.map((i) => String(i.thread_id))));
      const inList = threadIds.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(",");

      // Pull up to 200 most recent snapshots across these threads (≈ up to ~20/thread for 10 threads).
      const snapParams = new URLSearchParams();
      snapParams.set("user_id", `eq.${userId}`);
      snapParams.set("thread_id", `in.(${inList})`);
      snapParams.set("select", "thread_id,captured_at,from_me,body,msg_type");
      snapParams.set("order", "captured_at.desc");
      snapParams.set("limit", String(Math.min(500, threadIds.length * 25)));
      const snapUrl = `${SUPABASE_URL}/rest/v1/chat_snapshots?${snapParams.toString()}`;

      // Recent scans per thread (we merge messages across multiple scans so older
      // history surfaces even when the most recent scan captured only 1 message).
      const scanParams = new URLSearchParams();
      scanParams.set("user_id", `eq.${userId}`);
      scanParams.set("thread_id", `in.(${inList})`);
      scanParams.set("select", "thread_id,captured_at,message_count,messages");
      scanParams.set("order", "captured_at.desc");
      scanParams.set("limit", String(threadIds.length * 10));
      const scanUrl = `${SUPABASE_URL}/rest/v1/chat_scans?${scanParams.toString()}`;

      // Individual scan messages (separate table) — needed for transcription data.
      const smParams = new URLSearchParams();
      smParams.set("user_id", `eq.${userId}`);
      smParams.set("thread_id", `in.(${inList})`);
      smParams.set("select", "thread_id,body,normalized_body,raw_body,caption,from_me,msg_timestamp,msg_type,transcription,created_at");
      smParams.set("order", "created_at.desc");
      smParams.set("limit", String(Math.min(500, threadIds.length * 25)));
      const smUrl = `${SUPABASE_URL}/rest/v1/scan_messages?${smParams.toString()}`;

      const headers = {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      };

      const [snapRes, scanRes, smRes] = await Promise.all([
        fetch(snapUrl, { headers }),
        fetch(scanUrl, { headers }),
        fetch(smUrl, { headers }),
      ]);

      const snapRows: Array<{
        thread_id: string;
        captured_at: string;
        from_me: boolean | null;
        body: string | null;
        msg_type: string | null;
      }> = snapRes.ok ? await snapRes.json() : [];
      const scanRows: Array<{
        thread_id: string;
        captured_at: string;
        message_count: number | null;
        messages: unknown;
      }> = scanRes.ok ? await scanRes.json() : [];

      const smRows: Array<{
        thread_id: string;
        body: string | null;
        normalized_body: string | null;
        raw_body: string | null;
        caption: string | null;
        from_me: boolean | null;
        msg_timestamp: number | null;
        msg_type: string | null;
        transcription: string | null;
        created_at: string;
      }> = smRes.ok ? await smRes.json() : [];

      const snapsByThread = new Map<string, typeof snapRows>();
      for (const row of snapRows) {
        const list = snapsByThread.get(row.thread_id) ?? [];
        if (list.length < 20) list.push(row);
        snapsByThread.set(row.thread_id, list);
      }

      // Group ALL recent scans by thread (not just the newest). Dedupe below
      // collapses duplicates across scans by (from_me, body).
      const scansByThread = new Map<string, (typeof scanRows)>();
      for (const row of scanRows) {
        const list = scansByThread.get(row.thread_id) ?? [];
        list.push(row);
        scansByThread.set(row.thread_id, list);
      }

      // Group scan_messages rows by thread.
      const smByThread = new Map<string, typeof smRows>();
      for (const row of smRows) {
        const list = smByThread.get(row.thread_id) ?? [];
        if (list.length < 20) list.push(row);
        smByThread.set(row.thread_id, list);
      }

      type RecentMsg = {
        body: string;
        from_me: boolean;
        captured_at: string;
        msg_type: string | null;
        source: "snapshot" | "scan";
        transcription: string | null;
      };

      const normalizeScanMessages = (raw: unknown): RecentMsg[] => {
        if (!Array.isArray(raw)) return [];
        const out: RecentMsg[] = [];
        for (const m of raw) {
          if (!m || typeof m !== "object") continue;
          const obj = m as Record<string, unknown>;
          const body = typeof obj.body === "string"
            ? obj.body
            : typeof obj.text === "string"
              ? obj.text
              : "";
          if (!body.trim()) continue;
          const tsRaw = obj.timestamp ?? obj.captured_at ?? obj.t;
          let captured_at = "";
          if (typeof tsRaw === "number") {
            captured_at = new Date(tsRaw < 1e12 ? tsRaw * 1000 : tsRaw).toISOString();
          } else if (typeof tsRaw === "string") {
            const d = new Date(tsRaw);
            captured_at = isNaN(d.getTime()) ? "" : d.toISOString();
          }
          out.push({
            body,
            from_me: Boolean(obj.fromMe ?? obj.from_me),
            captured_at,
            msg_type: typeof obj.type === "string" ? (obj.type as string) : null,
            source: "scan",
            transcription: null,
          });
        }
        return out;
      };

      for (const item of itemList) {
        const tid = String(item.thread_id);
        const snaps = snapsByThread.get(tid) ?? [];
        const scans = scansByThread.get(tid) ?? [];
        const smList = smByThread.get(tid) ?? [];
        const scanMsgs = scans.flatMap((s) => normalizeScanMessages(s.messages));

        // Map scan_messages rows into RecentMsg entries — the key addition
        // here is the transcription field for voice-note messages.
        const smMsgs: RecentMsg[] = smList
          .map((m) => ({
            body: (m.body || m.normalized_body || m.raw_body || m.caption || "").trim(),
            from_me: Boolean(m.from_me),
            captured_at: typeof m.msg_timestamp === "number"
              ? new Date(m.msg_timestamp < 1e12 ? m.msg_timestamp * 1000 : m.msg_timestamp).toISOString()
              : m.created_at,
            msg_type: m.msg_type,
            source: "scan" as const,
            transcription: m.transcription,
          }))
          .filter((m) => m.body.length > 0);

        const merged: RecentMsg[] = [
          ...snaps
            .filter((s) => (s.body ?? "").trim().length > 0)
            .map((s) => ({
              body: s.body as string,
              from_me: Boolean(s.from_me),
              captured_at: s.captured_at,
              msg_type: s.msg_type,
              source: "snapshot" as const,
              transcription: null,
            })),
          ...scanMsgs,
          ...smMsgs,
        ];

        // Dedupe by (body, from_me) keeping the most recent timestamp.
        // Prefer entries that carry a transcription over otherwise-duplicate entries that lack one.
        const byKey = new Map<string, RecentMsg>();
        for (const m of merged) {
          const key = `${m.from_me ? 1 : 0}|${m.body.trim().slice(0, 240)}`;
          const existing = byKey.get(key);
          if (!existing) {
            byKey.set(key, m);
          } else {
            const existingHasTranscription = Boolean(existing.transcription);
            const newHasTranscription = Boolean(m.transcription);
            if (newHasTranscription && !existingHasTranscription) {
              byKey.set(key, m);
            } else if (!newHasTranscription && existingHasTranscription) {
              // keep existing entry that already has transcription
            } else if (m.captured_at && m.captured_at > existing.captured_at) {
              byKey.set(key, m);
            }
          }
        }

        const recent = Array.from(byKey.values())
          .sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1))
          .slice(0, 20)
          .reverse(); // chronological order for display

        item.recent_messages = recent;
        if (scans.length > 0) item.latest_scan_message_count = scans[0].message_count;
      }
    }

    return jsonResponse({ ok: true, items: itemList });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`flagged-list ERROR user=${userId}: ${msg}`);
    return jsonResponse({ error: "Server error" }, 500);
  }
});
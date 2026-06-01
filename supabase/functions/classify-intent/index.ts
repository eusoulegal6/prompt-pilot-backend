// supabase/functions/classify-intent/index.ts
// Classifies a WhatsApp draft reply intent using Claude.
// Returns: { intent, start_time, end_time, timezone, title, confidence }
// Intent: "confirmation" | "cancellation" | "reschedule" | "none"
//
// Auth: requires Supabase JWT in Authorization header.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import Anthropic from "npm:@anthropic-ai/sdk";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    intent: {
      type: "string" as const,
      enum: ["confirmation", "cancellation", "reschedule", "none"],
      description:
        "confirmation: explicitly confirms a date/time. cancellation: cancels or turns down. reschedule: cancels old AND proposes new time. none: anything else.",
    },
    start_time: {
      type: "string" as const,
      description:
        "ISO 8601 datetime of the appointment start, with timezone offset. null if no date/time found.",
    },
    end_time: {
      type: "string" as const,
      description:
        "ISO 8601 datetime of the appointment end. null if not specified or no date found.",
    },
    timezone: {
      type: "string" as const,
      description: "IANA timezone name (e.g. America/New_York). null if unknown.",
    },
    title: {
      type: "string" as const,
      description:
        "Short event title from context (e.g. 'Haircut with Maria'). null if unclear.",
    },
    confidence: {
      type: "string" as const,
      enum: ["high", "medium", "low"],
      description: "How confident is this classification?",
    },
  },
  required: ["intent", "confidence"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!token) return json({ error: "Unauthorized" }, 401);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const draft: string = body?.draft ?? "";
    const incomingMessage: string = body?.incomingMessage ?? "";
    const userInstruction: string = body?.userInstruction ?? "";

    if (!draft.trim()) {
      return json({ intent: "none", start_time: null, end_time: null, timezone: null, title: null, confidence: "low" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const prompt = `Classify this WhatsApp draft reply as: confirmation, cancellation, reschedule, or none.

Definitions (these apply in ANY language):
- CONFIRMATION: explicitly confirms or books a date/time. Examples: "see you Tuesday at 2pm", "booked for Friday", "confirmed, I'll be there", "confermo per venerdì alle 16", "reservado para el martes".
- CANCELLATION: cancels or turns down an appointment WITHOUT proposing an alternative time. Examples: "I've cancelled it", "I can't make it, sorry", "annullo l'appuntamento", "cancelado, disculpa". If they decline AND immediately propose a new time, that's reschedule, not cancellation.
- RESCHEDULE: cancels the old time AND proposes a specific new time or asks for one. Examples: "can't do Tuesday, how about Wednesday at 3?", "spostiamo a venerdì alle 10", "no puedo el martes, ¿jueves a las 4?".
- NONE: small talk, thank yous, follow-up questions, or anything that doesn't involve scheduling. Examples: "thanks!", "let me think about it", "I'll get back to you".

Context:
Incoming message from contact: "${incomingMessage}"
User's instruction to the assistant: "${userInstruction}"
Assistant's drafted reply: "${draft}"

Today's date is ${today}. Current time is ${now}.

If intent is confirmation or reschedule, extract the proposed date and time. Use today's date as reference (e.g. "next Tuesday" = the Tuesday after today). Include the timezone offset in the ISO string. For timezone: if the conversation is in Italian use Europe/Rome, if in Spanish use Europe/Madrid, if in English use America/New_York unless context suggests otherwise. If truly unknown, use UTC.`;

    const msg = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 300,
      system:
        "You are a calendar intent classifier. Your only job is to classify appointment-related messages and extract dates. Respond only with valid JSON matching the schema. Work in any language. If the date/time is ambiguous, give your best guess and set confidence accordingly.",
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          name: "classify",
          description: "Return the classification result",
          input_schema: OUTPUT_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: "classify" },
    });

    const toolBlock = msg.content.find((c) => c.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      console.error("classify-intent: no tool_use in response");
      return json({ intent: "none", start_time: null, end_time: null, timezone: null, title: null, confidence: "low" });
    }

    const result = toolBlock.input as Record<string, unknown>;
    console.log("[classify-intent] raw result:", JSON.stringify(result));
    console.log(`[classify-intent] intent=${result.intent} confidence=${result.confidence} start_time=${result.start_time ?? "null"}`);

    return json({
      intent: result.intent ?? "none",
      start_time: result.start_time ?? null,
      end_time: result.end_time ?? null,
      timezone: result.timezone ?? null,
      title: result.title ?? null,
      confidence: result.confidence ?? "medium",
    });
  } catch (e) {
    console.error("classify-intent error", e);
    return json({ intent: "none", start_time: null, end_time: null, timezone: null, title: null, confidence: "low" }, 200);
  }
});

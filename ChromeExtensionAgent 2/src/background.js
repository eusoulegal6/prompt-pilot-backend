import { AGENT_ACTIONS, executeAgentAction, executeAgentActionOnTab, openAgentPanel } from "./lib/agent.js";
import { detectEmailProviderFromUrl, EMAIL_PROVIDERS, getEmailProvider } from "./lib/emailProviders.js";
import {
  getLastResponse,
  getMonitorState,
  getSettings,
  saveMonitorState,
  saveSettings,
  setLastResponse
} from "./lib/settings.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const EMAIL_MONITOR_ALARM = "email-monitor-poll";
const EMAIL_MONITOR_KICK_ALARM_PREFIX = "email-monitor-kick:";
const EMAIL_MONITOR_WATCHDOG_ALARM_PREFIX = "email-monitor-watchdog:";
const AUTO_REPLY_DELAY_MS = 250;
const REVIEW_CONTINUE_DELAY_MS = 1400;
const AUTOMATION_WATCHDOG_MS = 10000;
const REPLY_DRAFT_API_URL = "https://uexdjvbdqwrzlgfrpgbl.supabase.co/functions/v1/draft-gmail-reply";
const NO_REPLY_NEEDED_TOKEN = "[[NO_REPLY_NEEDED]]";
const NEEDS_ATTENTION_TOKEN = "[[NEEDS_ATTENTION]]";
const AUTOMATION_STOPPED_ERROR_CODE = "automation-stopped";
const autoReplyProvidersInFlight = new Set();
const providerKickNonces = new Map();

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await getSettings();
  await saveSettings(settings);
  const monitorState = await getMonitorState();
  await reconcileMonitorAlarm(monitorState);
  await reconcileAutomationWatchdogs(monitorState);

  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const monitorState = await getMonitorState();
  await reconcileMonitorAlarm(monitorState);
  await reconcileAutomationWatchdogs(monitorState);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === EMAIL_MONITOR_ALARM) {
    try {
      await pollEmailMonitor();
    } catch {
      // Ignore polling errors; the popup exposes state for inspection.
    }
    return;
  }

  if (alarm.name.startsWith(EMAIL_MONITOR_WATCHDOG_ALARM_PREFIX)) {
    const providerId = alarm.name.slice(EMAIL_MONITOR_WATCHDOG_ALARM_PREFIX.length).trim();

    if (!providerId) {
      return;
    }

    try {
      await pollEmailMonitor(providerId);
    } catch {
      // Ignore watchdog polling errors; the next watchdog pass can recover.
    }

    try {
      const state = await getMonitorState();

      if (getProviderMonitorState(state, providerId).enabled) {
        scheduleAutomationWatchdog(providerId);
      }
    } catch {
      // Ignore watchdog reschedule failures.
    }

    return;
  }

  if (!alarm.name.startsWith(EMAIL_MONITOR_KICK_ALARM_PREFIX)) {
    return;
  }

  const providerId = alarm.name.slice(EMAIL_MONITOR_KICK_ALARM_PREFIX.length).trim();

  if (!providerId) {
    return;
  }

  try {
    await pollEmailMonitor(providerId);
  } catch {
    // Ignore polling errors; the popup exposes state for inspection.
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "settings:get":
      return { settings: await getSettings() };
    case "settings:save":
      return { settings: await saveSettings(message.payload || {}) };
    case "settings:test-sandbox":
      return await handleSettingsSandboxTest(message.payload || {});
    case "response:get":
      return { text: await getLastResponse() };
    case "email:get-provider":
      return { provider: await getActiveEmailProvider() };
    case "monitor:get-state":
      return { monitorState: await getMonitorState() };
    case "monitor:set-provider":
      return { monitorState: await setSelectedMonitorProvider(`${message.payload?.provider || ""}`.trim()) };
    case "monitor:set-enabled":
      return {
        monitorState: await setMonitorEnabled(
          `${message.payload?.provider || ""}`.trim(),
          !!message.payload?.enabled
        )
      };
    case "monitor:set-auto-reply":
      return {
        monitorState: await setMonitorAutoReplyEnabled(
          `${message.payload?.provider || ""}`.trim(),
          !!message.payload?.enabled
        )
      };
    case "monitor:kick":
      return {
        monitorState: await pollEmailMonitor(`${message.payload?.provider || ""}`.trim())
      };
    case "monitor:poll-now":
      return {
        monitorState: await pollEmailMonitor(`${message.payload?.provider || ""}`.trim(), {
          force: true
        })
      };
    case "monitor:open-thread":
      return await handleOpenQueuedThread(message.payload || {});
    case "monitor:draft-reply":
      return await handleDraftQueuedReply(message.payload || {});
    case "monitor:send-reply":
      return await handleSendQueuedReply(message.payload || {});
    case "monitor:dismiss-thread":
      return await handleDismissQueuedThread(message.payload || {});
    case "monitor:update-draft":
      return await handleUpdateQueuedDraft(message.payload || {});
    case "monitor:draft-current-thread":
      return await handleDraftCurrentThread(message.payload || {});
    case "gmail:review-send-triggered":
      return await handleReviewSendTriggered(message.payload || {}, sender);
    case "page:get-context":
      return { pageContext: await executeAgentAction("get_page_snapshot") };
    case "claude:complete":
      return await handleClaudeCompletion(message.payload || {});
    case "agent:plan-task":
      return await handleTaskPlanning(message.payload || {});
    case "agent:get-actions":
      return { actions: AGENT_ACTIONS };
    case "agent:run-action":
      return await handleAgentAction(message.payload || {});
    case "agent:run-plan":
      return await handleAgentPlan(message.payload || {});
    case "agent:open-panel":
      await openAgentPanel();
      return { opened: true };
    default:
      throw new Error("Unsupported message type.");
  }
}

async function handleClaudeCompletion(payload) {
  const prompt = `${payload.prompt || ""}`.trim();

  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const settings = await getSettings();

  if (!settings.apiKey) {
    throw new Error("The A.I. API key is missing. Add it on the settings page.");
  }

  const pageContext = payload.includePageContext ? await executeAgentAction("get_page_snapshot") : null;
  const userMessage = buildUserMessage(prompt, pageContext);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: settings.model,
      system: settings.systemPrompt,
      max_tokens: Number(settings.maxTokens) || 512,
      messages: [
        {
          role: "user",
          content: userMessage
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Anthropic request failed.");
  }

  const text = extractText(data);

  if (!text) {
    throw new Error("Anthropic returned no text.");
  }

  await setLastResponse(text);
  return { text, raw: data, pageContext };
}

async function handleTaskPlanning(payload) {
  const goal = `${payload.goal || ""}`.trim();

  if (!goal) {
    throw new Error("A task goal is required.");
  }

  const settings = await getSettings();

  if (!settings.apiKey) {
    throw new Error("The A.I. API key is missing. Add it on the settings page.");
  }

  const provider = await getActiveEmailProvider();
  const pageContext = payload.includePageContext === false ? null : await executeAgentAction("get_page_snapshot");
  const emailContext = provider?.id ? await getProviderPlanningContext(provider.id) : null;
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: settings.model,
      system: `${settings.systemPrompt}\n\nYou convert user goals into short browser-action plans. Return strict JSON only, with no markdown fences.`,
      max_tokens: 900,
      messages: [
        {
          role: "user",
          content: buildPlanningPrompt(goal, pageContext, provider, emailContext)
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Anthropic planning request failed.");
  }

  const text = extractText(data);

  if (!text) {
    throw new Error("The A.I. returned no planning output.");
  }

  const plan = parsePlanResponse(text);
  return {
    goal,
    provider,
    pageContext,
    emailContext,
    plan,
    rawText: text
  };
}

async function handleAgentAction(payload) {
  const action = `${payload.action || ""}`.trim();
  const definition = AGENT_ACTIONS.find((item) => item.id === action);

  if (!definition) {
    throw new Error("Unknown action.");
  }

  const args = payload.args && typeof payload.args === "object" ? payload.args : {};

  if (definition.requiresConfirmation && !payload.confirm) {
    throw new Error(`Action ${action} requires confirmation before it can modify the page.`);
  }

  return {
    action,
    result: await executeAgentAction(action, args)
  };
}

async function handleAgentPlan(payload) {
  const steps = Array.isArray(payload.steps) ? payload.steps : [];

  if (steps.length === 0) {
    throw new Error("Plan must include at least one step.");
  }

  if (steps.length > 10) {
    throw new Error("Plan execution is limited to 10 steps.");
  }

  const observeAfterEach = payload.observeAfterEach !== false;
  const approveWrites = !!payload.approveWrites;
  const stepResults = [];

  for (let index = 0; index < steps.length; index += 1) {
    const rawStep = steps[index];
    const action = `${rawStep?.action || ""}`.trim();
    const definition = AGENT_ACTIONS.find((item) => item.id === action);

    if (!definition) {
      return {
        status: "failed",
        stepResults,
        failedStep: {
          index,
          action,
          error: "Unknown action."
        }
      };
    }

    if (definition.requiresConfirmation && !(approveWrites || rawStep?.confirm)) {
      return {
        status: "approval_required",
        stepResults,
        pendingStep: {
          index,
          action,
          reason: `Step ${index + 1} uses ${action}, which requires approval before modifying the page.`,
          step: {
            action,
            args: rawStep?.args && typeof rawStep.args === "object" ? rawStep.args : {}
          }
        }
      };
    }

    try {
      const args = refineStepArgs(action, rawStep?.args, stepResults);
      const result = await executeAgentAction(action, args);
      const stepResult = {
        index,
        action,
        result
      };

      if (observeAfterEach && action !== "get_page_snapshot") {
        stepResult.observedPage = await executeAgentAction("get_page_snapshot");
      }

      stepResults.push(stepResult);
    } catch (error) {
      return {
        status: "failed",
        stepResults,
        failedStep: {
          index,
          action,
          error: error instanceof Error ? error.message : "Unknown error"
        }
      };
    }
  }

  return {
    status: "completed",
    stepResults
  };
}

function refineStepArgs(action, rawArgs, stepResults) {
  const args = rawArgs && typeof rawArgs === "object" ? structuredCloneSafe(rawArgs) : {};

  if (action === "set_input_value" || action === "submit_form") {
    const resolvedTarget = resolveTargetFromPreviousResults(args.target, stepResults, { preferFields: true });
    if (resolvedTarget) {
      args.target = resolvedTarget;
    } else if (args.target?.text && !args.target.label) {
      args.target = {
        ...args.target,
        label: args.target.text
      };
    }
  }

  if (action === "click_element") {
    const resolvedTarget = resolveTargetFromPreviousResults(args.target, stepResults, { preferElements: true });
    if (resolvedTarget) {
      args.target = resolvedTarget;
    }
  }

  return args;
}

function resolveTargetFromPreviousResults(target, stepResults, options = {}) {
  if (!target || typeof target !== "object") {
    return null;
  }

  if (target.selector || target.id || target.name || target.label) {
    return null;
  }

  for (let index = stepResults.length - 1; index >= 0; index -= 1) {
    const result = stepResults[index]?.result;
    const candidates = [];

    if (options.preferFields && Array.isArray(result?.fields)) {
      candidates.push(...result.fields);
    }

    if (options.preferElements && Array.isArray(result?.elements)) {
      candidates.push(...result.elements);
    }

    const matched = candidates.find((candidate) => candidateMatchesTarget(candidate, target));

    if (matched?.target) {
      return matched.target;
    }
  }

  return null;
}

function candidateMatchesTarget(candidate, target) {
  const textNeedle = normalizeMatchValue(target.text);
  const labelNeedle = normalizeMatchValue(target.label);
  const nameNeedle = normalizeMatchValue(target.name);
  const placeholderNeedle = normalizeMatchValue(target.placeholder);
  const contextNeedle = normalizeMatchValue(target.contextText);

  if (textNeedle) {
    const candidateText = normalizeMatchValue(candidate.text);
    const candidateLabel = normalizeMatchValue(candidate.label);
    const candidateContext = normalizeMatchValue(candidate.contextText);

    if (candidateText.includes(textNeedle) || candidateLabel.includes(textNeedle) || candidateContext.includes(textNeedle)) {
      return true;
    }
  }

  if (labelNeedle && normalizeMatchValue(candidate.label).includes(labelNeedle)) {
    return true;
  }

  if (nameNeedle && normalizeMatchValue(candidate.name) === nameNeedle) {
    return true;
  }

  if (placeholderNeedle && normalizeMatchValue(candidate.placeholder).includes(placeholderNeedle)) {
    return true;
  }

  if (contextNeedle && normalizeMatchValue(candidate.contextText).includes(contextNeedle)) {
    return true;
  }

  return false;
}

function normalizeMatchValue(value) {
  return `${value || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildPlanningPrompt(goal, pageContext, provider, emailContext) {
  const actionCatalog = AGENT_ACTIONS.map((action) => ({
    action: action.id,
    description: action.description,
    risk: action.risk,
    requiresConfirmation: action.requiresConfirmation,
    exampleArgs: action.exampleArgs || {}
  }));

  const pageSummary = pageContext
    ? {
        title: pageContext.title || "",
        url: pageContext.url || "",
        language: pageContext.language || "",
        selection: pageContext.selection || "",
        headings: pageContext.headings || [],
        paragraphs: pageContext.paragraphs || [],
        visibleText: pageContext.visibleText || ""
      }
    : null;

  return [
    "Create a short browser-action plan for the user's goal.",
    "You may only use the provided actions.",
    provider ? `Detected email provider: ${provider.label}` : "No supported email provider detected on this tab.",
    provider?.plannerGuidance || "Use generic actions if no provider-specific actions fit.",
    "Prefer read steps before write steps.",
    "Only include write steps when necessary.",
    "For email workflows, prefer opening and filling a reply draft instead of sending automatically.",
    "Keep plans to 2-6 steps.",
    "Return JSON with this exact shape:",
    '{"summary":"...", "steps":[{"action":"...", "args":{}, "reason":"...", "risk":"read|write"}]}',
    "",
    `User goal: ${goal}`,
    "",
    `Available actions: ${JSON.stringify(actionCatalog, null, 2)}`,
    "",
    `Current page snapshot: ${JSON.stringify(pageSummary, null, 2)}`,
    "",
    `Provider-specific email context: ${JSON.stringify(emailContext, null, 2)}`
  ].join("\n");
}

async function getActiveEmailProvider() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  const url = `${tab?.url || tab?.pendingUrl || ""}`.trim();
  return url ? detectEmailProviderFromUrl(url) : null;
}

async function getProviderPlanningContext(providerId) {
  if (providerId === "gmail") {
    const threadContext = await executeAgentAction("gmail_extract_thread_context").catch(() => null);

    if (threadContext?.subject || threadContext?.latestMessage) {
      return threadContext;
    }

    return await executeAgentAction("gmail_list_inbox_threads").catch(() => null);
  }

  if (providerId === "outlook") {
    const threadContext = await executeAgentAction("outlook_extract_thread_context").catch(() => null);

    if (threadContext?.subject || threadContext?.latestMessage) {
      return threadContext;
    }

    return await executeAgentAction("outlook_list_inbox_threads").catch(() => null);
  }

  return null;
}

async function setSelectedMonitorProvider(providerId) {
  const provider = getMonitorProvider(providerId);
  const state = await getMonitorState();
  return await saveMonitorState({
    ...state,
    selectedProvider: provider.id
  });
}

async function setMonitorEnabled(providerId, enabled) {
  const provider = getMonitorProvider(providerId);
  const currentState = await getMonitorState();
  const now = new Date().toISOString();
  const currentProviderState = getProviderMonitorState(currentState, provider.id);
  const automationTabId = enabled
    ? await pickProviderAutomationTabId(provider.id)
    : null;
  const providerPatch = enabled
    ? resetProviderForFreshStart({
        ...currentProviderState,
        automationTabId,
        enabled,
        pauseReason: "",
        pausedAt: "",
        pollFailureCount: 0
      })
    : releasePendingReview(currentProviderState, {
        now,
        reviewNote: "Left for you because automation was paused before the draft could continue.",
        lastError: ""
      });
  const nextState = await saveMonitorState({
    ...currentState,
    selectedProvider: provider.id,
    providers: {
      ...currentState.providers,
      [provider.id]: {
        ...providerPatch,
        enabled,
        automationTabId,
        pauseReason: "",
        pausedAt: enabled ? "" : now,
        pollFailureCount: 0
      }
    }
  });

  await reconcileMonitorAlarm(nextState);

  if (enabled) {
    await focusProviderAutomationInbox(provider.id, automationTabId);
    queueAutomationKick(provider.id);
    scheduleAutomationWatchdog(provider.id);
    startAutomationSoon(provider.id);
  } else {
    await cancelProviderAutomationKick(provider.id);
    await cancelAutomationWatchdog(provider.id);
    invalidateProviderKickNonce(provider.id);
  }

  return nextState;
}

async function handleOpenQueuedThread(payload) {
  const provider = getMonitorProvider(payload.provider);
  const threadId = `${payload.threadId || ""}`.trim();

  if (!threadId) {
    throw new Error("A queued thread id is required.");
  }

  const state = await getMonitorState();
  const thread = findQueuedThread(state, provider.id, threadId);

  if (!thread) {
    throw new Error("The queued thread could not be found.");
  }

  const tab = await openQueuedThread(provider.id, thread);
  const nextStatus = ["skipped", "needs-attention", "error", "drafted", "awaiting-review-send"].includes(`${thread.status || ""}`)
    ? thread.status
    : "opened";
  const nextState = await updateQueuedThread(provider.id, threadId, {
    sourceTabId: tab.id || thread.sourceTabId,
    status: nextStatus,
    lastOpenedAt: new Date().toISOString(),
    lastError: ""
  });

  return {
    monitorState: nextState,
    openedThread: {
      provider: provider.id,
      threadId,
      tabId: tab.id || null
    }
  };
}

async function handleDraftQueuedReply(payload) {
  const provider = getMonitorProvider(payload.provider);
  const threadId = `${payload.threadId || ""}`.trim();

  if (!threadId) {
    throw new Error("A queued thread id is required.");
  }

  const settings = await getSettings();

  let state = await updateQueuedThread(provider.id, threadId, {
    status: "drafting",
    lastError: ""
  });
  let thread = findQueuedThread(state, provider.id, threadId);

  if (!thread) {
    throw new Error("The queued thread could not be found.");
  }

  try {
    const threadContext = {
      provider: provider.id,
      subject: `${thread.subject || ""}`.trim(),
      senders: [
        {
          name: `${thread.sender || ""}`.trim(),
          email: `${thread.senderEmail || ""}`.trim()
        }
      ].filter((item) => item.name || item.email),
      latestMessage: `${thread.preview || ""}`.trim(),
      threadMessages: [`${thread.preview || ""}`.trim()].filter(Boolean),
      sourceUrl: `${thread.sourceUrl || ""}`.trim(),
      queuedAt: `${thread.addedAt || ""}`.trim()
    };
    const decision = await generateEmailReplyDraft(settings, provider.id, threadContext, payload.instructions);

    if (decision.type === "skip") {
      state = await updateQueuedThread(provider.id, threadId, {
        status: "skipped",
        skipReason: decision.reason,
        reviewNote: "",
        draftText: "",
        draftPreview: "",
        lastSkippedAt: new Date().toISOString(),
        lastError: ""
      });

      return {
        monitorState: state,
        draft: "",
        noReply: true,
        reason: decision.reason
      };
    }

    if (decision.type === "attention") {
      state = await updateQueuedThread(provider.id, threadId, {
        status: "needs-attention",
        skipReason: "",
        reviewNote: decision.reason,
        draftText: "",
        draftPreview: "",
        lastError: ""
      });

      return {
        monitorState: state,
        draft: "",
        needsAttention: true,
        reason: decision.reason
      };
    }

    const draft = decision.draft;

    state = await updateQueuedThread(provider.id, threadId, {
      status: "drafted",
      draftText: draft,
      draftPreview: draft.slice(0, 1200),
      lastDraftAt: new Date().toISOString(),
      skipReason: "",
      reviewNote: "",
      lastError: ""
    });

    return {
      monitorState: state,
      threadContext,
      draft
    };
  } catch (error) {
    state = await updateQueuedThread(provider.id, threadId, {
      status: "error",
      lastError: error instanceof Error ? error.message : "Unknown draft error"
    });

    return {
      monitorState: state,
      draft: "",
      error: error instanceof Error ? error.message : "Unknown draft error"
    };
  }
}

async function handleSendQueuedReply(payload) {
  const provider = getMonitorProvider(payload.provider);
  const threadId = `${payload.threadId || ""}`.trim();

  if (!threadId) {
    throw new Error("A queued thread id is required.");
  }

  let state = await updateQueuedThread(provider.id, threadId, {
    status: "sending",
    lastError: ""
  });
  let thread = findQueuedThread(state, provider.id, threadId);

  if (!thread) {
    throw new Error("The queued thread could not be found.");
  }

  try {
    const queuedDraftText = `${payload.draftText || thread.draftText || thread.draftPreview || ""}`.trim();
    if (payload.autoReplyFlow) {
      await ensureAutomationStillRunning(provider.id, {
        requireAutoReply: true
      });
    }
    const settings = await getSettings();

    const tab = await openQueuedThread(provider.id, thread);
    const threadContext = await waitForThreadContext(provider.id, tab.id);
    if (payload.autoReplyFlow) {
      await ensureAutomationStillRunning(provider.id, {
        requireAutoReply: true
      });
    }
    const reviewReason = payload.autoReplyFlow ? getAutoSendReviewReason(settings, thread, threadContext) : "";
    const decision = queuedDraftText
      ? { type: "reply", draft: queuedDraftText }
      : await generateEmailReplyDraft(settings, provider.id, threadContext, payload.instructions);

    if (decision.type === "skip") {
      state = await updateQueuedThread(provider.id, threadId, {
        sourceTabId: tab.id || thread.sourceTabId,
        status: "skipped",
        skipReason: decision.reason,
        reviewNote: "",
        draftText: "",
        draftPreview: "",
        lastSkippedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        lastError: ""
      });

      if (payload.autoReplyFlow) {
        await ensureAutomationStillRunning(provider.id, {
          requireAutoReply: true
        });
      }
      await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl || threadContext?.sourceUrl || "");

      return {
        monitorState: state,
        draft: "",
        noReply: true,
        reason: decision.reason,
        sent: false
      };
    }

    if (decision.type === "attention") {
      state = await updateQueuedThread(provider.id, threadId, {
        sourceTabId: tab.id || thread.sourceTabId,
        status: "needs-attention",
        skipReason: "",
        reviewNote: decision.reason,
        draftText: "",
        draftPreview: "",
        lastOpenedAt: new Date().toISOString(),
        lastError: ""
      });

      if (payload.autoReplyFlow) {
        await ensureAutomationStillRunning(provider.id, {
          requireAutoReply: true
        });
      }
      await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl || threadContext?.sourceUrl || "");

      return {
        monitorState: state,
        draft: "",
        needsAttention: true,
        reason: decision.reason,
        sent: false
      };
    }

    const draft = decision.draft;

    if (reviewReason) {
      state = await updateQueuedThread(provider.id, threadId, {
        sourceTabId: tab.id || thread.sourceTabId,
        status: "needs-attention",
        draftText: "",
        draftPreview: "",
        lastDraftAt: "",
        lastOpenedAt: new Date().toISOString(),
        skipReason: "",
        reviewNote: reviewReason,
        lastError: ""
      });

      if (payload.autoReplyFlow) {
        await ensureAutomationStillRunning(provider.id, {
          requireAutoReply: true
        });
      }
      await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl || threadContext?.sourceUrl || "");

      return {
        monitorState: state,
        threadContext,
        draft: "",
        sent: false,
        needsAttention: true,
        reviewReason
      };
    }

    if (payload.autoReplyFlow) {
      await ensureAutomationStillRunning(provider.id, {
        requireAutoReply: true
      });
    }
    await ensureReplyBoxOpen(provider.id, tab.id, threadContext);
    await fillReplyDraft(provider.id, tab.id, draft);
    if (payload.autoReplyFlow) {
      await ensureAutomationStillRunning(provider.id, {
        requireAutoReply: true
      });
    }
    await sendReply(provider.id, tab.id);

    state = await updateQueuedThread(provider.id, threadId, {
      sourceTabId: tab.id || thread.sourceTabId,
      status: "sent",
      draftText: draft,
      draftPreview: draft.slice(0, 1200),
      lastDraftAt: new Date().toISOString(),
      lastSentAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      skipReason: "",
      reviewNote: "",
      lastError: ""
    });

    if (payload.autoReplyFlow) {
      await ensureAutomationStillRunning(provider.id, {
        requireAutoReply: true
      });
    }
    await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl || threadContext?.sourceUrl || "");

    return {
      monitorState: state,
      threadContext,
      draft,
      sent: true
    };
  } catch (error) {
    if (isAutomationStoppedError(error)) {
      return {
        monitorState: error.monitorState || await getMonitorState(),
        draft: "",
        sent: false,
        stopped: true
      };
    }

    state = await updateQueuedThread(provider.id, threadId, {
      status: "error",
      lastError: error instanceof Error ? error.message : "Unknown send error"
    });

    return {
      monitorState: state,
      draft: "",
      error: error instanceof Error ? error.message : "Unknown send error",
      sent: false
    };
  }
}

async function handleDismissQueuedThread(payload) {
  const provider = getMonitorProvider(payload.provider);
  const threadId = `${payload.threadId || ""}`.trim();

  if (!threadId) {
    throw new Error("A queued thread id is required.");
  }

  const state = await getMonitorState();
  const providerState = getProviderMonitorState(state, provider.id);
  const remainingQueue = Array.isArray(providerState.inboxQueue)
    ? providerState.inboxQueue.filter((item) => item.threadId !== threadId)
    : [];

  return {
    monitorState: await saveMonitorState({
      ...state,
      providers: {
        ...state.providers,
        [provider.id]: {
          ...providerState,
          inboxQueue: remainingQueue
        }
      }
    }),
    dismissed: true
  };
}

async function handleUpdateQueuedDraft(payload) {
  const provider = getMonitorProvider(payload.provider);
  const threadId = `${payload.threadId || ""}`.trim();

  if (!threadId) {
    throw new Error("A queued thread id is required.");
  }

  const draftText = `${payload.draftText || ""}`;
  const state = await updateQueuedThread(provider.id, threadId, {
    draftText,
    draftPreview: draftText.slice(0, 1200)
  });

  return {
    monitorState: state,
    draft: draftText
  };
}

async function handleDraftCurrentThread(payload) {
  const provider = getMonitorProvider(payload.provider || "gmail");

  if (provider.id !== "gmail") {
    throw new Error("One-time drafting is only available for Gmail.");
  }

  const state = await getMonitorState();
  const providerState = getProviderMonitorState(state, provider.id);

  if (providerState.enabled) {
    throw new Error("Pause automation before using one-time drafting.");
  }

  if (providerState.pendingReview?.threadId) {
    throw new Error("Finish the review draft already open in Gmail first.");
  }

  const tab = await getActiveProviderTab(provider.id);
  const threadContext = await waitForThreadContext(provider.id, tab.id, 5000).catch(() => null);

  if (!threadContext?.subject && !threadContext?.latestMessage) {
    throw new Error("Open the Gmail email you want first, then try again.");
  }

  const settings = await getSettings();
  const result = await composeReplyDraftInThread(settings, provider.id, tab.id, threadContext, payload.instructions);

  if (result.type === "skip") {
    return {
      drafted: false,
      noReply: true,
      reason: result.reason,
      threadContext
    };
  }

  if (result.type === "attention") {
    return {
      drafted: false,
      needsAttention: true,
      reason: result.reason,
      threadContext
    };
  }

  return {
    drafted: true,
    draft: result.draft,
    threadContext
  };
}

async function handleSettingsSandboxTest(payload) {
  const settings = await getSettings();
  const senderName = `${payload.senderName || ""}`.trim();
  const senderEmail = `${payload.senderEmail || ""}`.trim();
  const subject = `${payload.subject || ""}`.trim();
  const latestMessage = `${payload.latestMessage || ""}`.trim();
  const rawThreadMessages = Array.isArray(payload.threadMessages) ? payload.threadMessages : [];
  const threadMessages = rawThreadMessages
    .map((message) => `${message || ""}`.trim())
    .filter(Boolean);

  if (!latestMessage && threadMessages.length === 0) {
    throw new Error("Add a mock email message first.");
  }

  const threadContext = {
    provider: "gmail",
    subject,
    senders: [
      {
        name: senderName,
        email: senderEmail
      }
    ].filter((item) => item.name || item.email),
    latestMessage,
    threadMessages,
    sourceUrl: "sandbox://settings"
  };
  const decision = await generateEmailReplyDraft(settings, "gmail", threadContext);

  if (decision.type === "skip") {
    return {
      noReply: true,
      reason: decision.reason,
      subject,
      senderName,
      senderEmail
    };
  }

  if (decision.type === "attention") {
    return {
      needsAttention: true,
      reason: decision.reason,
      subject,
      senderName,
      senderEmail
    };
  }

  return {
    draft: decision.draft,
    subject,
    senderName,
    senderEmail
  };
}

async function handleReviewSendTriggered(payload, sender) {
  const tabId = Number(sender?.tab?.id);
  const state = await getMonitorState();
  const provider = getMonitorProvider("gmail");
  const providerState = getProviderMonitorState(state, provider.id);
  const pendingReview = providerState.pendingReview;

  if (!providerState.enabled || providerState.autoReplyEnabled || !pendingReview?.threadId) {
    return { acknowledged: false };
  }

  if (pendingReview.tabId && Number.isInteger(tabId) && pendingReview.tabId !== tabId) {
    return { acknowledged: false };
  }

  let nextState = state;
  const queuedThread = findQueuedThread(nextState, provider.id, pendingReview.threadId);

  if (queuedThread) {
    nextState = await updateQueuedThread(provider.id, pendingReview.threadId, {
      status: "sent",
      lastSentAt: new Date().toISOString(),
      reviewNote: "",
      lastError: ""
    });
  }

  nextState = await updateProviderMonitorState(nextState, provider.id, {
    pendingReview: null,
    pauseReason: "",
    pausedAt: ""
  });

  if (!getProviderMonitorState(nextState, provider.id).enabled) {
    return {
      acknowledged: true,
      monitorState: nextState
    };
  }

  await delay(REVIEW_CONTINUE_DELAY_MS);
  try {
    await ensureAutomationStillRunning(provider.id, {
      requireReviewMode: true
    });
  } catch (error) {
    if (isAutomationStoppedError(error)) {
      return {
        acknowledged: true,
        monitorState: error.monitorState || await getMonitorState()
      };
    }

    throw error;
  }
  await navigateTabToProviderInbox(provider.id, pendingReview.tabId, pendingReview.sourceUrl || `${sender?.tab?.url || ""}`.trim());
  nextState = await pollProviderInbox(nextState, provider.id);
  nextState = await processAutonomousReplies(nextState, provider.id);

  return {
    acknowledged: true,
    monitorState: nextState,
    subject: `${payload?.subject || pendingReview.subject || ""}`.trim()
  };
}

async function reconcileMonitorAlarm(state) {
  await chrome.alarms.clear(EMAIL_MONITOR_ALARM);

  const providerStates = Object.values(state?.providers || {});
  const enabledProviders = providerStates.filter((providerState) => providerState?.enabled);

  if (enabledProviders.length === 0) {
    return;
  }

  const intervalMinutes = Math.min(
    ...enabledProviders.map((providerState) => Math.max(1, Number(providerState.intervalMinutes) || 1))
  );

  await chrome.alarms.create(EMAIL_MONITOR_ALARM, {
    periodInMinutes: intervalMinutes
  });
}

async function pollEmailMonitor(providerId, options = {}) {
  const state = await getMonitorState();
  const providerIds = providerId
    ? [getMonitorProvider(providerId).id]
    : Object.keys(state.providers || {}).filter((id) => getProviderMonitorState(state, id).enabled);

  if (providerIds.length === 0) {
    return state;
  }

  let nextState = state;

  for (const currentProviderId of providerIds) {
    nextState = await pollProviderInbox(nextState, currentProviderId, options);
    nextState = await processAutonomousReplies(nextState, currentProviderId);
  }

  return nextState;
}

async function setMonitorAutoReplyEnabled(providerId, enabled) {
  const provider = getMonitorProvider(providerId);
  const currentState = await getMonitorState();
  const currentProviderState = getProviderMonitorState(currentState, provider.id);
  const nextProviderState = enabled
    ? releasePendingReview(currentProviderState, {
        now: new Date().toISOString(),
        reviewNote: "Left for you because automatic sending was turned on.",
        lastError: ""
      })
    : currentProviderState;
  const nextState = await saveMonitorState({
    ...currentState,
    selectedProvider: provider.id,
    providers: {
      ...currentState.providers,
      [provider.id]: {
        ...nextProviderState,
        autoReplyEnabled: enabled
      }
    }
  });

  if (getProviderMonitorState(nextState, provider.id).enabled) {
    queueAutomationKick(provider.id);
    scheduleAutomationWatchdog(provider.id);
    startAutomationSoon(provider.id);
  }

  return nextState;
}

async function pollProviderInbox(state, providerId, options = {}) {
  let providerState = getProviderMonitorState(state, providerId);

  if (!providerState.enabled && !options.force) {
    return state;
  }

  const provider = getMonitorProvider(providerId);
  const settings = await getSettings();
  const actionId = provider.id === "gmail" ? "gmail_list_inbox_threads" : "outlook_list_inbox_threads";
  const availableTabs = await chrome.tabs.query({
    url: provider.hostPermissions
  });
  const selectedTab = pickPreferredProviderTab(availableTabs, providerState.automationTabId);
  const tabs = provider.id === "gmail"
    ? (selectedTab ? [selectedTab] : [])
    : availableTabs;
  const now = new Date().toISOString();
  const hasAutonomousQueue = providerState.autoReplyEnabled
    && Array.isArray(providerState.inboxQueue)
    && providerState.inboxQueue.some((item) => item.threadId && item.status === "queued");

  if (tabs.length === 0 && !hasAutonomousQueue) {
    return await pauseMonitorProviderState(
      state,
      provider.id,
      `${provider.label} is no longer open. Go to the inbox you want me to work on and press Start again.`
    );
  }

  if (provider.id === "gmail" && selectedTab?.id && providerState.automationTabId !== selectedTab.id) {
    state = await updateProviderMonitorState(state, provider.id, {
      automationTabId: selectedTab.id
    });
    providerState = getProviderMonitorState(state, provider.id);
  }

  const allThreads = [];
  let successfulPolls = 0;
  let gmailUnreadViewActive = false;

  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }

    try {
      const threads = await executeAgentActionOnTab(tab.id, actionId);
      successfulPolls += 1;

      if (provider.id === "gmail" && isGmailUnreadViewUrl(`${threads?.location || tab.url || tab.pendingUrl || ""}`.trim())) {
        gmailUnreadViewActive = true;
      }

      if (Array.isArray(threads?.threads)) {
        allThreads.push(
          ...threads.threads.map((thread) => ({
            ...thread,
            provider: provider.id,
            sourceTabId: tab.id,
            sourceUrl: `${tab.url || tab.pendingUrl || ""}`.trim()
          }))
        );
      }
    } catch {
      // Ignore individual tab failures and continue polling others.
    }
  }

  const shouldRefreshInboxView = provider.id === "gmail"
    && tabs.length > 0
    && allThreads.length === 0
    && !findNextQueuedThread(providerState)
    && !providerState.pendingReview?.threadId;

  if (shouldRefreshInboxView) {
    const inboxTab = tabs.find((tab) => tab.id) || null;

    if (inboxTab?.id) {
      try {
        const refreshedTab = await chrome.tabs.update(inboxTab.id, {
          active: true,
          url: buildProviderInboxUrl(provider, `${inboxTab.url || inboxTab.pendingUrl || ""}`.trim())
        });

        await delay(1600);

        const refreshedThreads = await executeAgentActionOnTab(refreshedTab.id, actionId);
        successfulPolls += 1;

        if (Array.isArray(refreshedThreads?.threads)) {
          allThreads.push(
            ...refreshedThreads.threads.map((thread) => ({
              ...thread,
              provider: provider.id,
              sourceTabId: refreshedTab.id,
              sourceUrl: `${refreshedTab.url || refreshedTab.pendingUrl || ""}`.trim()
            }))
          );
        }
      } catch {
        // Ignore inbox refresh failures and fall through to normal pause/error handling.
      }
    }
  }

  if (tabs.length > 0 && successfulPolls === 0) {
    const nextFailureCount = providerState.pollFailureCount + 1;
    const liveState = await getMonitorState();
    const liveProviderState = getProviderMonitorState(liveState, provider.id);

    if (!liveProviderState.enabled && !options.force) {
      return liveState;
    }

    if (nextFailureCount >= 2) {
      return await pauseMonitorProviderState(
        liveState,
        provider.id,
        `I couldn't read ${provider.label} reliably. Go back to the inbox you want me to work on and press Start again.`,
        {
          lastCheckedAt: now,
          pollFailureCount: nextFailureCount
        }
      );
    }

    return await saveMonitorState({
      ...liveState,
      providers: {
        ...liveState.providers,
        [provider.id]: {
          ...liveProviderState,
          lastCheckedAt: now,
          pollFailureCount: nextFailureCount
        }
      }
    });
  }

  const uniqueThreads = dedupeThreads(allThreads);
  const preservedHistoryEntries = dedupeQueueEntriesByThreadId(
    Array.isArray(providerState.inboxQueue)
      ? providerState.inboxQueue.filter((item) => isHistoryStatus(item.status))
      : []
  );
  const preservedHistoryThreadIds = new Set(
    preservedHistoryEntries
      .map((item) => buildThreadIdentityKey(item))
      .filter(Boolean)
  );
  const activeEntries = dedupeQueueEntriesByThreadId(
    Array.isArray(providerState.inboxQueue)
      ? providerState.inboxQueue
          .filter((item) => isActiveQueueStatus(item.status))
          .filter((item) => !preservedHistoryThreadIds.has(buildThreadIdentityKey(item)))
      : []
  );
  const queuedThreadIds = new Set(
    [...activeEntries]
      .map((item) => buildThreadIdentityKey(item))
      .filter(Boolean)
  );
  const eligibleThreads = uniqueThreads
    .filter((thread) => thread.threadId)
    .filter((thread) => !queuedThreadIds.has(buildThreadIdentityKey(thread)))
    .filter((thread) => shouldQueueThreadForCurrentView(settings, thread, {
      fromUnreadView: provider.id === "gmail" && gmailUnreadViewActive
    }));
  const newThreads = (provider.id === "gmail" && gmailUnreadViewActive ? eligibleThreads.slice(0, 1) : eligibleThreads)
    .map((thread) => ({
      ...thread,
      provider: provider.id,
      addedAt: now,
      status: "queued",
      skipReason: "",
      reviewNote: "",
      lastError: "",
      draftText: "",
      draftPreview: ""
    }));
  const nextQueue = dedupeQueueEntriesByThreadId([
    ...activeEntries.filter((item) => item.threadId),
    ...newThreads,
    ...preservedHistoryEntries
  ]).slice(0, 80);
  const liveState = await getMonitorState();
  const liveProviderState = getProviderMonitorState(liveState, provider.id);

  if (!liveProviderState.enabled && !options.force) {
    return liveState;
  }

  const savedState = await saveMonitorState({
    ...liveState,
    providers: {
      ...liveState.providers,
      [provider.id]: {
        ...liveProviderState,
        lastCheckedAt: now,
        pauseReason: "",
        pausedAt: "",
        pollFailureCount: 0,
        inboxQueue: nextQueue,
        seenThreadIds: []
      }
    }
  });

  const canAdvanceToNextGmailPage = provider.id === "gmail"
    && !providerState.pendingReview?.threadId
    && !nextQueue.some((item) => item.threadId && item.status === "queued")
    && (Number(options.pageDepth) || 0) < 6;

  if (canAdvanceToNextGmailPage) {
    const movedToNextPage = await moveAnyGmailTabToNextPage(tabs);

    if (movedToNextPage) {
      return await pollProviderInbox(savedState, provider.id, {
        ...options,
        pageDepth: (Number(options.pageDepth) || 0) + 1
      });
    }
  }

  return savedState;
}

async function processAutonomousReplies(state, providerId) {
  const provider = getMonitorProvider(providerId);
  const providerState = getProviderMonitorState(state, provider.id);

  if (provider.id !== "gmail") {
    return state;
  }

  if (!providerState.enabled) {
    return state;
  }

  if (autoReplyProvidersInFlight.has(provider.id)) {
    return state;
  }

  autoReplyProvidersInFlight.add(provider.id);

  try {
    return providerState.autoReplyEnabled
      ? await processAutoSendReplies(state, provider.id)
      : await processReviewReplies(state, provider.id);
  } finally {
    autoReplyProvidersInFlight.delete(provider.id);
  }
}

async function processAutoSendReplies(state, providerId) {
  let nextState = state;

  while (true) {
    nextState = await getMonitorState();
    const providerState = getProviderMonitorState(nextState, providerId);

    if (!providerState.enabled || !providerState.autoReplyEnabled) {
      break;
    }

    const directResult = await handleDirectAutoReplyFromUnreadView(nextState, providerId);

    if (directResult?.handled) {
      nextState = directResult.monitorState || nextState;
      await delay(AUTO_REPLY_DELAY_MS);
      continue;
    }

    if (directResult?.stopped) {
      nextState = directResult.monitorState || await getMonitorState();
      break;
    }

    if (directResult?.error) {
      nextState = directResult.monitorState || nextState;

      if (shouldPauseAfterAutomationError(directResult.error)) {
        nextState = await pauseMonitorProviderState(nextState, providerId, buildAutomationPauseReason(getMonitorProvider(providerId)));
      }

      break;
    }

    nextState = await recoverAutoSendLoop(nextState, providerId);
    await delay(AUTO_REPLY_DELAY_MS);
  }

  return nextState;
}

async function recoverAutoSendLoop(state, providerId) {
  const provider = getMonitorProvider(providerId);
  const providerState = getProviderMonitorState(state, provider.id);

  if (!providerState.enabled || !providerState.autoReplyEnabled) {
    return state;
  }

  const tabs = await chrome.tabs.query({
    url: provider.hostPermissions
  });
  const tab = pickPreferredProviderTab(tabs, providerState.automationTabId);

  if (!tab?.id) {
    return await pauseMonitorProviderState(
      state,
      provider.id,
      `${provider.label} is no longer open. Go to the inbox you want me to work on and press Start again.`
    );
  }

  const listing = await executeAgentActionOnTab(tab.id, "gmail_list_inbox_threads", {}).catch(() => null);
  const location = `${listing?.location || tab.url || tab.pendingUrl || ""}`.trim();

  if (!isGmailUnreadViewUrl(location)) {
    await focusProviderAutomationInbox(provider.id, tab.id);
    return await getMonitorState();
  }

  if (Array.isArray(listing?.threads) && listing.threads.length > 0) {
    return state;
  }

  const movedToNextPage = await moveAnyGmailTabToNextPage([tab]);

  if (movedToNextPage) {
    return await getMonitorState();
  }

  await focusProviderAutomationInbox(provider.id, tab.id);
  return await getMonitorState();
}

async function handleDirectAutoReplyFromUnreadView(state, providerId) {
  const provider = getMonitorProvider(providerId);

  if (provider.id !== "gmail") {
    return {
      monitorState: state,
      handled: false
    };
  }

  const providerState = getProviderMonitorState(state, provider.id);

  if (!providerState.enabled || !providerState.autoReplyEnabled) {
    return {
      monitorState: state,
      handled: false
    };
  }

  const tabs = await chrome.tabs.query({
    url: provider.hostPermissions
  });
  const tab = pickPreferredProviderTab(tabs, providerState.automationTabId);

  if (!tab?.id) {
    return {
      monitorState: state,
      handled: false
    };
  }

  await waitForProviderInboxReady(provider.id, tab.id);

  const listing = await executeAgentActionOnTab(tab.id, "gmail_list_inbox_threads", {}).catch(() => null);
  const listingLocation = `${listing?.location || tab.url || tab.pendingUrl || ""}`.trim();

  if (!isGmailUnreadViewUrl(listingLocation)) {
    return {
      monitorState: state,
      handled: false
    };
  }

  const settings = await getSettings();
  const listedThreads = Array.isArray(listing?.threads) ? listing.threads : [];
  const listedCandidate = listedThreads.find((thread) => thread?.threadId) || null;

  if (!listedCandidate) {
    return {
      monitorState: state,
      handled: false
    };
  }

  const rowIndex = Number.isInteger(listedCandidate?.rowIndex) ? listedCandidate.rowIndex : 0;

  try {
    await ensureAutomationStillRunning(provider.id, {
      requireAutoReply: true
    });
    await executeAgentActionOnTab(tab.id, "gmail_open_thread", { rowIndex });
    await delay(500);

    const threadContext = await waitForThreadContext(provider.id, tab.id);
    await ensureAutomationStillRunning(provider.id, {
      requireAutoReply: true
    });
    const currentTab = await chrome.tabs.get(tab.id).catch(() => tab);
    const primarySender = Array.isArray(threadContext?.senders) ? threadContext.senders[0] || {} : {};
    const thread = {
      threadId: buildDirectThreadId(currentTab?.url || currentTab?.pendingUrl || "", threadContext, primarySender),
      threadUrl: `${currentTab?.url || currentTab?.pendingUrl || ""}`.trim(),
      sourceUrl: `${currentTab?.url || currentTab?.pendingUrl || ""}`.trim(),
      sourceTabId: tab.id,
      provider: provider.id,
      subject: `${threadContext?.subject || listedCandidate?.subject || ""}`.trim(),
      sender: `${primarySender?.name || listedCandidate?.sender || ""}`.trim(),
      senderEmail: `${primarySender?.email || listedCandidate?.senderEmail || ""}`.trim(),
      preview: `${threadContext?.latestMessage || listedCandidate?.preview || ""}`.trim(),
      replied: listedCandidate?.replied === true
    };

    if (!shouldQueueThreadForCurrentView(settings, thread, { fromUnreadView: true })) {
      const skippedState = await saveHistoryThreadEntry(state, provider.id, thread, {
        status: "skipped",
        skipReason: "Skipped because it does not match your sender or subject rules.",
        reviewNote: "",
        draftText: "",
        draftPreview: "",
        lastSkippedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        lastError: ""
      });
      await ensureAutomationStillRunning(provider.id, {
        requireAutoReply: true
      });
      await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl);
      return {
        monitorState: skippedState,
        handled: true
      };
    }

    const reviewReason = getAutoSendReviewReason(settings, thread, threadContext);
    const decision = await generateEmailReplyDraft(settings, provider.id, threadContext);
    await ensureAutomationStillRunning(provider.id, {
      requireAutoReply: true
    });

    if (decision.type === "skip") {
      const skippedState = await saveHistoryThreadEntry(state, provider.id, thread, {
        status: "skipped",
        skipReason: decision.reason,
        reviewNote: "",
        draftText: "",
        draftPreview: "",
        lastSkippedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        lastError: ""
      });
      await ensureAutomationStillRunning(provider.id, {
        requireAutoReply: true
      });
      await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl);
      return {
        monitorState: skippedState,
        handled: true
      };
    }

    if (decision.type === "attention" || reviewReason) {
      const attentionState = await saveHistoryThreadEntry(state, provider.id, thread, {
        status: "needs-attention",
        skipReason: "",
        reviewNote: reviewReason || decision.reason,
        draftText: "",
        draftPreview: "",
        lastOpenedAt: new Date().toISOString(),
        lastError: ""
      });
      await ensureAutomationStillRunning(provider.id, {
        requireAutoReply: true
      });
      await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl);
      return {
        monitorState: attentionState,
        handled: true
      };
    }

    await ensureAutomationStillRunning(provider.id, {
      requireAutoReply: true
    });
    await ensureReplyBoxOpen(provider.id, tab.id, threadContext);
    await fillReplyDraft(provider.id, tab.id, decision.draft);
    await ensureAutomationStillRunning(provider.id, {
      requireAutoReply: true
    });
    await sendReply(provider.id, tab.id);

    const sentState = await saveHistoryThreadEntry(state, provider.id, thread, {
      status: "sent",
      draftText: decision.draft,
      draftPreview: decision.draft.slice(0, 1200),
      lastDraftAt: new Date().toISOString(),
      lastSentAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      skipReason: "",
      reviewNote: "",
      lastError: ""
    });

    await ensureAutomationStillRunning(provider.id, {
      requireAutoReply: true
    });
    await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl);

    return {
      monitorState: sentState,
      handled: true
    };
  } catch (error) {
    if (isAutomationStoppedError(error)) {
      return {
        monitorState: error.monitorState || await getMonitorState(),
        handled: false,
        stopped: true
      };
    }

    return {
      monitorState: state,
      handled: false,
      error: error instanceof Error ? error.message : "Unknown direct auto-reply error"
    };
  }
}

async function processReviewReplies(state, providerId) {
  let nextState = state;

  while (true) {
    nextState = await getMonitorState();
    const providerState = getProviderMonitorState(nextState, providerId);

    if (!providerState.enabled || providerState.autoReplyEnabled) {
      break;
    }

    const pendingResult = await syncPendingReviewDraft(nextState, providerId);
    nextState = pendingResult.monitorState;

    if (pendingResult.waiting || !getProviderMonitorState(nextState, providerId).enabled) {
      break;
    }

    let nextThread = findNextQueuedThread(getProviderMonitorState(nextState, providerId));

    if (!nextThread) {
      nextState = await primeNextQueuedThreadFromInbox(nextState, providerId);
      nextThread = findNextQueuedThread(getProviderMonitorState(nextState, providerId));
    }

    if (!nextThread) {
      break;
    }

    const result = await prepareQueuedReplyForReview({
      provider: providerId,
      threadId: nextThread.threadId,
      autoReplyFlow: true
    });

    nextState = result?.monitorState || await getMonitorState();

    if (result?.stopped) {
      break;
    }

    if (result?.awaitingReview) {
      break;
    }

    if (result?.error) {
      if (shouldPauseAfterAutomationError(result.error)) {
        nextState = await pauseMonitorProviderState(nextState, providerId, buildAutomationPauseReason(getMonitorProvider(providerId)));
        break;
      }

      if (/api key is missing/i.test(`${result.error}`)) {
        break;
      }
    } else {
      nextState = await pollProviderInbox(nextState, providerId);
    }

    if (findNextQueuedThread(getProviderMonitorState(nextState, providerId))) {
      await delay(AUTO_REPLY_DELAY_MS);
    }
  }

  return nextState;
}

async function prepareQueuedReplyForReview(payload) {
  const provider = getMonitorProvider(payload.provider);
  const threadId = `${payload.threadId || ""}`.trim();

  if (!threadId) {
    throw new Error("A queued thread id is required.");
  }

  let state = await updateQueuedThread(provider.id, threadId, {
    status: "drafting",
    lastError: ""
  });
  let thread = findQueuedThread(state, provider.id, threadId);

  if (!thread) {
    throw new Error("The queued thread could not be found.");
  }

  try {
    await ensureAutomationStillRunning(provider.id, {
      requireReviewMode: true
    });
    const settings = await getSettings();
    const tab = await openQueuedThread(provider.id, thread);
    const threadContext = await waitForThreadContext(provider.id, tab.id);
    await ensureAutomationStillRunning(provider.id, {
      requireReviewMode: true
    });
    const result = await composeReplyDraftInThread(settings, provider.id, tab.id, threadContext, payload.instructions);

    if (result.type === "skip") {
      state = await updateQueuedThread(provider.id, threadId, {
        sourceTabId: tab.id || thread.sourceTabId,
        status: "skipped",
        skipReason: result.reason,
        reviewNote: "",
        draftText: "",
        draftPreview: "",
        lastSkippedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        lastError: ""
      });

      await ensureAutomationStillRunning(provider.id, {
        requireReviewMode: true
      });
      await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl || threadContext?.sourceUrl || "");

      return {
        monitorState: await updateProviderMonitorState(state, provider.id, {
          pendingReview: null
        }),
        draft: "",
        noReply: true,
        reason: result.reason,
        awaitingReview: false
      };
    }

    if (result.type === "attention") {
      state = await updateQueuedThread(provider.id, threadId, {
        sourceTabId: tab.id || thread.sourceTabId,
        status: "needs-attention",
        skipReason: "",
        reviewNote: result.reason,
        draftText: "",
        draftPreview: "",
        lastOpenedAt: new Date().toISOString(),
        lastError: ""
      });

      await ensureAutomationStillRunning(provider.id, {
        requireReviewMode: true
      });
      await navigateTabToProviderInbox(provider.id, tab.id, thread.sourceUrl || threadContext?.sourceUrl || "");

      return {
        monitorState: await updateProviderMonitorState(state, provider.id, {
          pendingReview: null
        }),
        draft: "",
        needsAttention: true,
        reason: result.reason,
        awaitingReview: false
      };
    }

    state = await updateQueuedThread(provider.id, threadId, {
      sourceTabId: tab.id || thread.sourceTabId,
      status: "awaiting-review-send",
      draftText: result.draft,
      draftPreview: result.draft.slice(0, 1200),
      lastDraftAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      skipReason: "",
      reviewNote: "",
      lastError: ""
    });

    state = await updateProviderMonitorState(state, provider.id, {
      pendingReview: buildPendingReview(threadId, tab.id, thread, threadContext)
    });

    return {
      monitorState: state,
      threadContext,
      draft: result.draft,
      awaitingReview: true
    };
  } catch (error) {
    if (isAutomationStoppedError(error)) {
      return {
        monitorState: error.monitorState || await getMonitorState(),
        draft: "",
        awaitingReview: false,
        stopped: true
      };
    }

    state = await updateQueuedThread(provider.id, threadId, {
      status: "error",
      lastError: error instanceof Error ? error.message : "Unknown review error"
    });

    return {
      monitorState: state,
      draft: "",
      error: error instanceof Error ? error.message : "Unknown review error",
      awaitingReview: false
    };
  }
}

async function openQueuedThread(providerId, thread) {
  const provider = getMonitorProvider(providerId);
  const monitorState = await getMonitorState();
  const providerState = getProviderMonitorState(monitorState, provider.id);
  const rawThreadUrl = `${thread?.threadUrl || ""}`.trim();
  const threadUrl = isUsableThreadUrl(provider.id, rawThreadUrl) ? rawThreadUrl : "";
  const fallbackUrl = buildProviderInboxUrl(provider, thread?.sourceUrl);
  let tab = null;

  const preferredTabId = Number(thread?.sourceTabId) || Number(providerState.automationTabId) || null;

  if (preferredTabId) {
    try {
      tab = await chrome.tabs.get(preferredTabId);
    } catch {
      tab = null;
    }
  }

  if (!tab?.id && provider.id === "gmail") {
    const tabs = await chrome.tabs.query({
      url: provider.hostPermissions
    });
    tab = pickPreferredProviderTab(tabs, providerState.automationTabId || thread?.sourceTabId || null);
  }

  if (tab?.id) {
    if (threadUrl) {
      tab = await chrome.tabs.update(tab.id, {
        active: true,
        url: threadUrl
      });
    } else {
      const currentUrl = `${tab.url || tab.pendingUrl || ""}`.trim();
      if (!provider.hostPermissions.some((pattern) => currentUrl.startsWith(pattern.replace("/*", "/")))) {
        tab = await chrome.tabs.update(tab.id, {
          active: true,
          url: fallbackUrl
        });
      } else {
        tab = await chrome.tabs.update(tab.id, {
          active: true
        });
      }
    }
  } else {
    if (provider.id === "gmail") {
      throw new Error("Open Gmail in the tab you want me to use, then press Start again.");
    }

    tab = await chrome.tabs.create({
      url: threadUrl || fallbackUrl,
      active: true
    });
  }

  if (!tab?.id) {
    throw new Error(`A ${provider.label} tab could not be opened for this thread.`);
  }

  await delay(1500);

  if (!threadUrl) {
    const actionId = provider.id === "gmail" ? "gmail_open_thread" : "outlook_open_thread";
    await executeAgentActionOnTab(tab.id, actionId, {
      rowIndex: Number.isInteger(thread.rowIndex) ? thread.rowIndex : undefined,
      target: thread.target
    });
    await delay(1500);
  }

  return tab;
}

async function waitForThreadContext(providerId, tabId, timeoutMs = 12000) {
  const startedAt = Date.now();
  const actionId = providerId === "gmail" ? "gmail_extract_thread_context" : "outlook_extract_thread_context";

  while (Date.now() - startedAt <= timeoutMs) {
    const context = await executeAgentActionOnTab(tabId, actionId, {}).catch(() => null);

    if (context?.subject || context?.latestMessage) {
      return context;
    }

    await delay(500);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for the ${getMonitorProvider(providerId).label} thread to load.`);
}

async function ensureReplyBoxOpen(providerId, tabId, threadContext) {
  if (threadContext?.hasOpenReplyBox) {
    return;
  }

  const actionId = providerId === "gmail" ? "gmail_open_reply_box" : "outlook_open_reply_box";
  await executeAgentActionOnTab(tabId, actionId, {});
  await delay(800);
}

async function fillReplyDraft(providerId, tabId, draft) {
  const actionId = providerId === "gmail" ? "gmail_fill_reply_body" : "outlook_fill_reply_body";
  await executeAgentActionOnTab(tabId, actionId, { body: draft });
}

async function sendReply(providerId, tabId) {
  if (providerId !== "gmail") {
    throw new Error(`Sending replies is not implemented for ${getMonitorProvider(providerId).label}.`);
  }

  await executeAgentActionOnTab(tabId, "gmail_send_reply", {});
}

async function composeReplyDraftInThread(settings, providerId, tabId, threadContext, instructions) {
  const result = await generateEmailReplyDraft(settings, providerId, threadContext, instructions);

  if (result.type !== "reply") {
    return result;
  }

  await ensureReplyBoxOpen(providerId, tabId, threadContext);
  await fillReplyDraft(providerId, tabId, result.draft);

  return result;
}

async function generateEmailReplyDraft(settings, providerId, threadContext, instructions) {
  const nextSettings = settings || await getSettings();
  const replyInstructions = `${instructions || ""}`.trim();
  const primarySender = Array.isArray(threadContext?.senders) ? threadContext.senders[0] || {} : {};
  const payload = {
    subject: `${threadContext?.subject || ""}`.trim(),
    senderName: `${primarySender?.name || ""}`.trim(),
    senderEmail: `${primarySender?.email || ""}`.trim(),
    latestMessage: `${threadContext?.latestMessage || ""}`.trim(),
    threadMessages: Array.isArray(threadContext?.threadMessages) ? threadContext.threadMessages : [],
    sourceUrl: `${threadContext?.sourceUrl || ""}`.trim(),
    identity: `${nextSettings.identity || ""}`.trim(),
    replyStyle: `${nextSettings.replyStyle || ""}`.trim(),
    knowledge: `${nextSettings.knowledge || ""}`.trim(),
    signature: `${nextSettings.signature || ""}`.trim(),
    extraInstructions: [
      nextSettings.systemPrompt,
      replyInstructions,
      buildReplyDecisionGuidance(nextSettings),
      [
        "Write plain email text only.",
        "Do not use markdown.",
        "Do not use ** bold markers or other formatting symbols.",
        "Use natural paragraph breaks and blank lines when they help readability.",
        `If an email clearly needs no reply, return exactly ${NO_REPLY_NEEDED_TOKEN} on the first line.`,
        "You may add a short reason for the user on the second line.",
        "Use this only for obvious no-reply cases such as automated confirmations, receipts, shipping updates, password reset emails, newsletters, system notifications, or messages that clearly require no response.",
        "If the email seems to be from a real person, you should usually reply even if they did not ask a direct question."
      ].join(" ")
    ].filter(Boolean).join("\n\n")
  };

  const response = await fetch(REPLY_DRAFT_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    cache: "no-store",
    body: JSON.stringify(payload)
  });

  const data = await safeReadJson(response);

  if (!response.ok) {
    throw new Error(`${data?.error || "Reply service error."}`.trim());
  }

  const draft = `${data?.draft || ""}`.trim();

  if (!draft) {
    throw new Error("Reply service returned an empty draft.");
  }

  const decision = parseReplyDecision(draft);

  if (decision.type === "reply") {
    await setLastResponse(decision.draft);
  }

  return decision;
}

function buildReplyDecisionGuidance(settings) {
  const customInstructions = `${settings?.replyDecisionInstructions || ""}`.trim();
  const attentionInstructions = `${settings?.attentionRules || ""}`.trim();
  const allowNeedsAttention = settings?.attentionRulesEnabled === true && attentionInstructions;

  if (settings?.replyDecisionMode === "custom" && customInstructions) {
    return [
      "Use the user's reply rules below when deciding whether this email deserves a reply or should be skipped.",
      `If the email should be skipped because of these rules, return exactly ${NO_REPLY_NEEDED_TOKEN} on the first line and a short reason for the user on the second line.`,
      "Otherwise, write the best reply you can.",
      allowNeedsAttention
        ? `If the email matches the separate personal-attention rules below, return exactly ${NEEDS_ATTENTION_TOKEN} on the first line and a short reason on the second line.`
        : `Never use ${NEEDS_ATTENTION_TOKEN}. If the email is from a real person, try to reply instead of handing it back.`,
      "",
      `User reply rules:\n${customInstructions}`,
      allowNeedsAttention ? `\nPersonal-attention rules:\n${attentionInstructions}` : ""
    ].filter(Boolean).join("\n");
  }

  return [
    "Default reply rule: reply to normal human or business emails that appear to deserve an answer.",
    "Do not skip real person emails lightly.",
    "Only skip clear no-reply cases such as automated confirmations, receipts, shipping updates, password reset emails, newsletters, system notifications, or messages that obviously do not need a response.",
    allowNeedsAttention
      ? `If the email matches the user's personal-attention rules below, return exactly ${NEEDS_ATTENTION_TOKEN} on the first line and a short reason on the second line. Personal-attention rules: ${attentionInstructions}`
      : `Never use ${NEEDS_ATTENTION_TOKEN}. Even if the email is a bit tricky, still try to reply unless it is clearly a no-reply case.`
  ].join(" ");
}

async function getActiveProviderTab(providerId) {
  const provider = getMonitorProvider(providerId);
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    url: provider.hostPermissions
  });

  if (!tab?.id) {
    throw new Error(`Open ${provider.label} in the active tab first.`);
  }

  return tab;
}

async function navigateTabToProviderInbox(providerId, tabId, sourceUrl = "") {
  if (!tabId) {
    return null;
  }

  const provider = getMonitorProvider(providerId);

  if (provider.id === "gmail") {
    try {
      await chrome.tabs.update(tabId, { active: true });
      await executeAgentActionOnTab(tabId, "gmail_return_to_inbox", {
        unreadOnly: true
      });
      const returned = await waitForProviderInboxReady(provider.id, tabId);

      if (!returned) {
        throw new Error("Gmail did not return to the unread inbox view.");
      }

      return await chrome.tabs.get(tabId);
    } catch {
      // Fall back to direct inbox navigation if Gmail history navigation is unavailable.
    }
  }

  const inboxUrl = buildProviderInboxUrl(provider, sourceUrl);
  const tab = await chrome.tabs.update(tabId, {
    active: true,
    url: inboxUrl
  });

  await waitForProviderInboxReady(provider.id, tab.id);
  return tab;
}

async function moveAnyGmailTabToNextPage(tabs) {
  const orderedTabs = [...tabs].sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)));

  for (const tab of orderedTabs) {
    if (!tab?.id) {
      continue;
    }

    try {
      await executeAgentActionOnTab(tab.id, "gmail_go_to_next_page", {});
      await delay(1600);
      return true;
    } catch {
      // Try the next Gmail tab if this one cannot advance.
    }
  }

  return false;
}

function getMonitorProvider(providerId) {
  return getEmailProvider(providerId) || EMAIL_PROVIDERS.gmail;
}

function buildProviderInboxUrl(provider, sourceUrl) {
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);

      if (provider.id === "gmail") {
        const pathMatch = url.pathname.match(/\/mail\/u\/[^/]+\//i);
        const pathPrefix = pathMatch?.[0] || "/mail/u/0/";
        return `${url.origin}${pathPrefix}#advanced-search/is_unread=true&isrefinement=true`;
      }

      if (provider.id === "outlook") {
        return `${url.origin}/mail/`;
      }
    } catch {
      // Fall back to provider defaults.
    }
  }

  return provider.inboxUrl || provider.hostPermissions[0].replace("/*", "/");
}

function isUsableThreadUrl(providerId, url) {
  if (!url) {
    return false;
  }

  if (providerId === "gmail") {
    return /#.+\/.+/.test(url) && !/#(?:inbox|all|starred|important|sent|drafts)$/i.test(url);
  }

  if (providerId === "outlook") {
    return /\/mail\/id\//i.test(url) || /[?&](ItemID|id|conversationid)=/i.test(url);
  }

  return true;
}

function getProviderMonitorState(state, providerId) {
  return state?.providers?.[providerId] || {
    enabled: false,
    autoReplyEnabled: false,
    intervalMinutes: 1,
    automationTabId: null,
    lastCheckedAt: "",
    pauseReason: "",
    pausedAt: "",
    pollFailureCount: 0,
    pendingReview: null,
    inboxQueue: [],
    seenThreadIds: []
  };
}

async function pauseMonitorProviderState(state, providerId, reason, patch = {}) {
  const providerState = releasePendingReview(getProviderMonitorState(state, providerId), {
    now: new Date().toISOString(),
    reviewNote: "Left for you because automation had to stop.",
    lastError: `${reason || ""}`.trim()
  });
  const nextState = await saveMonitorState({
    ...state,
    providers: {
      ...state.providers,
      [providerId]: {
        ...providerState,
        ...patch,
        enabled: false,
        pauseReason: `${reason || ""}`.trim(),
        pausedAt: new Date().toISOString()
      }
    }
  });

  await reconcileMonitorAlarm(nextState);
  await cancelProviderAutomationKick(providerId);
  await cancelAutomationWatchdog(providerId);
  invalidateProviderKickNonce(providerId);
  return nextState;
}

async function updateProviderMonitorState(state, providerId, patch) {
  const liveState = await getMonitorState();
  const providerState = getProviderMonitorState(liveState, providerId);
  const nextProviderState = {
    ...providerState,
    ...patch
  };

  if (!providerState.enabled && !Object.prototype.hasOwnProperty.call(patch || {}, "enabled")) {
    nextProviderState.enabled = false;
    nextProviderState.pauseReason = providerState.pauseReason;
    nextProviderState.pausedAt = providerState.pausedAt;
  }

  return await saveMonitorState({
    ...liveState,
    providers: {
      ...liveState.providers,
      [providerId]: {
        ...nextProviderState
      }
    }
  });
}

async function pickProviderAutomationTabId(providerId) {
  const provider = getMonitorProvider(providerId);
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    url: provider.hostPermissions
  });

  if (activeTab?.id) {
    return activeTab.id;
  }

  const tabs = await chrome.tabs.query({
    url: provider.hostPermissions
  });
  return pickPreferredProviderTab(tabs)?.id || null;
}

function pickPreferredProviderTab(tabs, preferredTabId = null) {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return null;
  }

  const preferred = preferredTabId
    ? tabs.find((tab) => Number(tab?.id) === Number(preferredTabId))
    : null;

  if (preferred?.id) {
    return preferred;
  }

  return [...tabs].sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)))[0] || null;
}

async function focusProviderAutomationInbox(providerId, tabId) {
  if (!tabId) {
    return null;
  }

  const provider = getMonitorProvider(providerId);

  let currentTab = null;

  try {
    currentTab = await chrome.tabs.get(tabId);
  } catch {
    currentTab = null;
  }

  if (!currentTab?.id) {
    return null;
  }

  await chrome.tabs.update(tabId, {
    active: true
  });

  if (provider.id === "gmail") {
    try {
      await executeAgentActionOnTab(tabId, "gmail_return_to_inbox", {
        unreadOnly: true
      });
      const returned = await waitForProviderInboxReady(provider.id, tabId);

      if (!returned) {
        throw new Error("Gmail did not open the unread inbox view.");
      }

      return await chrome.tabs.get(tabId);
    } catch {
      // Fall through to the generic URL-based fallback below.
    }
  }

  const tab = await chrome.tabs.update(tabId, {
    active: true,
    url: buildProviderInboxUrl(provider, `${currentTab.url || currentTab.pendingUrl || ""}`.trim())
  });

  await waitForProviderInboxReady(provider.id, tab.id);
  return tab;
}

async function waitForProviderInboxReady(providerId, tabId, timeoutMs = 5000) {
  if (!tabId) {
    return false;
  }

  if (providerId !== "gmail") {
    await delay(1200);
    return true;
  }

  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const listing = await executeAgentActionOnTab(tabId, "gmail_list_inbox_threads", {}).catch(() => null);

    if (Array.isArray(listing?.threads) && listing.threads.length > 0) {
      return true;
    }

    if (Array.isArray(listing?.threads) && isGmailUnreadViewUrl(`${listing?.location || ""}`.trim())) {
      return true;
    }

    await delay(150);
  }

  return false;
}

function isGmailUnreadViewUrl(url) {
  if (!url) {
    return false;
  }

  const normalized = decodeURIComponent(`${url}`).toLowerCase();

  return normalized.includes("#advanced-search/is_unread=true")
    || normalized.includes("#search/is:unread")
    || normalized.includes("#label/unread");
}

async function primeNextQueuedThreadFromInbox(state, providerId) {
  const provider = getMonitorProvider(providerId);
  const providerState = getProviderMonitorState(state, provider.id);

  if (!providerState.enabled) {
    return state;
  }

  const tabs = await chrome.tabs.query({
    url: provider.hostPermissions
  });
  const tab = pickPreferredProviderTab(tabs, providerState.automationTabId);

  if (!tab?.id) {
    return state;
  }

  await waitForProviderInboxReady(provider.id, tab.id);

  const listing = await executeAgentActionOnTab(
    tab.id,
    provider.id === "gmail" ? "gmail_list_inbox_threads" : "outlook_list_inbox_threads",
    {}
  ).catch(() => null);

  const visibleThreads = Array.isArray(listing?.threads)
    ? listing.threads.map((thread) => ({
        ...thread,
        provider: provider.id,
        sourceTabId: tab.id,
        sourceUrl: `${tab.url || tab.pendingUrl || ""}`.trim()
      }))
    : [];

  if (visibleThreads.length === 0) {
    return state;
  }

  const settings = await getSettings();
  const providerQueue = Array.isArray(providerState.inboxQueue) ? providerState.inboxQueue : [];
  const blockedThreadIds = new Set(
    providerQueue
      .filter((item) => isActiveQueueStatus(item.status))
      .filter((item) => item.threadId)
      .map((item) => buildThreadIdentityKey(item))
      .filter(Boolean)
  );
  const candidate = visibleThreads
    .filter((thread) => thread.threadId)
    .filter((thread) => shouldQueueThreadForCurrentView(settings, thread, {
      fromUnreadView: provider.id === "gmail" && isGmailUnreadViewUrl(`${listing?.location || tab.url || tab.pendingUrl || ""}`.trim())
    }))
    .find((thread) => !blockedThreadIds.has(buildThreadIdentityKey(thread)));

  if (!candidate) {
    return state;
  }

  const nextThread = {
    ...candidate,
    addedAt: new Date().toISOString(),
    status: "queued",
    skipReason: "",
    reviewNote: "",
    lastError: "",
    draftText: "",
    draftPreview: ""
  };

  return await updateProviderMonitorState(state, provider.id, {
    inboxQueue: dedupeQueueEntriesByThreadId([
      nextThread,
      ...providerQueue
    ]).slice(0, 80)
  });
}

function queueAutomationKick(providerId) {
  void chrome.alarms.clear(`${EMAIL_MONITOR_KICK_ALARM_PREFIX}${providerId}`).catch(() => {
    // Ignore clear failures; scheduling below is the important part.
  });
  chrome.alarms.create(`${EMAIL_MONITOR_KICK_ALARM_PREFIX}${providerId}`, {
    when: Date.now() + 150
  }).catch(() => {
    // Ignore kick scheduling failures; the regular monitor alarm can still continue automation.
  });
}

function scheduleAutomationWatchdog(providerId) {
  void chrome.alarms.clear(`${EMAIL_MONITOR_WATCHDOG_ALARM_PREFIX}${providerId}`).catch(() => {
    // Ignore clear failures before re-scheduling the watchdog.
  });
  chrome.alarms.create(`${EMAIL_MONITOR_WATCHDOG_ALARM_PREFIX}${providerId}`, {
    when: Date.now() + AUTOMATION_WATCHDOG_MS
  }).catch(() => {
    // Ignore watchdog scheduling failures; the regular alarms can still continue automation.
  });
}

function startAutomationSoon(providerId) {
  const nonce = nextProviderKickNonce(providerId);
  Promise.resolve()
    .then(() => delay(200))
    .then(async () => {
      if (providerKickNonces.get(providerId) !== nonce) {
        return null;
      }

      const state = await getMonitorState();
      if (!getProviderMonitorState(state, providerId).enabled) {
        return null;
      }

      return await pollEmailMonitor(providerId);
    })
    .catch(() => {
      // Ignore immediate kickoff failures; the alarm-based poll remains as a fallback.
    });
}

async function cancelProviderAutomationKick(providerId) {
  await chrome.alarms.clear(`${EMAIL_MONITOR_KICK_ALARM_PREFIX}${providerId}`).catch(() => {
    // Ignore clear failures when the alarm does not exist anymore.
  });
}

async function cancelAutomationWatchdog(providerId) {
  await chrome.alarms.clear(`${EMAIL_MONITOR_WATCHDOG_ALARM_PREFIX}${providerId}`).catch(() => {
    // Ignore clear failures when the watchdog alarm does not exist anymore.
  });
}

async function reconcileAutomationWatchdogs(state) {
  const providerIds = Object.keys(state?.providers || {});

  await Promise.all(providerIds.map((providerId) => cancelAutomationWatchdog(providerId)));

  providerIds.forEach((providerId) => {
    if (getProviderMonitorState(state, providerId).enabled) {
      scheduleAutomationWatchdog(providerId);
    }
  });
}

function nextProviderKickNonce(providerId) {
  const nextNonce = (providerKickNonces.get(providerId) || 0) + 1;
  providerKickNonces.set(providerId, nextNonce);
  return nextNonce;
}

function invalidateProviderKickNonce(providerId) {
  providerKickNonces.set(providerId, (providerKickNonces.get(providerId) || 0) + 1);
}

function createAutomationStoppedError(state) {
  const error = new Error("Automation was paused.");
  error.code = AUTOMATION_STOPPED_ERROR_CODE;
  error.monitorState = state;
  return error;
}

function isAutomationStoppedError(error) {
  return error instanceof Error && error.code === AUTOMATION_STOPPED_ERROR_CODE;
}

async function ensureAutomationStillRunning(providerId, options = {}) {
  const state = await getMonitorState();
  const providerState = getProviderMonitorState(state, providerId);

  if (!providerState.enabled) {
    throw createAutomationStoppedError(state);
  }

  if (options.requireAutoReply && !providerState.autoReplyEnabled) {
    throw createAutomationStoppedError(state);
  }

  if (options.requireReviewMode && providerState.autoReplyEnabled) {
    throw createAutomationStoppedError(state);
  }

  return {
    state,
    providerState
  };
}

function resetProviderForFreshStart(providerState) {
  return {
    ...providerState,
    pendingReview: null,
    seenThreadIds: [],
    inboxQueue: Array.isArray(providerState?.inboxQueue)
      ? providerState.inboxQueue.filter((item) => ["skipped", "needs-attention"].includes(`${item.status || ""}`))
      : []
  };
}

function isHistoryStatus(status) {
  return ["sent", "skipped", "needs-attention"].includes(`${status || ""}`);
}

function isActiveQueueStatus(status) {
  return ["queued", "opened", "drafting", "sending", "drafted", "awaiting-review-send"].includes(`${status || ""}`);
}

function findQueuedThread(state, providerId, threadId) {
  const providerState = getProviderMonitorState(state, providerId);
  return Array.isArray(providerState.inboxQueue)
    ? providerState.inboxQueue.find((item) => item.threadId === threadId) || null
    : null;
}

async function updateQueuedThread(providerId, threadId, patch) {
  const state = await getMonitorState();
  const providerState = getProviderMonitorState(state, providerId);
  const existing = findQueuedThread(state, providerId, threadId);

  if (!existing) {
    throw new Error("The queued thread could not be found.");
  }

  return await saveMonitorState({
    ...state,
    providers: {
      ...state.providers,
      [providerId]: {
        ...providerState,
        inboxQueue: providerState.inboxQueue.map((item) =>
          item.threadId === threadId
            ? {
                ...item,
                ...patch
              }
            : item
        )
      }
    }
  });
}

function dedupeThreads(threads) {
  const seen = new Set();

  return threads.filter((thread) => {
    const key = `${thread.threadId || ""}`;

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function findNextQueuedThread(providerState) {
  return Array.isArray(providerState?.inboxQueue)
    ? providerState.inboxQueue.find((item) => item.threadId && item.status === "queued") || null
    : null;
}

async function syncPendingReviewDraft(state, providerId) {
  const provider = getMonitorProvider(providerId);
  const providerState = getProviderMonitorState(state, provider.id);
  const pendingReview = providerState.pendingReview;

  if (!pendingReview?.threadId) {
    return {
      monitorState: state,
      waiting: false
    };
  }

  if (!providerState.enabled || providerState.autoReplyEnabled) {
    return {
      monitorState: state,
      waiting: false
    };
  }

  if (!pendingReview.tabId) {
    return {
      monitorState: await pauseMonitorProviderState(
        state,
        provider.id,
        `I lost the review draft in ${provider.label}. Open the inbox you want me to work on and press Start again.`
      ),
      waiting: false
    };
  }

  let tab = null;

  try {
    tab = await chrome.tabs.get(pendingReview.tabId);
  } catch {
    tab = null;
  }

  if (!tab?.id) {
    return {
      monitorState: await pauseMonitorProviderState(
        state,
        provider.id,
        `The review draft tab was closed. Open the inbox you want me to work on and press Start again.`
      ),
      waiting: false
    };
  }

  const threadContext = await executeAgentActionOnTab(tab.id, "gmail_extract_thread_context", {}).catch(() => null);

  if (threadContext?.hasOpenReplyBox) {
    return {
      monitorState: state,
      waiting: true
    };
  }

  return {
    monitorState: await pauseMonitorProviderState(
      state,
      provider.id,
      `I couldn't find the review draft anymore. Open the inbox you want me to work on and press Start again.`
    ),
    waiting: false
  };
}

function buildPendingReview(threadId, tabId, thread, threadContext) {
  const primarySender = Array.isArray(threadContext?.senders) ? threadContext.senders[0] || {} : {};

  return {
    threadId: `${threadId || ""}`.trim(),
    tabId: Number.isInteger(Number(tabId)) ? Number(tabId) : null,
    subject: `${threadContext?.subject || thread?.subject || ""}`.trim(),
    sender: `${primarySender?.name || thread?.sender || ""}`.trim(),
    senderEmail: `${primarySender?.email || thread?.senderEmail || ""}`.trim(),
    sourceUrl: `${threadContext?.sourceUrl || thread?.sourceUrl || ""}`.trim(),
    draftedAt: new Date().toISOString()
  };
}

function releasePendingReview(providerState, options = {}) {
  if (!providerState?.pendingReview?.threadId || !Array.isArray(providerState.inboxQueue)) {
    return {
      ...providerState,
      pendingReview: null
    };
  }

  const threadId = providerState.pendingReview.threadId;
  const note = `${options.reviewNote || ""}`.trim();
  const lastError = `${options.lastError || ""}`.trim();
  const now = `${options.now || new Date().toISOString()}`.trim();

  return {
    ...providerState,
    pendingReview: null,
    inboxQueue: providerState.inboxQueue.map((item) =>
      item.threadId === threadId
        ? {
            ...item,
            status: note ? "needs-attention" : item.status,
            reviewNote: note || item.reviewNote || "",
            lastError,
            lastOpenedAt: now
          }
        : item
    )
  };
}

function shouldQueueThread(settings, thread) {
  if (!thread?.threadId) {
    return false;
  }

  if (!thread.unread) {
    return false;
  }

  if (settings.skipRepliedThreads !== false && thread.replied && !thread.unread) {
    return false;
  }

  return passesThreadQueueFilters(settings, thread);
}

function shouldQueueThreadForCurrentView(settings, thread, options = {}) {
  if (!thread?.threadId) {
    return false;
  }

  if (options.fromUnreadView) {
    return passesThreadQueueFilters(settings, thread);
  }

  return shouldQueueThread(settings, thread);
}

function passesThreadQueueFilters(settings, thread) {
  if (!thread?.threadId) {
    return false;
  }

  const senderText = `${thread.sender || ""} ${thread.senderEmail || ""}`.trim();
  const subjectText = `${thread.subject || ""} ${thread.preview || ""}`.trim();
  const allowedSenders = parsePatternList(settings.allowedSenders);
  const ignoredSenders = parsePatternList(settings.ignoredSenders);
  const ignoredSubjects = parsePatternList(settings.ignoredSubjects);

  if (settings.skipNoReplySenders !== false && looksLikeNoReplySender(senderText)) {
    return false;
  }

  if (allowedSenders.length > 0 && !matchesAnyPattern(senderText, allowedSenders)) {
    return false;
  }

  if (matchesAnyPattern(senderText, ignoredSenders)) {
    return false;
  }

  if (matchesAnyPattern(subjectText, ignoredSubjects)) {
    return false;
  }

  return true;
}

function buildThreadIdentityKey(thread) {
  return `${thread?.threadId || ""}`.trim();
}

function buildQueueKey(thread) {
  if (!thread?.threadId) {
    return "";
  }

  return `${thread.threadId}::${normalizePattern(thread.preview)}::${normalizePattern(thread.subject)}`;
}

function dedupeQueueEntriesByThreadId(entries) {
  const seen = new Set();

  return entries.filter((entry) => {
    const key = buildThreadIdentityKey(entry);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function saveHistoryThreadEntry(state, providerId, thread, patch = {}) {
  const providerState = getProviderMonitorState(state, providerId);
  const threadId = buildThreadIdentityKey(thread);

  if (!threadId) {
    return state;
  }

  const existing = Array.isArray(providerState.inboxQueue)
    ? providerState.inboxQueue.find((item) => buildThreadIdentityKey(item) === threadId) || null
    : null;
  const entry = {
    ...(existing || {}),
    ...thread,
    ...patch,
    threadId,
    provider: providerId,
    addedAt: existing?.addedAt || new Date().toISOString()
  };
  const remaining = Array.isArray(providerState.inboxQueue)
    ? providerState.inboxQueue.filter((item) => buildThreadIdentityKey(item) !== threadId)
    : [];

  return await updateProviderMonitorState(state, providerId, {
    inboxQueue: dedupeQueueEntriesByThreadId([
      entry,
      ...remaining
    ]).slice(0, 80)
  });
}

function buildDirectThreadId(url, threadContext, primarySender = {}) {
  const normalizedUrl = `${url || ""}`.trim();

  if (normalizedUrl) {
    return normalizedUrl;
  }

  return [
    `${primarySender?.email || primarySender?.name || ""}`.trim(),
    `${threadContext?.subject || ""}`.trim(),
    `${threadContext?.latestMessage || ""}`.trim().slice(0, 160)
  ].filter(Boolean).join("::");
}

function buildSeenThreadKey(thread) {
  if (!thread?.threadId) {
    return "";
  }

  return `${buildQueueKey(thread)}::${thread.unread ? "unread" : "read"}`;
}

function shouldPauseAfterAutomationError(message) {
  const value = `${message || ""}`.trim().toLowerCase();

  if (!value) {
    return false;
  }

  return [
    "mail.google.com",
    "could not be opened",
    "timed out",
    "no gmail inbox row exists",
    "opening a gmail thread requires",
    "no open gmail reply editor was found",
    "no tab with id",
    "frame with id",
    "receiving end does not exist",
    "cannot access contents of url",
    "cannot access a chrome",
    "the tab was closed"
  ].some((needle) => value.includes(needle));
}

function buildAutomationPauseReason(provider) {
  return `Something changed in ${provider.label} and I stopped to avoid losing my place. Go to the inbox you want me to work on and press Start again.`;
}

function parsePatternList(value) {
  return `${value || ""}`
    .split(/[\n,]/)
    .map((item) => normalizePattern(item))
    .filter(Boolean);
}

function matchesAnyPattern(value, patterns) {
  const haystack = normalizePattern(value);

  if (!haystack || !Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => haystack.includes(pattern));
}

function looksLikeNoReplySender(value) {
  const haystack = normalizePattern(value);

  if (!haystack) {
    return false;
  }

  return [
    /\bno[\s._-]*reply\b/i,
    /\bdo[\s._-]*not[\s._-]*reply\b/i,
    /\bdonotreply\b/i,
    /\bnoreply\b/i,
    /\bmailer[\s._-]*daemon\b/i,
    /\bpostmaster\b/i
  ].some((pattern) => pattern.test(haystack));
}

function getAutoSendReviewReason(settings, thread, threadContext) {
  return "";
}

function parseReplyDecision(value) {
  const text = normalizeReplyDraftText(value);

  if (!text) {
    return {
      type: "reply",
      draft: ""
    };
  }

  const firstLine = text.split("\n", 1)[0].trim();

  if (firstLine === NO_REPLY_NEEDED_TOKEN || firstLine.startsWith(`${NO_REPLY_NEEDED_TOKEN} `)) {
    const inlineReason = firstLine.slice(NO_REPLY_NEEDED_TOKEN.length).trim();
    const remainder = text.slice(firstLine.length).trim();
    const reason = inlineReason || remainder || "The A.I. decided this email does not need a reply.";

    return {
      type: "skip",
      reason: reason.slice(0, 220)
    };
  }

  if (firstLine === NEEDS_ATTENTION_TOKEN || firstLine.startsWith(`${NEEDS_ATTENTION_TOKEN} `)) {
    const inlineReason = firstLine.slice(NEEDS_ATTENTION_TOKEN.length).trim();
    const remainder = text.slice(firstLine.length).trim();
    const reason = inlineReason || remainder || "The A.I. left this email for you because it seems to need personal attention.";

    return {
      type: "attention",
      reason: reason.slice(0, 220)
    };
  }

  return {
    type: "reply",
    draft: text
  };
}

function normalizeReplyDraftText(value) {
  return `${value || ""}`
    .replace(/\r\n/g, "\n")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePattern(value) {
  return `${value || ""}`
    .trim()
    .toLowerCase();
}

function parsePlanResponse(text) {
  const candidate = extractJsonCandidate(text);
  let parsed;

  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("The A.I. returned invalid plan JSON.");
  }

  const summary = `${parsed?.summary || ""}`.trim() || "Planned browser task";
  const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];

  if (rawSteps.length === 0) {
    throw new Error("The A.I. returned an empty plan.");
  }

  const allowedActions = new Set(AGENT_ACTIONS.map((action) => action.id));
  const steps = rawSteps
    .map((step) => ({
      action: `${step?.action || ""}`.trim(),
      args: step?.args && typeof step.args === "object" ? step.args : {},
      reason: `${step?.reason || ""}`.trim(),
      risk: `${step?.risk || ""}`.trim()
    }))
    .filter((step) => step.action && allowedActions.has(step.action))
    .slice(0, 10);

  if (steps.length === 0) {
    throw new Error("The A.I. did not return any supported actions.");
  }

  return {
    summary,
    steps
  };
}

function extractJsonCandidate(text) {
  const trimmed = `${text || ""}`.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error("The A.I. did not return a JSON object.");
  }

  return trimmed.slice(start, end + 1);
}

function buildUserMessage(prompt, pageContext) {
  if (!pageContext) {
    return prompt;
  }

  const contextLines = [
    "Current page snapshot:",
    `Title: ${pageContext.title || "Untitled"}`,
    `URL: ${pageContext.url || "Unavailable"}`,
    `Language: ${pageContext.language || "Unknown"}`,
    pageContext.metaDescription ? `Description: ${pageContext.metaDescription}` : ""
  ].filter(Boolean);

  if (pageContext.selection) {
    contextLines.push("", "Selected text:", pageContext.selection);
  }

  if (Array.isArray(pageContext.headings) && pageContext.headings.length > 0) {
    contextLines.push("", "Headings:", pageContext.headings.join(" | "));
  }

  if (Array.isArray(pageContext.paragraphs) && pageContext.paragraphs.length > 0) {
    contextLines.push("", "Key paragraphs:", pageContext.paragraphs.join("\n\n"));
  } else {
    contextLines.push("", "Visible content:", pageContext.visibleText || "No visible text captured.");
  }

  return `${contextLines.join("\n")}\n\nUser request:\n${prompt}`;
}

function extractText(data) {
  if (!Array.isArray(data?.content)) {
    return "";
  }

  return data.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

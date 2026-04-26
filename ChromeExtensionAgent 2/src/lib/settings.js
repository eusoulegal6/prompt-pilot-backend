export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "claude-sonnet-4-6",
  systemPrompt: "",
  maxTokens: 700,
  replyDecisionMode: "standard",
  replyDecisionInstructions: "",
  attentionRulesEnabled: false,
  attentionRules: "",
  identity: "",
  replyStyle: "",
  knowledge: "",
  signature: "",
  allowedSenders: "",
  ignoredSenders: "",
  ignoredSubjects: "",
  onlyUnread: true,
  skipRepliedThreads: true,
  skipNoReplySenders: true,
  autoSendFirstContactOnly: false
};

export const STORAGE_KEYS = {
  settings: "claudeSettings",
  lastResponse: "claudeLastResponse",
  monitorState: "emailMonitorState"
};

export const DEFAULT_PROVIDER_MONITOR_STATE = {
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

export const DEFAULT_MONITOR_STATE = {
  selectedProvider: "gmail",
  providers: {
    gmail: { ...DEFAULT_PROVIDER_MONITOR_STATE },
    outlook: { ...DEFAULT_PROVIDER_MONITOR_STATE }
  }
};

export async function getSettings() {
  const result = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  return normalizeSettings(result[STORAGE_KEYS.settings] || {});
}

export async function saveSettings(settings) {
  const nextSettings = normalizeSettings(settings);

  await chrome.storage.sync.set({
    [STORAGE_KEYS.settings]: nextSettings
  });

  return nextSettings;
}

export async function getLastResponse() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.lastResponse);
  return result[STORAGE_KEYS.lastResponse] || "";
}

export async function setLastResponse(message) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastResponse]: message
  });
}

export async function getMonitorState() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.monitorState);
  return normalizeMonitorState(result[STORAGE_KEYS.monitorState] || {});
}

export async function saveMonitorState(state) {
  const nextState = normalizeMonitorState(state);

  await chrome.storage.local.set({
    [STORAGE_KEYS.monitorState]: nextState
  });

  return nextState;
}

function normalizeSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    apiKey: `${settings?.apiKey || ""}`.trim(),
    model: `${settings?.model || DEFAULT_SETTINGS.model}`.trim() || DEFAULT_SETTINGS.model,
    systemPrompt: `${settings?.systemPrompt || ""}`.trim(),
    maxTokens: Math.max(256, Number(settings?.maxTokens) || DEFAULT_SETTINGS.maxTokens),
    replyDecisionMode: settings?.replyDecisionMode === "custom" ? "custom" : "standard",
    replyDecisionInstructions: `${settings?.replyDecisionInstructions || ""}`.trim(),
    attentionRulesEnabled: settings?.attentionRulesEnabled === true,
    attentionRules: `${settings?.attentionRules || ""}`.trim(),
    identity: `${settings?.identity || ""}`.trim(),
    replyStyle: `${settings?.replyStyle || ""}`.trim(),
    knowledge: `${settings?.knowledge || ""}`.trim(),
    signature: `${settings?.signature || ""}`.trim(),
    allowedSenders: `${settings?.allowedSenders || ""}`.trim(),
    ignoredSenders: `${settings?.ignoredSenders || ""}`.trim(),
    ignoredSubjects: `${settings?.ignoredSubjects || ""}`.trim(),
    onlyUnread: true,
    skipRepliedThreads: settings?.skipRepliedThreads !== false,
    skipNoReplySenders: settings?.skipNoReplySenders !== false,
    autoSendFirstContactOnly: settings?.autoSendFirstContactOnly === true
  };
}

function normalizeMonitorState(state) {
  const selectedProvider = typeof state?.selectedProvider === "string" ? state.selectedProvider : state?.provider;
  const legacyGmailState =
    "enabled" in (state || {}) ||
    "intervalMinutes" in (state || {}) ||
    "lastCheckedAt" in (state || {}) ||
    "inboxQueue" in (state || {}) ||
    "seenThreadIds" in (state || {});

  const providers = {
    gmail: {
      ...DEFAULT_PROVIDER_MONITOR_STATE,
      ...(legacyGmailState
        ? {
            enabled: !!state?.enabled,
            intervalMinutes: state?.intervalMinutes,
            lastCheckedAt: state?.lastCheckedAt,
            inboxQueue: state?.inboxQueue,
            seenThreadIds: state?.seenThreadIds
          }
        : {}),
      ...(state?.providers?.gmail || {})
    },
    outlook: {
      ...DEFAULT_PROVIDER_MONITOR_STATE,
      ...(state?.providers?.outlook || {})
    }
  };

  return {
    ...DEFAULT_MONITOR_STATE,
    selectedProvider: providers[selectedProvider] ? selectedProvider : DEFAULT_MONITOR_STATE.selectedProvider,
    providers: {
      gmail: sanitizeProviderMonitorState(providers.gmail),
      outlook: sanitizeProviderMonitorState(providers.outlook)
    }
  };
}

function sanitizeProviderMonitorState(state) {
  return {
    enabled: !!state?.enabled,
    autoReplyEnabled: !!state?.autoReplyEnabled,
    intervalMinutes: Math.max(1, Number(state?.intervalMinutes) || 1),
    automationTabId: Number.isInteger(Number(state?.automationTabId)) && Number(state?.automationTabId) > 0
      ? Number(state.automationTabId)
      : null,
    lastCheckedAt: `${state?.lastCheckedAt || ""}`,
    pauseReason: `${state?.pauseReason || ""}`.trim(),
    pausedAt: `${state?.pausedAt || ""}`,
    pollFailureCount: Math.max(0, Number(state?.pollFailureCount) || 0),
    pendingReview: sanitizePendingReview(state?.pendingReview),
    inboxQueue: Array.isArray(state?.inboxQueue) ? state.inboxQueue : [],
    seenThreadIds: Array.isArray(state?.seenThreadIds) ? state.seenThreadIds : []
  };
}

function sanitizePendingReview(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const threadId = `${value.threadId || ""}`.trim();

  if (!threadId) {
    return null;
  }

  const rawTabId = Number(value.tabId);

  return {
    threadId,
    tabId: Number.isInteger(rawTabId) && rawTabId > 0 ? rawTabId : null,
    subject: `${value.subject || ""}`.trim(),
    sender: `${value.sender || ""}`.trim(),
    senderEmail: `${value.senderEmail || ""}`.trim(),
    sourceUrl: `${value.sourceUrl || ""}`.trim(),
    draftedAt: `${value.draftedAt || ""}`.trim()
  };
}

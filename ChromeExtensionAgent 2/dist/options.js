const configurationTabButton = document.getElementById("configuration-tab");
const sandboxTabButton = document.getElementById("sandbox-tab");
const settingsForm = document.getElementById("settings-form");
const sandboxPanel = document.getElementById("sandbox-panel");
const sandboxForm = document.getElementById("sandbox-form");
const replyRulesStandardInput = document.getElementById("reply-rules-standard");
const replyRulesCustomInput = document.getElementById("reply-rules-custom");
const replyRulesInstructionsField = document.getElementById("reply-rules-instructions-field");
const replyRulesInstructionsInput = document.getElementById("reply-rules-instructions");
const attentionRulesEnabledInput = document.getElementById("attention-rules-enabled");
const attentionRulesField = document.getElementById("attention-rules-field");
const attentionRulesInput = document.getElementById("attention-rules");
const identityInput = document.getElementById("identity");
const replyStyleInput = document.getElementById("reply-style");
const knowledgeInput = document.getElementById("knowledge");
const signatureInput = document.getElementById("signature");
const systemPromptInput = document.getElementById("system-prompt");
const skipRepliedThreadsInput = document.getElementById("skip-replied-threads");
const skipNoReplySendersInput = document.getElementById("skip-no-reply-senders");
const autoSendFirstContactOnlyInput = document.getElementById("auto-send-first-contact-only");
const allowedSendersInput = document.getElementById("allowed-senders");
const ignoredSendersInput = document.getElementById("ignored-senders");
const ignoredSubjectsInput = document.getElementById("ignored-subjects");
const saveStatus = document.getElementById("save-status");
const sandboxHint = document.getElementById("sandbox-hint");
const sandboxSenderNameInput = document.getElementById("sandbox-sender-name");
const sandboxSenderEmailInput = document.getElementById("sandbox-sender-email");
const sandboxSubjectInput = document.getElementById("sandbox-subject");
const sandboxLatestMessageInput = document.getElementById("sandbox-latest-message");
const sandboxThreadHistoryInput = document.getElementById("sandbox-thread-history");
const sandboxRunButton = document.getElementById("sandbox-run-button");
const sandboxFillSampleButton = document.getElementById("sandbox-fill-sample");
const sandboxStatus = document.getElementById("sandbox-status");
const sandboxResultCard = document.getElementById("sandbox-result-card");
const sandboxResultTitle = document.getElementById("sandbox-result-title");
const sandboxResultSummary = document.getElementById("sandbox-result-summary");
const sandboxResultMeta = document.getElementById("sandbox-result-meta");
const sandboxResultBody = document.getElementById("sandbox-result-body");

const trackedInputs = [
  replyRulesStandardInput,
  replyRulesCustomInput,
  replyRulesInstructionsInput,
  attentionRulesEnabledInput,
  attentionRulesInput,
  identityInput,
  replyStyleInput,
  knowledgeInput,
  signatureInput,
  systemPromptInput,
  skipRepliedThreadsInput,
  skipNoReplySendersInput,
  autoSendFirstContactOnlyInput,
  allowedSendersInput,
  ignoredSendersInput,
  ignoredSubjectsInput
];

let hasUnsavedChanges = false;
let sandboxBusy = false;

initialize();

configurationTabButton.addEventListener("click", () => {
  setActiveTab("configuration");
});

sandboxTabButton.addEventListener("click", () => {
  setActiveTab("sandbox");
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  setSaveStatus("Saving...", "saving");

  const response = await chrome.runtime.sendMessage({
    type: "settings:save",
    payload: readFormValues()
  });

  if (!response?.ok) {
    setSaveStatus(response?.error || "Failed to save settings.", "error");
    return;
  }

  populateForm(response.settings || {});
  hasUnsavedChanges = false;
  syncSandboxAvailability();
  setSaveStatus("Saved. Your reply settings were updated.", "saved");
});

sandboxForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (hasUnsavedChanges) {
    setSandboxStatus("Save your changes first so the sandbox uses your latest configuration.", "error");
    return;
  }

  const payload = readSandboxValues();

  if (!payload.latestMessage) {
    setSandboxStatus("Paste a mock email first.", "error");
    sandboxLatestMessageInput.focus();
    return;
  }

  sandboxBusy = true;
  syncSandboxAvailability();
  setSandboxStatus("Testing your saved setup...", "saving");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "settings:test-sandbox",
      payload
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not test the sandbox.");
    }

    renderSandboxResult(response);
    setSandboxStatus("Sandbox result ready.", "saved");
  } catch (error) {
    setSandboxStatus(error instanceof Error ? error.message : "Could not test the sandbox.", "error");
  } finally {
    sandboxBusy = false;
    syncSandboxAvailability();
  }
});

sandboxFillSampleButton.addEventListener("click", () => {
  sandboxSenderNameInput.value = "Alice Chen";
  sandboxSenderEmailInput.value = "alice@brightstudio.co";
  sandboxSubjectInput.value = "Question about your design package";
  sandboxLatestMessageInput.value = "Hi Henrique,\n\nI found your website and wanted to ask whether you work with early-stage startups on branding and a simple landing page. We are moving quickly and would love to understand your timeline and starting price.\n\nThanks,\nAlice";
  sandboxThreadHistoryInput.value = "";
  setSandboxStatus(hasUnsavedChanges
    ? "Sample loaded. Save your configuration first, then test it here."
    : "Sample loaded. You can test it now.", hasUnsavedChanges ? "dirty" : "idle");
});

trackedInputs.forEach((input) => {
  const eventName = input instanceof HTMLInputElement && (input.type === "checkbox" || input.type === "radio")
    ? "change"
    : "input";
  input.addEventListener(eventName, () => {
    hasUnsavedChanges = true;
    setSaveStatus("Unsaved changes.", "dirty");
    syncSandboxAvailability();
  });
});

[replyRulesStandardInput, replyRulesCustomInput].forEach((input) => {
  input.addEventListener("change", () => {
    syncReplyRulesUi();
  });
});

attentionRulesEnabledInput.addEventListener("change", () => {
  syncAttentionRulesUi();
});

async function initialize() {
  const response = await chrome.runtime.sendMessage({ type: "settings:get" });
  const settings = response?.settings || {};

  populateForm(settings);
  hasUnsavedChanges = false;
  setActiveTab("configuration");
  syncSandboxAvailability();
  setSaveStatus("Current settings loaded.", "idle");
  setSandboxStatus("Ready to test.", "idle");
}

function readFormValues() {
  return {
    replyDecisionMode: replyRulesCustomInput.checked ? "custom" : "standard",
    replyDecisionInstructions: replyRulesInstructionsInput.value.trim(),
    attentionRulesEnabled: attentionRulesEnabledInput.checked,
    attentionRules: attentionRulesInput.value.trim(),
    identity: identityInput.value.trim(),
    replyStyle: replyStyleInput.value.trim(),
    knowledge: knowledgeInput.value.trim(),
    signature: signatureInput.value.trim(),
    systemPrompt: systemPromptInput.value.trim(),
    skipRepliedThreads: skipRepliedThreadsInput.checked,
    skipNoReplySenders: skipNoReplySendersInput.checked,
    autoSendFirstContactOnly: autoSendFirstContactOnlyInput.checked,
    allowedSenders: allowedSendersInput.value.trim(),
    ignoredSenders: ignoredSendersInput.value.trim(),
    ignoredSubjects: ignoredSubjectsInput.value.trim()
  };
}

function readSandboxValues() {
  const latestMessage = sandboxLatestMessageInput.value.trim();
  const earlierThreadContext = sandboxThreadHistoryInput.value.trim();
  const threadMessages = [];

  if (earlierThreadContext) {
    threadMessages.push(earlierThreadContext);
  }

  if (latestMessage) {
    threadMessages.push(latestMessage);
  }

  return {
    senderName: sandboxSenderNameInput.value.trim(),
    senderEmail: sandboxSenderEmailInput.value.trim(),
    subject: sandboxSubjectInput.value.trim(),
    latestMessage,
    threadMessages
  };
}

function populateForm(settings) {
  const replyDecisionMode = settings.replyDecisionMode === "custom" ? "custom" : "standard";
  replyRulesStandardInput.checked = replyDecisionMode === "standard";
  replyRulesCustomInput.checked = replyDecisionMode === "custom";
  replyRulesInstructionsInput.value = settings.replyDecisionInstructions || "";
  attentionRulesEnabledInput.checked = settings.attentionRulesEnabled === true;
  attentionRulesInput.value = settings.attentionRules || "";
  syncReplyRulesUi();
  syncAttentionRulesUi();
  identityInput.value = settings.identity || "";
  replyStyleInput.value = settings.replyStyle || "";
  knowledgeInput.value = settings.knowledge || "";
  signatureInput.value = settings.signature || "";
  systemPromptInput.value = settings.systemPrompt || "";
  skipRepliedThreadsInput.checked = settings.skipRepliedThreads !== false;
  skipNoReplySendersInput.checked = settings.skipNoReplySenders !== false;
  autoSendFirstContactOnlyInput.checked = settings.autoSendFirstContactOnly === true;
  allowedSendersInput.value = settings.allowedSenders || "";
  ignoredSendersInput.value = settings.ignoredSenders || "";
  ignoredSubjectsInput.value = settings.ignoredSubjects || "";
}

function setActiveTab(tabName) {
  const showSandbox = tabName === "sandbox";
  configurationTabButton.classList.toggle("active", !showSandbox);
  configurationTabButton.setAttribute("aria-selected", String(!showSandbox));
  sandboxTabButton.classList.toggle("active", showSandbox);
  sandboxTabButton.setAttribute("aria-selected", String(showSandbox));
  settingsForm.classList.toggle("hidden", showSandbox);
  sandboxPanel.classList.toggle("hidden", !showSandbox);
}

function syncSandboxAvailability() {
  sandboxRunButton.disabled = sandboxBusy || hasUnsavedChanges;
  sandboxFillSampleButton.disabled = sandboxBusy;

  if (sandboxBusy) {
    sandboxHint.textContent = "Testing your latest saved configuration.";
    return;
  }

  if (hasUnsavedChanges) {
    sandboxHint.textContent = "Save your changes first. The sandbox always uses the latest saved configuration.";
    return;
  }

  sandboxHint.textContent = "The sandbox uses the same saved settings the automation uses in Gmail.";
}

function setSaveStatus(message, state) {
  saveStatus.textContent = message;
  saveStatus.dataset.state = state;
}

function setSandboxStatus(message, state) {
  sandboxStatus.textContent = message;
  sandboxStatus.dataset.state = state;
}

function renderSandboxResult(result) {
  const sender = result.senderEmail
    ? `${result.senderName || "Unknown sender"} <${result.senderEmail}>`
    : result.senderName || "Unknown sender";
  const subject = result.subject || "(No subject)";

  sandboxResultCard.classList.remove("hidden");
  sandboxResultCard.dataset.kind = result.noReply
    ? "no-reply"
    : result.needsAttention
      ? "attention"
      : "reply";
  sandboxResultMeta.textContent = `${sender} • ${subject}`;

  if (result.noReply) {
    sandboxResultTitle.textContent = "No Reply Needed";
    sandboxResultSummary.textContent = "The A.I. would skip this email instead of answering it.";
    sandboxResultBody.textContent = result.reason || "This email does not need a reply.";
    return;
  }

  if (result.needsAttention) {
    sandboxResultTitle.textContent = "Leave This For You";
    sandboxResultSummary.textContent = "The A.I. would leave this one for you based on your saved rules.";
    sandboxResultBody.textContent = result.reason || "This email would be left for you.";
    return;
  }

  sandboxResultTitle.textContent = "Draft Reply";
  sandboxResultSummary.textContent = "This is the reply the A.I. would draft with your saved setup.";
  sandboxResultBody.textContent = result.draft || "";
}

function syncReplyRulesUi() {
  const customSelected = replyRulesCustomInput.checked;
  replyRulesInstructionsField.classList.toggle("field-disabled", !customSelected);
  replyRulesInstructionsInput.disabled = !customSelected;
}

function syncAttentionRulesUi() {
  const enabled = attentionRulesEnabledInput.checked;
  attentionRulesField.classList.toggle("field-disabled", !enabled);
  attentionRulesInput.disabled = !enabled;
}

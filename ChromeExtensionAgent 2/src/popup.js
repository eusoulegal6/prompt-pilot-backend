const GMAIL_PROVIDER_ID = "gmail";
const GMAIL_LABEL = "Gmail";

const heroCopy = document.getElementById("hero-copy");
const optionsButton = document.getElementById("options-button");
const contextCard = document.getElementById("context-card");
const contextTitle = document.getElementById("context-title");
const contextHelp = document.getElementById("context-help");
const automationCard = document.getElementById("automation-card");
const manualCard = document.getElementById("manual-card");
const attentionCard = document.getElementById("attention-card");
const noReplyCard = document.getElementById("no-reply-card");
const monitorToggleButton = document.getElementById("monitor-toggle-button");
const openReviewButton = document.getElementById("open-review-button");
const monitorSummary = document.getElementById("monitor-summary");
const modeReviewButton = document.getElementById("mode-review-button");
const modeAutoButton = document.getElementById("mode-auto-button");
const modeHelp = document.getElementById("mode-help");
const attentionMessage = document.getElementById("attention-message");
const pendingReviewMessage = document.getElementById("pending-review-message");
const manualHelp = document.getElementById("manual-help");
const manualDraftButton = document.getElementById("manual-draft-button");
const attentionCount = document.getElementById("attention-count");
const attentionQueue = document.getElementById("attention-queue");
const noReplyCount = document.getElementById("no-reply-count");
const noReplySummary = document.getElementById("no-reply-summary");
const noReplyQueue = document.getElementById("no-reply-queue");
const statusText = document.getElementById("status-text");

let monitorState = {};
let activeProvider = null;
let busy = false;

initialize();

optionsButton.addEventListener("click", openSettings);

monitorToggleButton.addEventListener("click", async () => {
  if (!isOnGmail()) {
    setStatus("Open Gmail in the active tab first.");
    return;
  }

  const nextEnabled = !getGmailMonitorState().enabled;
  busy = true;
  renderBusyState();
  setStatus(nextEnabled ? "Starting automation..." : "Pausing automation...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "monitor:set-enabled",
      payload: {
        provider: GMAIL_PROVIDER_ID,
        enabled: nextEnabled
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not update automation.");
    }

    monitorState = response.monitorState || monitorState;
    render();
    setStatus(nextEnabled ? "Automation started." : "Automation paused.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not update automation.");
  } finally {
    busy = false;
    renderBusyState();
  }
});

modeReviewButton.addEventListener("click", async () => {
  await updateReplyMode(false);
});

modeAutoButton.addEventListener("click", async () => {
  await updateReplyMode(true);
});

openReviewButton.addEventListener("click", async () => {
  const pendingReview = getGmailMonitorState().pendingReview;

  if (!pendingReview?.threadId) {
    return;
  }

  await performHistoryAction("open-thread", pendingReview.threadId);
});

manualDraftButton.addEventListener("click", async () => {
  if (!isOnGmail()) {
    setStatus("Open Gmail in the active tab first.");
    return;
  }

  busy = true;
  renderBusyState();
  setStatus("Drafting this email with the A.I....");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "monitor:draft-current-thread",
      payload: {
        provider: GMAIL_PROVIDER_ID
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not draft this email.");
    }

    setStatus(response.needsAttention
      ? response.reason || "The A.I. left this email for you."
      : response.noReply
        ? response.reason || "The A.I. decided this email does not need a reply."
        : "Draft ready in Gmail.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not draft this email.");
  } finally {
    busy = false;
    renderBusyState();
  }
});

function bindHistoryActions(container) {
  container.addEventListener("click", async (event) => {
    const button = event.target instanceof HTMLElement ? event.target.closest("button[data-thread-action]") : null;

    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const action = `${button.dataset.threadAction || ""}`.trim();
    const threadId = `${button.dataset.threadId || ""}`.trim();

    if (!action || !threadId) {
      return;
    }

    await performHistoryAction(action, threadId);
  });
}

bindHistoryActions(attentionQueue);
bindHistoryActions(noReplyQueue);

async function initialize() {
  try {
    const [monitorResponse, providerResponse] = await Promise.all([
      chrome.runtime.sendMessage({ type: "monitor:get-state" }),
      chrome.runtime.sendMessage({ type: "email:get-provider" })
    ]);

    monitorState = monitorResponse?.monitorState || {};
    activeProvider = providerResponse?.provider || null;
    render();

    const gmailState = getGmailMonitorState();

    if (isStoppedUnexpectedly(gmailState)) {
      setStatus("Stopped automatically.");
    } else if (!isOnGmail()) {
      setStatus("Open Gmail to use the extension.");
    } else {
      setStatus("Ready.");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not load the extension.");
  }
}

async function updateReplyMode(autoReplyEnabled) {
  if (!isOnGmail()) {
    setStatus("Open Gmail in the active tab first.");
    return;
  }

  busy = true;
  renderBusyState();
  setStatus(autoReplyEnabled ? "Switching to automatic sending..." : "Switching to review mode...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "monitor:set-auto-reply",
      payload: {
        provider: GMAIL_PROVIDER_ID,
        enabled: autoReplyEnabled
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not update reply mode.");
    }

    monitorState = response.monitorState || monitorState;
    const gmailState = getGmailMonitorState();
    render();
    setStatus(
      gmailState.enabled
        ? autoReplyEnabled
          ? "Automatic sending enabled."
          : "Review mode enabled."
        : autoReplyEnabled
          ? "Automatic sending selected. Press Start when you're ready."
          : "Review mode selected. Press Start when you're ready."
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not update reply mode.");
  } finally {
    busy = false;
    renderBusyState();
  }
}

async function performHistoryAction(action, threadId) {
  busy = true;
  renderBusyState();

  try {
    if (action === "open-thread") {
      setStatus("Opening the email in Gmail...");
      const response = await chrome.runtime.sendMessage({
        type: "monitor:open-thread",
        payload: {
          provider: GMAIL_PROVIDER_ID,
          threadId
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not open the email.");
      }

      monitorState = response.monitorState || monitorState;
      render();
      setStatus("Email opened in Gmail.");
      return;
    }

    if (action === "dismiss-thread") {
      setStatus("Removing this email...");
      const response = await chrome.runtime.sendMessage({
        type: "monitor:dismiss-thread",
        payload: {
          provider: GMAIL_PROVIDER_ID,
          threadId
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not remove the email.");
      }

      monitorState = response.monitorState || monitorState;
      render();
      setStatus("Email removed.");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Action failed.");
  } finally {
    busy = false;
    renderBusyState();
  }
}

function render() {
  const onGmail = isOnGmail();
  const gmailState = getGmailMonitorState();
  const pendingReview = gmailState.pendingReview || null;
  const attentionThreads = getAttentionThreads(gmailState);
  const noReplyThreads = getNoReplyThreads(gmailState);
  const stoppedUnexpectedly = isStoppedUnexpectedly(gmailState);
  const pauseReason = `${gmailState.pauseReason || ""}`.trim();

  contextCard.classList.toggle("hidden", onGmail);
  automationCard.classList.toggle("hidden", !onGmail);
  manualCard.classList.toggle("hidden", !onGmail);
  attentionCard.classList.toggle("hidden", !onGmail || attentionThreads.length === 0);
  noReplyCard.classList.toggle("hidden", !onGmail || noReplyThreads.length === 0);

  heroCopy.textContent = buildHeroCopy(onGmail, gmailState);
  contextTitle.textContent = stoppedUnexpectedly
    ? "Automation stopped automatically."
    : "Open Gmail in the active tab to use this extension.";
  contextHelp.textContent = stoppedUnexpectedly
    ? pauseReason
    : "The automation works on mail.google.com. Once Gmail is open, click the extension again.";

  attentionMessage.classList.toggle("hidden", !(onGmail && stoppedUnexpectedly));
  attentionMessage.textContent = pauseReason;

  pendingReviewMessage.classList.toggle("hidden", !pendingReview);
  pendingReviewMessage.textContent = pendingReview
    ? buildPendingReviewMessage(pendingReview)
    : "";

  openReviewButton.classList.toggle("hidden", !pendingReview?.threadId);

  monitorToggleButton.textContent = gmailState.enabled ? "Pause" : stoppedUnexpectedly ? "Start again" : "Start";
  monitorSummary.textContent = buildMonitorSummary(gmailState);

  modeReviewButton.classList.toggle("active", !gmailState.autoReplyEnabled);
  modeAutoButton.classList.toggle("active", gmailState.autoReplyEnabled);
  modeHelp.textContent = gmailState.autoReplyEnabled
    ? "Automatic mode drafts and sends replies one by one as new unread emails arrive."
    : "Review mode drafts directly inside Gmail and waits there until you press Send in Gmail.";

  manualHelp.textContent = gmailState.enabled
    ? "Pause automation before using one-time drafting."
    : pendingReview
      ? "Finish the review draft already open in Gmail before drafting another email."
      : "Open a Gmail email and click once to let the A.I. draft a reply without sending it.";

  renderAttention(attentionThreads);
  renderNoReply(noReplyThreads);
  renderBusyState();
}

function renderAttention(threads) {
  attentionCount.textContent = `${threads.length}`;

  if (threads.length === 0) {
    attentionQueue.className = "queue-list empty";
    attentionQueue.textContent = "Nothing needs your attention right now.";
    return;
  }

  attentionQueue.className = "queue-list";
  attentionQueue.innerHTML = "";

  threads.slice(0, 10).forEach((thread) => {
    const card = document.createElement("article");
    card.className = "thread-card";

    const header = document.createElement("div");
    header.className = "thread-header";

    const headingBlock = document.createElement("div");
    headingBlock.className = "thread-heading";

    const subject = document.createElement("h2");
    subject.className = "thread-subject";
    subject.textContent = thread.subject || "(No subject)";

    const sender = document.createElement("p");
    sender.className = "thread-meta";
    sender.textContent = thread.senderEmail
      ? `${thread.sender || "Unknown sender"} <${thread.senderEmail}>`
      : thread.sender || "Unknown sender";

    const note = document.createElement("p");
    note.className = thread.status === "error" ? "thread-error" : "thread-note";
    note.textContent = getHistoryReason(thread);

    const badge = document.createElement("span");
    badge.className = `badge ${badgeToneForHistory(thread)}`;
    badge.textContent = badgeLabelForHistory(thread);

    headingBlock.appendChild(subject);
    headingBlock.appendChild(sender);
    header.appendChild(headingBlock);
    header.appendChild(badge);

    card.appendChild(header);
    card.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "thread-actions";
    actions.appendChild(buildThreadActionButton("Open in Gmail", "open-thread", thread.threadId, "secondary"));
    actions.appendChild(buildThreadActionButton("Dismiss", "dismiss-thread", thread.threadId, "ghost"));

    card.appendChild(actions);
    attentionQueue.appendChild(card);
  });
}

function renderNoReply(threads) {
  noReplyCount.textContent = `${threads.length}`;
  noReplySummary.textContent = threads.length === 1 ? "Show 1 email" : `Show ${threads.length} emails`;

  if (threads.length === 0) {
    noReplyQueue.className = "queue-list empty";
    noReplyQueue.textContent = "No emails were skipped.";
    return;
  }

  noReplyQueue.className = "queue-list";
  noReplyQueue.innerHTML = "";

  threads.slice(0, 12).forEach((thread) => {
    const card = document.createElement("article");
    card.className = "thread-card";

    const header = document.createElement("div");
    header.className = "thread-header";

    const headingBlock = document.createElement("div");
    headingBlock.className = "thread-heading";

    const subject = document.createElement("h2");
    subject.className = "thread-subject";
    subject.textContent = thread.subject || "(No subject)";

    const sender = document.createElement("p");
    sender.className = "thread-meta";
    sender.textContent = thread.senderEmail
      ? `${thread.sender || "Unknown sender"} <${thread.senderEmail}>`
      : thread.sender || "Unknown sender";

    const note = document.createElement("p");
    note.className = "thread-note";
    note.textContent = thread.skipReason || "The A.I. decided this email did not need a reply.";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "No reply";

    headingBlock.appendChild(subject);
    headingBlock.appendChild(sender);
    header.appendChild(headingBlock);
    header.appendChild(badge);

    card.appendChild(header);
    card.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "thread-actions";
    actions.appendChild(buildThreadActionButton("Open in Gmail", "open-thread", thread.threadId, "secondary"));
    actions.appendChild(buildThreadActionButton("Dismiss", "dismiss-thread", thread.threadId, "ghost"));

    card.appendChild(actions);
    noReplyQueue.appendChild(card);
  });
}

function buildThreadActionButton(label, action, threadId, tone = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.threadAction = action;
  button.dataset.threadId = threadId || "";

  if (tone) {
    button.classList.add(tone);
  }

  return button;
}

function renderBusyState() {
  const gmailState = getGmailMonitorState();
  const pendingReview = gmailState.pendingReview;
  const controlsDisabled = !isOnGmail();

  monitorToggleButton.disabled = controlsDisabled || busy;
  modeReviewButton.disabled = controlsDisabled || busy;
  modeAutoButton.disabled = controlsDisabled || busy;
  openReviewButton.disabled = controlsDisabled || busy;
  manualDraftButton.disabled = controlsDisabled || busy || gmailState.enabled || !!pendingReview;

  const buttons = document.querySelectorAll("#attention-queue button[data-thread-action], #no-reply-queue button[data-thread-action]");
  buttons.forEach((button) => {
    button.disabled = busy;
  });
}

function getAttentionThreads(gmailState) {
  return Array.isArray(gmailState.inboxQueue)
    ? gmailState.inboxQueue.filter((thread) =>
      thread.status === "needs-attention" ||
      thread.status === "error" ||
      !!`${thread.reviewNote || ""}`.trim()
    )
    : [];
}

function getNoReplyThreads(gmailState) {
  return Array.isArray(gmailState.inboxQueue)
    ? gmailState.inboxQueue.filter((thread) => thread.status === "skipped")
    : [];
}

function getGmailMonitorState() {
  return monitorState?.providers?.[GMAIL_PROVIDER_ID] || {
    enabled: false,
    autoReplyEnabled: false,
    intervalMinutes: 1,
    lastCheckedAt: "",
    pauseReason: "",
    pendingReview: null,
    inboxQueue: []
  };
}

function buildHeroCopy(onGmail, gmailState) {
  if (isStoppedUnexpectedly(gmailState)) {
    return onGmail
      ? "Automation stopped automatically so it does not keep guessing. Open the inbox you want and press Start again."
      : "Automation stopped automatically. Open the Gmail inbox you want and then press Start again.";
  }

  if (!onGmail) {
    return "Open Gmail to start automation or draft one email by hand.";
  }

  if (gmailState.pendingReview?.threadId && gmailState.enabled && !gmailState.autoReplyEnabled) {
    return "A review draft is waiting in Gmail. Check it there, press Send in Gmail, and the next email will follow automatically.";
  }

  if (gmailState.enabled && gmailState.autoReplyEnabled) {
    return "Automatic mode is running. New Gmail emails will be drafted and sent for you.";
  }

  if (gmailState.enabled) {
    return "Review mode is running. The next email will be drafted inside Gmail and wait there for you.";
  }

  return "Choose how replies should work, press Start, or draft one open email by hand.";
}

function buildMonitorSummary(gmailState) {
  if (isStoppedUnexpectedly(gmailState)) {
    return `Stopped automatically. ${gmailState.pauseReason || ""}`.trim();
  }

  const lastChecked = gmailState.lastCheckedAt
    ? new Date(gmailState.lastCheckedAt).toLocaleString()
    : "Never";

  if (gmailState.pendingReview?.threadId && gmailState.enabled && !gmailState.autoReplyEnabled) {
    return `Waiting in review mode on ${GMAIL_LABEL}. Press Send in Gmail when you're happy with the draft, and the next email will start automatically.`;
  }

  if (!gmailState.enabled) {
    return "Paused. Start will check Gmail right away and then keep watching for new emails.";
  }

  return gmailState.autoReplyEnabled
    ? `Running in automatic mode on ${GMAIL_LABEL}. Replies are drafted and sent automatically. Last checked: ${lastChecked}.`
    : `Running in review mode on ${GMAIL_LABEL}. Replies are drafted inside Gmail and wait there for you. Last checked: ${lastChecked}.`;
}

function buildPendingReviewMessage(pendingReview) {
  const sender = pendingReview.senderEmail
    ? `${pendingReview.sender || "Unknown sender"} <${pendingReview.senderEmail}>`
    : pendingReview.sender || "Unknown sender";
  const subject = pendingReview.subject || "(No subject)";
  return `Draft waiting in Gmail for ${sender} about "${subject}". Review it there and press Send in Gmail to continue.`;
}

function badgeToneForHistory(thread) {
  if (thread.status === "error") {
    return "danger";
  }

  if (`${thread.reviewNote || ""}`.trim()) {
    return "warn";
  }

  return "";
}

function badgeLabelForHistory(thread) {
  if (thread.status === "error") {
    return "Needs attention";
  }

  if (thread.status === "needs-attention") {
    return "Needs you";
  }

  if (`${thread.reviewNote || ""}`.trim()) {
    return "Left for you";
  }

  return "No reply";
}

function getHistoryReason(thread) {
  if (thread.status === "error") {
    return thread.lastError || "Something went wrong while working on this email.";
  }

  if (`${thread.reviewNote || ""}`.trim()) {
    return thread.reviewNote;
  }

  return thread.skipReason || "The A.I. decided this email did not need a reply.";
}

function isOnGmail() {
  return activeProvider?.id === GMAIL_PROVIDER_ID;
}

function isStoppedUnexpectedly(gmailState) {
  return !gmailState?.enabled && !!`${gmailState?.pauseReason || ""}`.trim();
}

function openSettings() {
  chrome.runtime.openOptionsPage();
}

function setStatus(value) {
  statusText.textContent = value;
}

export const AGENT_ACTIONS = [
  { id: "get_page_snapshot", label: "Page Snapshot", description: "Read the main content and metadata from the active tab.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "detect_email_provider", label: "Detect Email Provider", description: "Detect whether the active tab is a supported webmail provider.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "gmail_extract_thread_context", label: "Gmail Extract Thread Context", description: "Extract Gmail thread metadata and visible message content from the open thread.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "gmail_list_inbox_threads", label: "Gmail List Inbox Threads", description: "List visible Gmail inbox threads with subject, sender, preview, and reusable row targets.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "gmail_open_thread", label: "Gmail Open Thread", description: "Open a Gmail thread from the inbox using a thread URL, row target, or row index.", risk: "write", requiresConfirmation: true, exampleArgs: { threadUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQ..." } },
  { id: "gmail_go_to_next_page", label: "Gmail Next Page", description: "Move Gmail inbox pagination to the next page when available.", risk: "write", requiresConfirmation: true, exampleArgs: {} },
  { id: "gmail_return_to_inbox", label: "Gmail Return To Inbox", description: "Return from an open Gmail thread to the inbox list, preserving pagination when possible.", risk: "write", requiresConfirmation: true, exampleArgs: {} },
  { id: "outlook_extract_thread_context", label: "Outlook Extract Thread Context", description: "Extract Outlook thread metadata and visible message content from the open thread.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "outlook_list_inbox_threads", label: "Outlook List Inbox Threads", description: "List visible Outlook inbox threads with subject, sender, preview, and reusable row targets.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "outlook_open_thread", label: "Outlook Open Thread", description: "Open an Outlook thread from the inbox using a thread URL, row target, or row index.", risk: "write", requiresConfirmation: true, exampleArgs: { rowIndex: 0 } },
  { id: "get_selection", label: "Get Selection", description: "Read the current user selection from the active tab.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "find_interactive_elements", label: "Find Interactive Elements", description: "List visible links, buttons, inputs, and similar controls with reusable target descriptors.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "get_form_fields", label: "Get Form Fields", description: "Inspect visible form fields and their labels.", risk: "read", requiresConfirmation: false, exampleArgs: {} },
  { id: "wait_for_element", label: "Wait For Element", description: "Poll until a target appears on the page.", risk: "read", requiresConfirmation: false, exampleArgs: { target: { text: "Play" }, timeoutMs: 3000 } },
  { id: "click_element", label: "Click Element", description: "Click a visible DOM element resolved from a stable target.", risk: "write", requiresConfirmation: true, exampleArgs: { target: { selector: "#submit-button" } } },
  { id: "set_input_value", label: "Set Input Value", description: "Fill a form field and dispatch input/change events.", risk: "write", requiresConfirmation: true, exampleArgs: { target: { name: "email" }, value: "user@example.com" } },
  { id: "press_key", label: "Press Key", description: "Send a keyboard key to a target element or the current active element.", risk: "write", requiresConfirmation: true, exampleArgs: { key: "Enter" } },
  { id: "submit_form", label: "Submit Form", description: "Submit a form resolved from a target field, target form, or the active element.", risk: "write", requiresConfirmation: true, exampleArgs: { target: { name: "email" } } },
  { id: "gmail_open_reply_box", label: "Gmail Open Reply Box", description: "Open the Gmail reply editor in the current thread.", risk: "write", requiresConfirmation: true, exampleArgs: {} },
  { id: "gmail_fill_reply_body", label: "Gmail Fill Reply Body", description: "Fill the Gmail reply editor with the provided draft body.", risk: "write", requiresConfirmation: true, exampleArgs: { body: "Thanks for the note. I will get back to you shortly." } },
  { id: "gmail_send_reply", label: "Gmail Send Reply", description: "Send the currently open Gmail reply draft.", risk: "write", requiresConfirmation: true, exampleArgs: {} }
  ,
  { id: "outlook_open_reply_box", label: "Outlook Open Reply Box", description: "Open the Outlook reply editor in the current thread.", risk: "write", requiresConfirmation: true, exampleArgs: {} },
  { id: "outlook_fill_reply_body", label: "Outlook Fill Reply Body", description: "Fill the Outlook reply editor with the provided draft body.", risk: "write", requiresConfirmation: true, exampleArgs: { body: "Thanks for the note. I will get back to you shortly." } }
];

export async function getUsableActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const url = `${tab.url || tab.pendingUrl || ""}`.trim();

  if (!url) {
    throw new Error("The active tab URL could not be determined.");
  }

  if (url.startsWith("file:")) {
    throw new Error(`This tab uses ${url}. Enable "Allow access to file URLs" for the extension before analyzing it.`);
  }

  if (/^(about:|chrome:|chrome-extension:|devtools:|edge:|view-source:)/i.test(url) || /^https:\/\/chromewebstore\.google\.com/i.test(url)) {
    throw new Error(`Chrome does not allow analysis on this tab (${url}). Open a normal web page instead.`);
  }

  return tab;
}

export async function executeAgentAction(action, args = {}) {
  const tab = await getUsableActiveTab();
  return await executeAgentActionOnTab(tab.id, action, args);
}

export async function executeAgentActionOnTab(tabId, action, args = {}) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: runAgentActionInPage,
    args: [action, args]
  });
  const payload = results?.[0]?.result;

  if (!payload?.ok) {
    throw new Error(payload?.error || `Action ${action} failed.`);
  }

  return payload.result;
}

export async function openAgentPanel() {
  const tab = await getUsableActiveTab();

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectAgentPanel,
    args: [AGENT_ACTIONS]
  });
}

async function runAgentActionInPage(action, args) {
  const INTERACTIVE_SELECTOR = "a[href], button, input, select, textarea, summary, [role='button'], [tabindex]";
  const FORM_FIELD_SELECTOR = "input, select, textarea, [contenteditable='true']";

  try {
    const normalizedArgs = normalizeArgs(args);

    switch (action) {
      case "get_page_snapshot":
        return { ok: true, result: getPageSnapshot() };
      case "detect_email_provider":
        return { ok: true, result: detectEmailProvider() };
      case "gmail_extract_thread_context":
        return { ok: true, result: extractGmailThreadContext() };
      case "gmail_list_inbox_threads":
        return { ok: true, result: listGmailInboxThreads() };
      case "gmail_open_thread":
        return { ok: true, result: await runObservedWrite(() => openGmailThread(normalizedArgs)) };
      case "gmail_go_to_next_page":
        return { ok: true, result: await runObservedWrite(() => goToNextGmailInboxPage()) };
      case "gmail_return_to_inbox":
        return { ok: true, result: await runObservedWrite(() => returnToGmailInbox(normalizedArgs)) };
      case "outlook_extract_thread_context":
        return { ok: true, result: extractOutlookThreadContext() };
      case "outlook_list_inbox_threads":
        return { ok: true, result: listOutlookInboxThreads() };
      case "outlook_open_thread":
        return { ok: true, result: await runObservedWrite(() => openOutlookThread(normalizedArgs)) };
      case "get_selection":
        return { ok: true, result: { selection: `${window.getSelection?.()?.toString() || ""}`.trim().slice(0, 1500) } };
      case "find_interactive_elements":
        return { ok: true, result: { elements: queryVisible(INTERACTIVE_SELECTOR).map(describeInteractive) } };
      case "get_form_fields":
        return { ok: true, result: { fields: queryVisible(FORM_FIELD_SELECTOR).map(describeField) } };
      case "wait_for_element":
        return { ok: true, result: await waitForTarget(normalizedArgs) };
      case "click_element":
        return { ok: true, result: await runObservedWrite(() => clickTarget(normalizedArgs.target)) };
      case "set_input_value":
        return { ok: true, result: await runObservedWrite(() => setInputValue(normalizedArgs.target, normalizedArgs)) };
      case "press_key":
        return { ok: true, result: await runObservedWrite(() => pressKey(normalizedArgs)) };
      case "submit_form":
        return { ok: true, result: await runObservedWrite(() => submitForm(normalizedArgs.target)) };
      case "gmail_open_reply_box":
        return { ok: true, result: await runObservedWrite(() => openGmailReplyBox()) };
      case "gmail_fill_reply_body":
        return { ok: true, result: await runObservedWrite(() => fillGmailReplyBody(normalizedArgs)) };
      case "gmail_send_reply":
        return { ok: true, result: await runObservedWrite(() => sendGmailReply()) };
      case "outlook_open_reply_box":
        return { ok: true, result: await runObservedWrite(() => openOutlookReplyBox()) };
      case "outlook_fill_reply_body":
        return { ok: true, result: await runObservedWrite(() => fillOutlookReplyBody(normalizedArgs)) };
      default:
        throw new Error(`Unsupported page action: ${action}`);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown page action error." };
  }

  function normalizeArgs(value) {
    const next = value && typeof value === "object" ? { ...value } : {};

    if (next.selector && !next.target) {
      next.target = { selector: next.selector };
    }

    if (typeof next.target === "string") {
      next.target = { selector: next.target };
    }

    if (!next.target && next.id) {
      next.target = { id: next.id };
    }

    return next;
  }

  function detectEmailProvider() {
    if (location.hostname === "mail.google.com") {
      return {
        id: "gmail",
        label: "Gmail",
        url: location.href
      };
    }

    if (["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(location.hostname)) {
      return {
        id: "outlook",
        label: "Outlook",
        url: location.href
      };
    }

    return null;
  }

  function ensureGmail() {
    if (location.hostname !== "mail.google.com") {
      throw new Error("This Gmail action can only run on mail.google.com.");
    }
  }

  function ensureOutlook() {
    if (!["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(location.hostname)) {
      throw new Error("This Outlook action can only run on Outlook Web.");
    }
  }

  function extractGmailThreadContext() {
    ensureGmail();

    const subject =
      document.querySelector("h2[data-thread-perm-id]")?.textContent?.trim() ||
      document.querySelector("h2.hP")?.textContent?.trim() ||
      document.querySelector("h2")?.textContent?.trim() ||
      "";

    const senderCandidates = getGmailThreadSenderCandidates();

    const messageBodies = Array.from(document.querySelectorAll("div.a3s, div[data-message-id] div[dir='auto'], div[role='listitem'] div[dir='auto']"))
      .map((element) => `${element.textContent || ""}`.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim())
      .filter((text, index, values) => text.length > 20 && values.indexOf(text) === index)
      .slice(-5);

    const openReplyBox = findVisibleElement([
      "div[role='textbox'][g_editable='true']",
      "div[role='textbox'][aria-label*='Message Body']",
      "div[contenteditable='true'][aria-label*='Message Body']"
    ]);

    return {
      provider: "gmail",
      subject,
      senders: senderCandidates,
      latestMessage: messageBodies[messageBodies.length - 1] || "",
      threadMessages: messageBodies,
      hasOpenReplyBox: !!openReplyBox
    };
  }

  function getGmailThreadSenderCandidates() {
    const messageRoots = Array.from(document.querySelectorAll("div[data-message-id], div.adn, div[role='listitem']"))
      .filter((element) => element instanceof HTMLElement && isVisible(element));
    const visibleMessageSenders = messageRoots
      .map((root) => extractGmailSenderCandidate(root))
      .filter((item) => item.name || item.email)
      .reverse();
    const fallbackSenders = Array.from(document.querySelectorAll("span[email], h3 span[email], .gD[email]"))
      .filter((element) => element instanceof HTMLElement && isVisible(element))
      .map((element) => ({
        name: `${element.textContent || ""}`.replace(/\s+/g, " ").trim(),
        email: element.getAttribute("email") || ""
      }))
      .filter((item) => item.name || item.email);
    const seen = new Set();

    return [...visibleMessageSenders, ...fallbackSenders]
      .filter((item) => {
        const key = `${item.email || ""}::${item.name || ""}`.trim();

        if (!key || seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      })
      .slice(0, 10);
  }

  function extractGmailSenderCandidate(root) {
    const senderElement = root.querySelector(".gD[email], h3 span[email], span[email]");

    if (!(senderElement instanceof HTMLElement)) {
      return {
        name: "",
        email: ""
      };
    }

    return {
      name: `${senderElement.textContent || ""}`.replace(/\s+/g, " ").trim(),
      email: senderElement.getAttribute("email") || ""
    };
  }

  function listGmailInboxThreads() {
    ensureGmail();

    if (isGmailThreadView()) {
      return {
        provider: "gmail",
        location: location.href,
        threads: []
      };
    }

    const threadRows = Array.from(document.querySelectorAll("tr[role='row'][jscontroller], tr.zA"))
      .filter((row) => row instanceof HTMLElement && isVisible(row))
      .slice(0, 30);

    return {
      provider: "gmail",
      location: location.href,
      threads: threadRows
        .map((row, index) => describeGmailThreadRow(row, index))
        .filter((thread) => thread.threadId)
    };
  }

  function extractOutlookThreadContext() {
    ensureOutlook();

    const subject =
      document.querySelector("h1[title]")?.textContent?.trim() ||
      document.querySelector("div[role='heading'][aria-level='1']")?.textContent?.trim() ||
      document.querySelector("h1, h2")?.textContent?.trim() ||
      "";

    const senderCandidates = Array.from(document.querySelectorAll("[title][data-email], [data-email], [aria-label*='From']"))
      .map((element) => ({
        name: `${element.textContent || element.getAttribute("title") || ""}`.replace(/\s+/g, " ").trim(),
        email: element.getAttribute("data-email") || ""
      }))
      .filter((item) => item.name || item.email)
      .slice(0, 10);

    const messageBodies = Array.from(document.querySelectorAll("div[role='document'], div[aria-label*='Message body'], div[data-app-section='MailReadCompose'] div[dir='ltr'], div[dir='auto']"))
      .map((element) => `${element.textContent || ""}`.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim())
      .filter((text, index, values) => text.length > 20 && values.indexOf(text) === index)
      .slice(-5);

    const openReplyBox = findVisibleElement([
      "div[role='textbox'][contenteditable='true']",
      "div[aria-label*='Message body'][contenteditable='true']"
    ]);

    return {
      provider: "outlook",
      subject,
      senders: senderCandidates,
      latestMessage: messageBodies[messageBodies.length - 1] || "",
      threadMessages: messageBodies,
      hasOpenReplyBox: !!openReplyBox
    };
  }

  function listOutlookInboxThreads() {
    ensureOutlook();

    const threadRows = getOutlookThreadRows();

    return {
      provider: "outlook",
      location: location.href,
      threads: threadRows
        .map((row, index) => describeOutlookThreadRow(row, index))
        .filter((thread) => thread.threadId && (thread.subject || thread.sender))
    };
  }

  function getPageSnapshot() {
    const root =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector("[role='main']") ||
      document.body;

    if (!root) {
      throw new Error("The page has no readable document body.");
    }

    return {
      title: document.title || "",
      url: location.href,
      language: document.documentElement.lang || "",
      metaDescription: document.querySelector("meta[name='description']")?.getAttribute("content")?.trim() || "",
      selection: `${window.getSelection?.()?.toString() || ""}`.trim().slice(0, 1500),
      headings: Array.from(root.querySelectorAll("h1, h2, h3")).map((element) => element.textContent?.trim() || "").filter(Boolean).slice(0, 12),
      paragraphs: Array.from(root.querySelectorAll("p")).map((element) => element.textContent?.trim() || "").filter(Boolean).slice(0, 8),
      visibleText: `${root.innerText || document.body?.innerText || ""}`.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 12000)
    };
  }

  async function waitForTarget(currentArgs) {
    const target = requireTarget(currentArgs.target);
    const timeoutMs = Math.max(100, Number(currentArgs.timeoutMs) || 3000);
    const pollMs = Math.max(50, Number(currentArgs.pollMs) || 150);
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const resolved = tryResolveTarget(target, { allowHidden: false });

      if (resolved) {
        return {
          found: true,
          elapsedMs: Date.now() - startedAt,
          target: describeElement(resolved.element)
        };
      }

      await delay(pollMs);
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for the requested element.`);
  }

  async function runObservedWrite(operation) {
    const beforeSnapshot = getPageSnapshot();
    const details = operation();
    await delay(250);

    return {
      details,
      beforeSnapshot,
      afterSnapshot: getPageSnapshot()
    };
  }

  function clickTarget(target) {
    const resolved = resolveTarget(target, { interactive: true });
    resolved.element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    resolved.element.click();

    return {
      matchedBy: resolved.matchedBy,
      target: describeElement(resolved.element)
    };
  }

  function setInputValue(target, currentArgs) {
    const resolved = resolveTarget(target, { formField: true });
    const element = resolved.element;
    const value = `${currentArgs.value ?? ""}`;
    const clearFirst = currentArgs.clearFirst !== false;

    focusElement(element);

    if (element instanceof HTMLElement && element.isContentEditable) {
      if (clearFirst) {
        element.textContent = "";
      }

      element.textContent = value;
    } else if ("value" in element) {
      if (clearFirst) {
        element.value = "";
      }

      element.value = value;
    } else {
      throw new Error("The resolved element does not accept text input.");
    }

    element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

    return {
      matchedBy: resolved.matchedBy,
      valueLength: value.length,
      target: describeElement(element)
    };
  }

  function pressKey(currentArgs) {
    const key = `${currentArgs.key || ""}`.trim();

    if (!key) {
      throw new Error("A keyboard key is required.");
    }

    const resolved = currentArgs.target ? resolveTarget(currentArgs.target, { allowHidden: false }) : null;
    const element = resolved?.element || document.activeElement || document.body;

    focusElement(element);

    const eventInit = {
      key,
      code: `${currentArgs.code || key}`,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    element.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    element.dispatchEvent(new KeyboardEvent("keyup", eventInit));

    return {
      key,
      matchedBy: resolved?.matchedBy || "activeElement",
      target: describeElement(element)
    };
  }

  function submitForm(target) {
    let form = null;
    let matchedBy = "activeElement";

    if (target) {
      const resolved = resolveTarget(target, { allowHidden: false, includeForms: true });
      matchedBy = resolved.matchedBy;
      form = resolved.element instanceof HTMLFormElement ? resolved.element : resolved.element.closest("form");
    } else if (document.activeElement instanceof HTMLElement) {
      form = document.activeElement.closest("form");
    }

    if (!form) {
      form = Array.from(document.querySelectorAll("form")).find((element) => isVisible(element));
      matchedBy = "firstVisibleForm";
    }

    if (!form) {
      throw new Error("No form could be resolved for submission.");
    }

    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.submit();
    }

    return {
      matchedBy,
      target: describeElement(form)
    };
  }

  function openGmailReplyBox() {
    ensureGmail();

    const replyButton = findGmailReplyButton();

    if (!replyButton) {
      throw new Error("No visible Gmail reply button was found.");
    }

    replyButton.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    clickLikeUser(replyButton);
    pressEnterLikeUser(replyButton);

    return {
      target: describeElement(replyButton)
    };
  }

  function findGmailReplyButton() {
    const labeledReplyButton = findVisibleElement([
      "div[role='button'][aria-label^='Reply']",
      "div[role='button'][aria-label*='Reply']",
      "div[role='button'][aria-label^='Avançar']",
      "div[role='button'][aria-label*='Avançar']",
      "span[role='link'][aria-label^='Reply']",
      "span[role='link'][aria-label*='Reply']",
      "span[role='link'][aria-label^='Avançar']",
      "span[role='link'][aria-label*='Avançar']",
      "span[role='button'][aria-label^='Reply']",
      "span[role='button'][aria-label*='Reply']",
      "span[role='button'][aria-label^='Avançar']",
      "span[role='button'][aria-label*='Avançar']",
      "button[aria-label^='Reply']",
      "button[aria-label*='Reply']",
      "button[aria-label^='Avançar']",
      "button[aria-label*='Avançar']",
      "div[role='button'][data-tooltip*='Reply']",
      "div[role='button'][data-tooltip*='Avançar']"
    ], (element) => {
      const label = normalizeText([
        element.getAttribute("aria-label"),
        element.getAttribute("data-tooltip"),
        element.getAttribute("title"),
        getContextText(element)
      ].filter(Boolean).join(" "));
      return label.includes("reply") || label.includes("avançar") || label.includes("avancar");
    });

    if (labeledReplyButton) {
      return labeledReplyButton;
    }

    const actionRows = Array.from(document.querySelectorAll(".amn"))
      .filter((element) => element instanceof HTMLElement && isVisible(element));

    for (let index = actionRows.length - 1; index >= 0; index -= 1) {
      const row = actionRows[index];
      const actions = Array.from(row.querySelectorAll("span[role='link'], span[role='button'], div[role='button'], button"))
        .filter((element) => element instanceof HTMLElement && isVisible(element));

      if (actions[0] instanceof HTMLElement) {
        return actions[0];
      }
    }

    return null;
  }

  function openGmailThread(currentArgs) {
    ensureGmail();

    const threadUrl = `${currentArgs.threadUrl || ""}`.trim();

    if (threadUrl) {
      location.href = threadUrl;
      return {
        openedBy: "threadUrl",
        threadUrl
      };
    }

    if (Number.isInteger(currentArgs.rowIndex)) {
      const threadRows = Array.from(document.querySelectorAll("tr[role='row'][jscontroller], tr.zA"))
        .filter((row) => row instanceof HTMLElement && isVisible(row));
      const row = threadRows[currentArgs.rowIndex];

      if (!(row instanceof HTMLElement)) {
        throw new Error(`No Gmail inbox row exists at index ${currentArgs.rowIndex}.`);
      }

      row.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      row.click();

      return {
        openedBy: "rowIndex",
        rowIndex: currentArgs.rowIndex,
        target: describeElement(row)
      };
    }

    if (currentArgs.target) {
      const clicked = clickTarget(currentArgs.target);
      return {
        openedBy: "target",
        ...clicked
      };
    }

    throw new Error("Opening a Gmail thread requires threadUrl, target, or rowIndex.");
  }

  function goToNextGmailInboxPage() {
    ensureGmail();

    const nextButton = findGmailPageButton("next");

    if (!nextButton) {
      throw new Error("No Gmail next-page button is available.");
    }

    if (isDisabledGmailPagerButton(nextButton)) {
      throw new Error("Gmail is already on the last visible inbox page.");
    }

    nextButton.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    clickLikeUser(nextButton);
    pressEnterLikeUser(nextButton);

    return {
      target: describeElement(nextButton)
    };
  }

  function returnToGmailInbox(currentArgs = {}) {
    ensureGmail();
    const unreadOnly = currentArgs.unreadOnly !== false;

    const hasInboxRows = Array.from(document.querySelectorAll("tr[role='row'][jscontroller], tr.zA"))
      .some((row) => row instanceof HTMLElement && isVisible(row));

    if (hasInboxRows && !isGmailThreadView() && (!unreadOnly || isGmailUnreadFilteredView())) {
      return {
        returnedBy: "alreadyOnInbox",
        location: location.href
      };
    }

    location.hash = unreadOnly
      ? "#advanced-search/is_unread=true&isrefinement=true"
      : "#inbox";
    return {
      returnedBy: "fallback",
      location: location.href
    };
  }

  function isGmailThreadView() {
    const hash = `${location.hash || ""}`.trim();

    if (/#.+\/.+/.test(hash) && !/^#(?:inbox|all|starred|important|sent|drafts|search|label|advanced-search)(?:$|[/?&])/i.test(hash)) {
      return true;
    }

    return !!findVisibleElement([
      "h2[data-thread-perm-id]",
      "h2.hP"
    ]);
  }

  function isGmailUnreadFilteredView() {
    const hash = decodeURIComponent(`${location.hash || ""}`).trim().toLowerCase();

    return (
      hash.startsWith("#advanced-search/is_unread=true") ||
      (hash.startsWith("#search/") && hash.includes("is:unread")) ||
      hash.startsWith("#label/unread")
    );
  }

  function fillGmailReplyBody(currentArgs) {
    ensureGmail();

    const body = `${currentArgs.body || currentArgs.value || ""}`;

    if (!body.trim()) {
      throw new Error("A reply body is required.");
    }

    const editor = findVisibleElement([
      "div[role='textbox'][g_editable='true']",
      "div[role='textbox'][aria-label*='Message Body']",
      "div[contenteditable='true'][aria-label*='Message Body']"
    ]);

    if (!editor) {
      throw new Error("No open Gmail reply editor was found.");
    }

    focusElement(editor);
    replaceEditorBodyWithParagraphs(editor, body);
    editor.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

    return {
      bodyLength: body.length,
      target: describeElement(editor)
    };
  }

  function sendGmailReply() {
    ensureGmail();

    const sendButton = findVisibleElement([
      "div[role='button'][data-tooltip^='Send']",
      "div[role='button'][data-tooltip^='Enviar']",
      "div[role='button'][aria-label^='Send']",
      "div[role='button'][aria-label*='Send']",
      "div[role='button'][aria-label^='Enviar']",
      "div[role='button'][aria-label*='Enviar']",
      "button[aria-label^='Send']",
      "button[aria-label*='Send']",
      "button[aria-label^='Enviar']",
      "button[aria-label*='Enviar']"
    ], (element) => {
      const label = normalizeText([
        element.getAttribute("aria-label"),
        element.getAttribute("data-tooltip"),
        element.getAttribute("title"),
        getContextText(element)
      ].filter(Boolean).join(" "));
      return label.includes("send") || label.includes("enviar");
    });

    if (!sendButton) {
      throw new Error("No visible Gmail send button was found.");
    }

    sendButton.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    clickLikeUser(sendButton);
    pressEnterLikeUser(sendButton);

    return {
      target: describeElement(sendButton)
    };
  }

  function findGmailPageButton(direction) {
    const patterns = direction === "next"
      ? ["older", "next page", "mais antigos", "próxima página", "proxima pagina", "older conversations"]
      : ["newer", "previous page", "mais recentes", "página anterior", "pagina anterior", "newer conversations"];

    const candidates = Array.from(document.querySelectorAll([
      "div[role='button'][aria-label]",
      "div[role='button'][data-tooltip]",
      "button[aria-label]",
      "button[title]"
    ].join(", ")))
      .filter((element) => element instanceof HTMLElement && isVisible(element));

    return candidates.find((element) => {
      const label = normalizeText([
        element.getAttribute("aria-label"),
        element.getAttribute("data-tooltip"),
        element.getAttribute("title"),
        getContextText(element)
      ].filter(Boolean).join(" "));

      return patterns.some((pattern) => label.includes(pattern));
    }) || null;
  }

  function isDisabledGmailPagerButton(element) {
    const ariaDisabled = `${element.getAttribute("aria-disabled") || ""}`.trim().toLowerCase();
    const disabledAttr = element.getAttribute("disabled");
    const tabIndex = `${element.getAttribute("tabindex") || ""}`.trim();
    const className = normalizeText(element.className);

    return (
      ariaDisabled === "true" ||
      disabledAttr !== null ||
      tabIndex === "-1" ||
      className.includes("disabled")
    );
  }

  function openOutlookReplyBox() {
    ensureOutlook();

    const replyButton = findOutlookReplyButton();

    if (!replyButton) {
      throw new Error("No visible Outlook reply button was found.");
    }

    replyButton.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    clickLikeUser(replyButton);
    pressEnterLikeUser(replyButton);

    return {
      target: describeElement(replyButton)
    };
  }

  function openOutlookThread(currentArgs) {
    ensureOutlook();

    const threadUrl = `${currentArgs.threadUrl || ""}`.trim();

    if (threadUrl) {
      location.href = threadUrl;
      return {
        openedBy: "threadUrl",
        threadUrl
      };
    }

    const matchedRow = findOutlookRowFromTarget(currentArgs.target);
    if (matchedRow) {
      return {
        openedBy: "targetMetadata",
        target: openOutlookRow(matchedRow, currentArgs.target)
      };
    }

    if (Number.isInteger(currentArgs.rowIndex)) {
      const threadRows = getOutlookThreadRows();
      const row = threadRows[currentArgs.rowIndex];

      if (!(row instanceof HTMLElement)) {
        throw new Error(`No Outlook inbox row exists at index ${currentArgs.rowIndex}.`);
      }

      return {
        openedBy: "rowIndex",
        rowIndex: currentArgs.rowIndex,
        target: openOutlookRow(row, currentArgs.target)
      };
    }

    if (currentArgs.target) {
      const clicked = clickTarget(currentArgs.target);
      return {
        openedBy: "target",
        ...clicked
      };
    }

    throw new Error("Opening an Outlook thread requires threadUrl, target, or rowIndex.");
  }

  function fillOutlookReplyBody(currentArgs) {
    ensureOutlook();

    const body = `${currentArgs.body || currentArgs.value || ""}`;

    if (!body.trim()) {
      throw new Error("A reply body is required.");
    }

    const editor = findVisibleElement([
      "div[role='textbox'][contenteditable='true']",
      "div[aria-label*='Message body'][contenteditable='true']"
    ]);

    if (!editor) {
      throw new Error("No open Outlook reply editor was found.");
    }

    focusElement(editor);
    replaceEditorBodyWithParagraphs(editor, body);
    editor.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

    return {
      bodyLength: body.length,
      target: describeElement(editor)
    };
  }

  function replaceEditorBodyWithParagraphs(editor, body) {
    const fragment = document.createDocumentFragment();
    const normalizedBody = `${body || ""}`.replace(/\r\n/g, "\n");
    const lines = normalizedBody.split("\n");

    lines.forEach((line) => {
      const block = document.createElement("div");

      if (line) {
        block.textContent = line;
      } else {
        block.appendChild(document.createElement("br"));
      }

      fragment.appendChild(block);
    });

    editor.replaceChildren(fragment);
  }

  function findOutlookReplyButton() {
    const readingPane = getOutlookReadingPaneRoot();
    const searchRoots = [readingPane, document.querySelector("[role='main']"), document.body]
      .filter((element, index, values) => element instanceof HTMLElement && values.indexOf(element) === index);

    for (const root of searchRoots) {
      const candidates = Array.from(root.querySelectorAll([
        "button[aria-label^='Reply']",
        "button[title^='Reply']",
        "div[role='button'][aria-label^='Reply']",
        "button[aria-label*='Reply']",
        "div[role='button'][aria-label*='Reply']"
      ].join(", ")))
        .filter((element) => element instanceof HTMLElement && isVisible(element))
        .filter((element) => normalizeText(getContextText(element)).includes("reply"))
        .filter((element) => !isOutlookShellControl(element));

      const toolbarScoped = candidates.find((element) => element.closest("[role='toolbar'], [aria-label*='Message actions'], [aria-label*='Mail toolbar']"));
      if (toolbarScoped) {
        return toolbarScoped;
      }

      if (candidates[0]) {
        return candidates[0];
      }
    }

    return null;
  }

  function getOutlookReadingPaneRoot() {
    const body = findVisibleElement([
      "div[role='document']",
      "div[aria-label*='Message body']",
      "div[data-app-section='MailReadCompose'] div[dir='ltr']",
      "div[dir='auto']"
    ]);
    const subject = findVisibleElement([
      "h1[title]",
      "div[role='heading'][aria-level='1']",
      "h1",
      "h2"
    ]);
    const seed = body || subject;

    if (!(seed instanceof HTMLElement)) {
      return null;
    }

    return (
      seed.closest("[data-app-section='MailReadCompose']") ||
      seed.closest("[aria-label*='Reading pane']") ||
      seed.closest("[role='main']") ||
      seed.parentElement
    );
  }

  function isOutlookShellControl(element) {
    return !!element.closest([
      "header",
      "nav",
      "[role='navigation']",
      "[aria-label*='Account']",
      "[aria-label*='Profile']",
      "[aria-label*='Sign in']",
      "[data-test-id*='account']",
      "[data-testid*='account']"
    ].join(", "));
  }

  function openOutlookRow(row, target) {
    row.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    const clickable = getOutlookOpenTrigger(row, target);

    focusElement(row);
    focusElement(clickable);
    clickLikeUser(clickable);
    doubleClickLikeUser(clickable);
    pressEnterLikeUser(clickable);
    pressEnterLikeUser(row);

    return describeElement(row);
  }

  function resolveTarget(target, options = {}) {
    const resolved = tryResolveTarget(requireTarget(target), options);

    if (!resolved) {
      throw new Error(`No element matched target: ${JSON.stringify(target)}`);
    }

    return resolved;
  }

  function tryResolveTarget(target, options = {}) {
    if (target.selector) {
      try {
        const bySelector = document.querySelector(`${target.selector}`);
        if (bySelector instanceof HTMLElement && matchesVisibility(bySelector, options)) {
          return { element: bySelector, matchedBy: "selector" };
        }
      } catch {
        // Ignore invalid selectors and continue with other target hints.
      }
    }

    if (target.id) {
      const byId = document.getElementById(`${target.id}`);
      if (byId instanceof HTMLElement && matchesVisibility(byId, options)) {
        return { element: byId, matchedBy: "id" };
      }
    }

    const candidates = getCandidateElements(options)
      .filter((element) => !target.tag || element.tagName.toLowerCase() === `${target.tag}`.toLowerCase())
      .filter((element) => !target.role || `${element.getAttribute("role") || ""}`.toLowerCase() === `${target.role}`.toLowerCase())
      .filter((element) => !target.name || `${element.getAttribute("name") || ""}`.toLowerCase() === `${target.name}`.toLowerCase())
      .filter((element) => !target.dataConvid || `${element.getAttribute("data-convid") || ""}` === `${target.dataConvid}`)
      .filter((element) => !target.dataItemId || `${element.getAttribute("data-item-id") || ""}` === `${target.dataItemId}`)
      .filter((element) => !target.ariaLabel || normalizeText(element.getAttribute("aria-label")).includes(normalizeText(target.ariaLabel)))
      .filter((element) => !target.placeholder || normalizeText(element.getAttribute("placeholder")).includes(normalizeText(target.placeholder)))
      .filter((element) => !target.label || matchesFieldLabel(element, target.label, target.exact))
      .filter((element) => !target.text || matchesText(element, target.text, target.exact));

    const index = Number.isInteger(target.index) ? target.index : 0;
    const byDescriptor = candidates[index];

    if (!byDescriptor) {
      return null;
    }

    if (target.selector && !safeMatchesSelector(byDescriptor, target.selector)) {
      return null;
    }

    return { element: byDescriptor, matchedBy: pickMatchedBy(target) };
  }

  function queryVisible(selector) {
    return Array.from(document.querySelectorAll(selector))
      .filter((element) => element instanceof HTMLElement && isVisible(element))
      .slice(0, 30);
  }

  function findVisibleElement(selectors, predicate) {
    for (const selector of selectors) {
      const match = Array.from(document.querySelectorAll(selector))
        .find((element) => element instanceof HTMLElement && isVisible(element) && (!predicate || predicate(element)));

      if (match instanceof HTMLElement) {
        return match;
      }
    }

    return null;
  }

  function getCandidateElements(options) {
    const selector = options.formField
      ? FORM_FIELD_SELECTOR
      : options.interactive
        ? INTERACTIVE_SELECTOR
        : options.includeForms
          ? `${INTERACTIVE_SELECTOR}, form`
          : "*";

    return Array.from(document.querySelectorAll(selector))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => matchesVisibility(element, options))
      .slice(0, 200);
  }

  function requireTarget(target) {
    if (!target || typeof target !== "object") {
      throw new Error("This action requires a target object.");
    }

    return target;
  }

  function matchesVisibility(element, options) {
    return options.allowHidden ? true : isVisible(element);
  }

  function matchesText(element, text, exact) {
    const haystack = normalizeText(getText(element));
    const needle = normalizeText(text);
    return exact ? haystack === needle : haystack.includes(needle);
  }

  function matchesFieldLabel(element, label, exact) {
    const haystack = normalizeText(getFieldLabel(element));
    const needle = normalizeText(label);

    if (!needle) {
      return true;
    }

    return exact ? haystack === needle : haystack.includes(needle);
  }

  function pickMatchedBy(target) {
    if (target.selector) return "selector";
    if (target.id) return "id";
    if (target.dataConvid) return "dataConvid";
    if (target.dataItemId) return "dataItemId";
    if (target.label) return "label";
    if (target.name) return "name";
    if (target.ariaLabel) return "ariaLabel";
    if (target.placeholder) return "placeholder";
    if (target.text) return "text";
    return "target";
  }

  function describeInteractive(element) {
    return {
      tag: element.tagName.toLowerCase(),
      text: getText(element),
      contextText: getContextText(element),
      ariaLabel: element.getAttribute("aria-label") || "",
      id: element.id || "",
      name: element.getAttribute("name") || "",
      type: element.getAttribute("type") || "",
      role: element.getAttribute("role") || "",
      selector: buildSelector(element),
      target: buildTargetDescriptor(element)
    };
  }

  function describeField(element) {
    return {
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || "",
      name: element.getAttribute("name") || "",
      id: element.id || "",
      placeholder: element.getAttribute("placeholder") || "",
      label: getFieldLabel(element),
      valuePreview: element instanceof HTMLElement && element.isContentEditable ? getText(element).slice(0, 80) : `${element.value || ""}`.slice(0, 80),
      selector: buildSelector(element),
      target: buildTargetDescriptor(element)
    };
  }

  function describeElement(element) {
    return {
      tag: element.tagName.toLowerCase(),
      text: getText(element),
      label: getFieldLabel(element),
      id: element.id || "",
      name: element.getAttribute("name") || "",
      selector: buildSelector(element),
      target: buildTargetDescriptor(element)
    };
  }

  function buildTargetDescriptor(element) {
    return {
      selector: buildSelector(element),
      id: element.id || undefined,
      label: getFieldLabel(element) || undefined,
      name: element.getAttribute("name") || undefined,
      text: getText(element) || undefined,
      contextText: getContextText(element) || undefined,
      ariaLabel: element.getAttribute("aria-label") || undefined,
      placeholder: element.getAttribute("placeholder") || undefined,
      tag: element.tagName.toLowerCase()
    };
  }

  function describeGmailThreadRow(row, index) {
    const senderElement = row.querySelector("span[email], .gD[email]");
    const subject =
      row.querySelector("span.bog")?.textContent?.trim() ||
      row.querySelector("span[data-thread-id]")?.textContent?.trim() ||
      "";
    const sender =
      senderElement?.textContent?.trim() ||
      row.querySelector("span.yP, span.yW span")?.textContent?.trim() ||
      "";
    const senderEmail = senderElement?.getAttribute("email") || "";
    const preview =
      row.querySelector("span.y2")?.textContent?.trim() ||
      row.querySelector("span.y2, span.zF")?.textContent?.trim() ||
      "";
    const link = findGmailThreadHref(row);
    const threadUrl = link ? new URL(link, location.origin).toString() : "";
    const threadId =
      row.getAttribute("data-legacy-thread-id") ||
      row.getAttribute("data-thread-id") ||
      link ||
      `${sender}|${subject}`;
    const unread = isGmailUnreadFilteredView() || hasGmailUnreadMarker(row);
    const replied = hasGmailReplyMarker(row);

    return {
      threadId,
      subject,
      sender,
      senderEmail,
      preview,
      threadUrl,
      unread,
      replied,
      rowIndex: index,
      target: {
        selector: buildSelector(row),
        text: subject || undefined,
        contextText: `${sender} ${subject} ${preview}`.trim() || undefined,
        tag: row.tagName.toLowerCase()
      }
    };
  }

  function hasGmailReplyMarker(row) {
    const labelText = [
      row.getAttribute("aria-label"),
      ...Array.from(row.querySelectorAll("[aria-label], [title], img[alt], [data-tooltip]"))
        .map((element) =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("alt"),
            element.getAttribute("data-tooltip"),
            element.textContent
          ].filter(Boolean).join(" ")
        )
    ].join(" ");

    const normalized = normalizeText(labelText);

    return [
      "replied",
      "answered",
      "responded",
      "respondida",
      "respondido",
      "respondidas",
      "respondidos"
    ].some((marker) => normalized.includes(marker));
  }

  function hasGmailUnreadMarker(row) {
    const rowLabel = normalizeText([
      row.getAttribute("aria-label"),
      row.getAttribute("title"),
      ...Array.from(row.querySelectorAll("[aria-label], [title], [data-tooltip], [data-tooltip-delay]"))
        .map((element) =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-tooltip"),
            element.getAttribute("alt")
          ].filter(Boolean).join(" ")
        )
    ].join(" "));

    if (row.classList.contains("zE")) {
      return true;
    }

    return [
      "unread",
      "nao lida",
      "nao lido",
      "não lida",
      "não lido",
      "não lidas",
      "unread conversations"
    ].some((marker) => rowLabel.includes(marker));
  }

  function describeOutlookThreadRow(row, index) {
    const subject =
      row.querySelector("[title][role='heading']")?.textContent?.trim() ||
      row.querySelector("span[title], div[title]")?.getAttribute("title")?.trim() ||
      row.querySelector("span, div")?.textContent?.trim() ||
      "";
    const sender =
      row.querySelector("[title][aria-label*='From']")?.getAttribute("title")?.trim() ||
      row.querySelector("[data-testid='message-sender'], [aria-label*='From']")?.textContent?.trim() ||
      "";
    const preview =
      row.querySelector("[aria-label*='Preview'], [title][aria-label*='Preview']")?.textContent?.trim() ||
      row.querySelector("span[title], div[title]")?.textContent?.trim() ||
      "";
    const link = findOutlookThreadHref(row);
    const threadUrl = link ? new URL(link, location.origin).toString() : "";
    const threadId =
      row.getAttribute("data-convid") ||
      row.getAttribute("data-item-id") ||
      link ||
      `${sender}|${subject}`;

    return {
      threadId,
      subject,
      sender,
      preview,
      threadUrl,
      unread: normalizeText(row.getAttribute("aria-label")).includes("unread") || normalizeText(row.className).includes("unread"),
      rowIndex: index,
      target: {
        selector: buildSelector(row),
        dataConvid: row.getAttribute("data-convid") || undefined,
        dataItemId: row.getAttribute("data-item-id") || undefined,
        openSelector: buildSelector(getOutlookOpenTrigger(row)) || undefined,
        text: subject || undefined,
        contextText: `${sender} ${subject} ${preview}`.trim() || undefined,
        tag: row.tagName.toLowerCase()
      }
    };
  }

  function findGmailThreadHref(row) {
    const anchors = Array.from(row.querySelectorAll("a[href]"));
    const preferred = anchors.find((anchor) => {
      const href = `${anchor.getAttribute("href") || ""}`.trim();
      return /#.+\/.+/.test(href) && !/#(?:inbox|all|starred|important|sent|drafts)$/.test(href);
    });

    if (preferred) {
      return `${preferred.getAttribute("href") || ""}`.trim();
    }

    const fallback = anchors.find((anchor) => {
      const href = `${anchor.getAttribute("href") || ""}`.trim();
      return href.includes("#") && href !== "#";
    });

    return `${fallback?.getAttribute("href") || ""}`.trim();
  }

  function findOutlookThreadHref(row) {
    const anchors = Array.from(row.querySelectorAll("a[href]"));
    const preferred = anchors.find((anchor) => {
      const href = `${anchor.getAttribute("href") || ""}`.trim();
      return /\/mail\/id\//.test(href) || /[?&](ItemID|id|conversationid)=/i.test(href);
    });

    if (preferred) {
      return `${preferred.getAttribute("href") || ""}`.trim();
    }

    return "";
  }

  function getOutlookThreadRows() {
    return Array.from(document.querySelectorAll("div[role='option'][data-convid], div[role='option'][data-item-id], div[data-convid], div[data-item-id]"))
      .filter((row) => row instanceof HTMLElement && isVisible(row))
      .filter((row) => hasOutlookThreadSignals(row))
      .slice(0, 40);
  }

  function hasOutlookThreadSignals(row) {
    if (row.getAttribute("data-convid") || row.getAttribute("data-item-id")) {
      return true;
    }

    const aria = normalizeText(row.getAttribute("aria-label"));
    if (aria.includes("unread") || aria.includes("message")) {
      return true;
    }

    return !!findOutlookThreadHref(row);
  }

  function findOutlookRowFromTarget(target) {
    if (!target || typeof target !== "object") {
      return null;
    }

    const rows = getOutlookThreadRows();

    if (target.dataConvid) {
      const byConversation = rows.find((row) => `${row.getAttribute("data-convid") || ""}` === `${target.dataConvid}`);
      if (byConversation) {
        return byConversation;
      }
    }

    if (target.dataItemId) {
      const byItemId = rows.find((row) => `${row.getAttribute("data-item-id") || ""}` === `${target.dataItemId}`);
      if (byItemId) {
        return byItemId;
      }
    }

    return null;
  }

  function getOutlookOpenTrigger(row, target) {
    const preferredSelectors = [
      "a[href*='/mail/id/']",
      "a[href*='ItemID=']",
      "a[href*='conversationid=']",
      "[role='heading'][title]",
      "span[role='heading'][title]",
      "div[role='heading'][title]",
      "span[title]",
      "div[title]",
      "a[href]",
      "button",
      "div[role='link']"
    ];
    const candidates = preferredSelectors
      .flatMap((selector) => Array.from(row.querySelectorAll(selector)))
      .filter((element, index, values) => element instanceof HTMLElement && isVisible(element) && values.indexOf(element) === index);
    const subjectNeedle = normalizeText(target?.text || "");
    const contextNeedle = normalizeText(target?.contextText || "");
    const selectorNeedle = `${target?.openSelector || ""}`.trim();

    if (selectorNeedle) {
      try {
        const exact = row.querySelector(selectorNeedle);
        if (exact instanceof HTMLElement && isVisible(exact)) {
          return exact;
        }
      } catch {
        // Ignore invalid stored selector.
      }
    }

    if (subjectNeedle) {
      const bySubject = candidates.find((element) => {
        const text = normalizeText(getText(element));
        const title = normalizeText(element.getAttribute("title"));
        return text.includes(subjectNeedle) || title.includes(subjectNeedle);
      });

      if (bySubject) {
        return bySubject;
      }
    }

    if (contextNeedle) {
      const byContext = candidates.find((element) => {
        const text = normalizeText(getContextText(element));
        return text.includes(subjectNeedle || contextNeedle);
      });

      if (byContext) {
        return byContext;
      }
    }

    return candidates[0] || row;
  }

  function clickLikeUser(element) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true }));
    element.click();
  }

  function doubleClickLikeUser(element) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true }));
  }

  function pressEnterLikeUser(element) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    focusElement(element);
    const eventInit = {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      composed: true
    };
    element.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    element.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    element.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function focusElement(element) {
    if (element instanceof HTMLElement && typeof element.focus === "function") {
      element.focus();
    }
  }

  function getText(element) {
    return `${element.innerText || element.textContent || ""}`.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function getContextText(element) {
    const current = getText(element);

    if (current) {
      return current;
    }

    const ariaLabel = `${element.getAttribute("aria-label") || ""}`.trim();
    if (ariaLabel) {
      return ariaLabel.slice(0, 120);
    }

    const container = element.closest("label, button, a, [role='button'], div, section, li");
    const containerText = `${container?.innerText || container?.textContent || ""}`.replace(/\s+/g, " ").trim();

    if (containerText) {
      return containerText.slice(0, 120);
    }

    const parentText = `${element.parentElement?.innerText || element.parentElement?.textContent || ""}`.replace(/\s+/g, " ").trim();
    return parentText.slice(0, 120);
  }

  function getFieldLabel(element) {
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) {
        return getText(label);
      }
    }

    return getText(element.closest("label") || { textContent: "" });
  }

  function buildSelector(element) {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      let part = current.tagName.toLowerCase();

      if (current.classList.length > 0) {
        part += `.${Array.from(current.classList).slice(0, 2).join(".")}`;
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function normalizeText(value) {
    return `${value || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function safeMatchesSelector(element, selector) {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
}

function injectAgentPanel(actions) {
  function escapeHtml(value) {
    return `${value || ""}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const panelId = "chrome-extension-agent-panel";
  document.getElementById(panelId)?.remove();

  const panel = document.createElement("aside");
  panel.id = panelId;
  Object.assign(panel.style, {
    position: "fixed",
    top: "20px",
    left: "20px",
    width: "340px",
    maxHeight: "72vh",
    overflow: "auto",
    padding: "16px",
    borderRadius: "16px",
    background: "rgba(15, 23, 42, 0.96)",
    color: "#e2e8f0",
    fontFamily: "Arial, sans-serif",
    fontSize: "13px",
    lineHeight: "1.5",
    boxShadow: "0 18px 48px rgba(15, 23, 42, 0.35)",
    zIndex: "2147483647"
  });

  panel.innerHTML = `<h2 style="margin:0 0 8px;font-size:18px;color:#f8fafc">Agent Actions</h2><p style="margin:0 0 12px;color:#cbd5e1">Use target descriptors instead of relying only on raw CSS selectors. Write actions return before/after page snapshots.</p>`;

  actions.forEach((action) => {
    const item = document.createElement("div");
    Object.assign(item.style, {
      marginBottom: "10px",
      padding: "10px",
      borderRadius: "12px",
      background: "rgba(30, 41, 59, 0.85)"
    });
    item.innerHTML = `<div style="font-weight:700;margin-bottom:4px;color:#f8fafc">${action.label} [${action.risk}]</div><div style="color:#cbd5e1;margin-bottom:6px">${action.description}</div><pre style="margin:0;white-space:pre-wrap;color:#93c5fd;font-size:11px">${escapeHtml(JSON.stringify(action.exampleArgs, null, 2))}</pre>`;
    panel.appendChild(item);
  });

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  Object.assign(closeButton.style, {
    marginTop: "8px",
    border: "0",
    borderRadius: "999px",
    padding: "8px 12px",
    background: "#38bdf8",
    color: "#082f49",
    fontWeight: "700",
    cursor: "pointer"
  });
  closeButton.addEventListener("click", () => panel.remove());
  panel.appendChild(closeButton);
  document.body.appendChild(panel);
}

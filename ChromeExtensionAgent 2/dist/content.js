(function () {
  const SEND_PATTERNS = [/\bsend\b/i, /\benviar\b/i];
  const SENT_PATTERNS = [/\bmessage sent\b/i, /\bmensagem enviada\b/i, /\benviado\b/i];
  const REPLY_EDITOR_SELECTORS = [
    "div[role='textbox'][g_editable='true']",
    "div[role='textbox'][aria-label*='Message Body']",
    "div[contenteditable='true'][aria-label*='Message Body']"
  ];
  let pendingSignalTimer = 0;
  let pendingSendAttemptAt = 0;
  let lastSignalAt = 0;

  document.addEventListener("click", handleClickCapture, true);
  document.addEventListener("keydown", handleKeydownCapture, true);
  observeGmailSendFeedback();

  function handleClickCapture(event) {
    const trigger = event.target instanceof Element
      ? event.target.closest("button, div[role='button']")
      : null;

    if (!(trigger instanceof HTMLElement) || !looksLikeSendTrigger(trigger)) {
      return;
    }

    scheduleReviewSendSignal("click");
  }

  function handleKeydownCapture(event) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
      return;
    }

    if (!hasVisibleReplyEditor()) {
      return;
    }

    scheduleReviewSendSignal("shortcut");
  }

  function scheduleReviewSendSignal(source) {
    if (!hasVisibleReplyEditor()) {
      return;
    }

    if (Date.now() - lastSignalAt < 1200) {
      return;
    }

    pendingSendAttemptAt = Date.now();
    window.clearTimeout(pendingSignalTimer);
    pendingSignalTimer = window.setTimeout(() => {
      dispatchReviewSendSignal(source, "fallback");
    }, 3200);
  }

  function looksLikeSendTrigger(element) {
    if (!hasVisibleReplyEditor()) {
      return false;
    }

    const label = [
      element.getAttribute("aria-label"),
      element.getAttribute("data-tooltip"),
      element.getAttribute("title"),
      element.textContent
    ].filter(Boolean).join(" ");

    return SEND_PATTERNS.some((pattern) => pattern.test(label));
  }

  function hasVisibleReplyEditor() {
    return !!findVisibleReplyEditor();
  }

  function findVisibleReplyEditor() {
    for (const selector of REPLY_EDITOR_SELECTORS) {
      const element = Array.from(document.querySelectorAll(selector))
        .find((candidate) => candidate instanceof HTMLElement && isVisible(candidate));

      if (element instanceof HTMLElement) {
        return element;
      }
    }

    return null;
  }

  function getCurrentThreadSubject() {
    return (
      document.querySelector("h2[data-thread-perm-id]")?.textContent?.trim() ||
      document.querySelector("h2.hP")?.textContent?.trim() ||
      document.querySelector("h2")?.textContent?.trim() ||
      ""
    );
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function observeGmailSendFeedback() {
    const observer = new MutationObserver(() => {
      if (!pendingSendAttemptAt) {
        return;
      }

      if (findSentToast()) {
        dispatchReviewSendSignal("toast", "confirmed");
        return;
      }

      if (!hasVisibleReplyEditor() && Date.now() - pendingSendAttemptAt > 500) {
        dispatchReviewSendSignal("editor-closed", "confirmed");
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function findSentToast() {
    const candidates = Array.from(document.querySelectorAll("[role='alert'], [aria-live='assertive'], [aria-live='polite'], div"));

    return candidates.find((element) => {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        return false;
      }

      const text = `${element.textContent || ""}`.trim();
      return text && SENT_PATTERNS.some((pattern) => pattern.test(text));
    }) || null;
  }

  function dispatchReviewSendSignal(source, confidence) {
    if (!pendingSendAttemptAt) {
      return;
    }

    const now = Date.now();

    if (now - lastSignalAt < 1200) {
      return;
    }

    pendingSendAttemptAt = 0;
    lastSignalAt = now;
    window.clearTimeout(pendingSignalTimer);
    chrome.runtime.sendMessage({
      type: "gmail:review-send-triggered",
      payload: {
        source,
        confidence,
        url: location.href,
        subject: getCurrentThreadSubject()
      }
    }).catch(() => {
      // Ignore send-detection handoff failures.
    });
  }
})();

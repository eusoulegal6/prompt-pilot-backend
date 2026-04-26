export const EMAIL_PROVIDERS = {
  gmail: {
    id: "gmail",
    label: "Gmail",
    hosts: ["mail.google.com"],
    hostPermissions: ["https://mail.google.com/*"],
    inboxUrl: "https://mail.google.com/mail/u/0/#advanced-search/is_unread=true&isrefinement=true",
    plannerGuidance: "Prefer Gmail-specific reply actions for drafting replies. Default to draft/open-reply/fill-reply flows, not send."
  },
  outlook: {
    id: "outlook",
    label: "Outlook",
    hosts: ["outlook.office.com", "outlook.office365.com", "outlook.live.com"],
    hostPermissions: [
      "https://outlook.office.com/*",
      "https://outlook.office365.com/*",
      "https://outlook.live.com/*"
    ],
    inboxUrl: "https://outlook.office.com/mail/",
    plannerGuidance: "Prefer Outlook-specific reply actions for drafting replies. Default to open-thread/open-reply/fill-reply flows, not send."
  }
};

export function detectEmailProviderFromUrl(url) {
  try {
    const hostname = new URL(url).hostname;

    for (const provider of Object.values(EMAIL_PROVIDERS)) {
      if (provider.hosts.includes(hostname)) {
        return provider;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function getEmailProvider(providerId) {
  return EMAIL_PROVIDERS[providerId] || null;
}

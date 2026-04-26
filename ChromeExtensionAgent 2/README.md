# Gmail Auto Reply

Chrome extension that watches Gmail, drafts replies with the A.I., and can either wait for approval or send replies automatically.

## Build

```bash
npm run build
```

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `dist` folder in this project.

## Setup

1. Open the extension settings after loading it.
2. Optionally add identity, tone, signature, and sender filters.
3. Open Gmail and click the extension icon to start reviewing or auto-sending replies.

Replies use the built-in backend, so the person using the extension does not need their own A.I. provider API key.

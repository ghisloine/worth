const DEFAULTS = {
  apiBaseUrl: 'http://127.0.0.1:3000'
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => existing[key] === undefined)
  );

  if (Object.keys(missing).length) {
    await chrome.storage.sync.set(missing);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'compareItems') return;

  (async () => {
    try {
      const { apiBaseUrl } = await chrome.storage.sync.get(['apiBaseUrl']);
      const response = await fetch(`${apiBaseUrl || DEFAULTS.apiBaseUrl}/api/compare-live`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: message.itemIds || [] })
      });

      const data = await response.json();
      if (!response.ok) {
        sendResponse({ ok: false, error: data.error || 'Compare failed' });
        return;
      }

      sendResponse({ ok: true, data });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});

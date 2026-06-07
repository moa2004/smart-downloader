const MEDIA_URL = /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|wav|ogg|flac|m3u8|mpd)(\?|#|$)/i;
const MEDIA_TYPE = /(video|audio|mpegurl|dash\+xml|mpd|octet-stream|binary)/i;
const SUSPECT_MEDIA_URL = /(googlevideo\.com|videoplayback|\/video\/|\/media\/|\/stream|\/playback|range=|itag=|mime=video|mime=audio)/i;
const MAX_ITEMS = 80;

const tabItems = new Map();
const requestHeaders = new Map();

function normalizeHeaders(headers = []) {
  const allowed = new Set(["referer", "origin", "user-agent", "accept", "accept-language", "cookie"]);
  const out = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (allowed.has(name) && header.value) out[name] = header.value;
  }
  return out;
}

function remember(tabId, item) {
  if (tabId < 0) return;
  const list = tabItems.get(tabId) || [];
  const existing = list.find((entry) => entry.url === item.url);
  if (existing) {
    Object.assign(existing, item, { seenAt: Date.now() });
  } else {
    list.unshift({ ...item, seenAt: Date.now() });
  }
  tabItems.set(tabId, list.slice(0, MAX_ITEMS));
}

function shouldCapture(details, contentType = "") {
  return (
    details.type === "media" ||
    MEDIA_URL.test(details.url) ||
    SUSPECT_MEDIA_URL.test(details.url) ||
    MEDIA_TYPE.test(contentType)
  );
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = normalizeHeaders(details.requestHeaders);
    requestHeaders.set(details.requestId, headers);
    if (shouldCapture(details)) {
      remember(details.tabId, {
        url: details.url,
        type: details.type || "request",
        method: details.method,
        statusCode: "pending",
        headers
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const contentType = (details.responseHeaders || []).find((header) => header.name.toLowerCase() === "content-type")?.value || "";
    if (!shouldCapture(details, contentType)) return;

    remember(details.tabId, {
      url: details.url,
      type: contentType || "media",
      method: details.method,
      statusCode: details.statusCode,
      headers: requestHeaders.get(details.requestId) || {}
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

async function scanActivePage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const urls = new Set();
      const suspect = /(googlevideo\.com|videoplayback|\.mp4|\.webm|\.m3u8|\.mpd|mime=video|mime=audio|\/video\/|\/media\/|\/stream|\/playback)/i;

      for (const entry of performance.getEntriesByType("resource")) {
        if (entry?.name && suspect.test(entry.name)) urls.add(entry.name);
      }

      for (const media of document.querySelectorAll("video, audio, source")) {
        for (const attr of ["src", "currentSrc"]) {
          const value = media[attr] || media.getAttribute?.(attr);
          if (value) urls.add(value);
        }
      }

      for (const script of document.scripts) {
        const text = script.textContent || "";
        for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+(?:videoplayback|googlevideo|\.mp4|\.webm|\.m3u8|\.mpd)[^\s"'<>\\]*/gi)) {
          urls.add(match[0]);
        }
      }

      return [...urls].filter((url) => !url.startsWith("blob:"));
    }
  });

  const urls = results?.[0]?.result || [];
  for (const url of urls) {
    remember(tabId, {
      url,
      type: "page-scan",
      method: "GET",
      statusCode: "seen",
      headers: {}
    });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabItems.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "get-items") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      sendResponse({ tabId: tab?.id, items: tab ? tabItems.get(tab.id) || [] : [] });
    });
    return true;
  }

  if (message.type === "scan-active-page") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (tab?.id) await scanActivePage(tab.id).catch(() => {});
      sendResponse({ ok: true, tabId: tab?.id, items: tab?.id ? tabItems.get(tab.id) || [] : [] });
    });
    return true;
  }

  if (message.type === "clear-items") {
    tabItems.delete(message.tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "browser-download") {
    chrome.downloads.download({ url: message.url, saveAs: true }, (downloadId) => {
      sendResponse({ ok: Boolean(downloadId), downloadId, error: chrome.runtime.lastError?.message });
    });
    return true;
  }
});

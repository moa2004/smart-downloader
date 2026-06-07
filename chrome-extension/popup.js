const itemsEl = document.querySelector("#items");
const statusEl = document.querySelector("#status");
const fileNameEl = document.querySelector("#fileName");
const appUrlEl = document.querySelector("#appUrl");
let activeTabId = null;
let currentItems = [];
let appBaseUrl = "http://localhost:5177";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortType(item) {
  if (/workspacevideo|\/drive\/media\/.+\/playback/i.test(item.url) && !/[?&](mime|itag)=/i.test(item.url)) return "Opaque playback API";
  if (/[?&]mime=video/i.test(item.url)) return "Video stream";
  if (/[?&]mime=audio/i.test(item.url)) return "Audio stream";
  if (/[?&]itag=(133|134|135|136|137|160|242|243|244|247|248|271|313|315)\b/i.test(item.url)) return "Video stream";
  if (/[?&]itag=(139|140|141|249|250|251)\b/i.test(item.url)) return "Audio stream";
  if (/m3u8/i.test(item.url)) return "HLS";
  if (/\.mpd/i.test(item.url)) return "DASH";
  if (/video/i.test(item.type)) return "Video";
  if (/audio/i.test(item.type)) return "Audio";
  return item.type || "Media";
}

function itemScore(item) {
  const type = shortType(item);
  if (type === "Video stream") return 100;
  if (type === "Audio stream") return 80;
  if (/googlevideo\.com|videoplayback/i.test(item.url)) return 60;
  if (type === "HLS" || type === "DASH") return 50;
  if (type === "Opaque playback API") return -50;
  return 0;
}

function setStatus(message = "") {
  statusEl.textContent = message;
  statusEl.classList.toggle("show", Boolean(message));
}

function appEndpoint(path) {
  return `${appBaseUrl.replace(/\/+$/, "")}${path}`;
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    if (/googlevideo\.com|workspacevideo|videoplayback|\/drive\/media\/|\/playback/i.test(url.href)) {
      url.searchParams.delete("range");
      url.searchParams.delete("rn");
      url.searchParams.delete("rbuf");
      url.searchParams.delete("ump");
      url.searchParams.delete("srfvp");
      url.searchParams.delete("alr");
      url.searchParams.delete("cpn");
    }
    return url.href;
  } catch {
    return value;
  }
}

async function sendToApp(item) {
  const response = await fetch(appEndpoint("/api/extension-candidate"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: normalizedUrl(item.url), headers: item.headers || {}, fileName: fileNameEl.value.trim() })
  });
  const data = await parseAppResponse(response);
  if (!response.ok) throw new Error(data.error || data.reason || "Local app rejected the link.");
  chrome.tabs.create({ url: `${appBaseUrl.replace(/\/+$/, "")}/?job=${encodeURIComponent(data.id)}` });
}

async function sendAllToApp(items) {
  const unique = [...new Map(items.map((item) => [normalizedUrl(item.url), { url: normalizedUrl(item.url), headers: item.headers || {} }])).values()];
  const response = await fetch(appEndpoint("/api/extension-candidates"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidates: unique, fileName: fileNameEl.value.trim() })
  });
  const data = await parseAppResponse(response);
  if (!response.ok) throw new Error(data.error || data.reason || "Local app rejected the links.");
  chrome.tabs.create({ url: `${appBaseUrl.replace(/\/+$/, "")}/?job=${encodeURIComponent(data.id)}` });
}

async function parseAppResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || `HTTP ${response.status}` };
  }
}

function render(items) {
  items = [...items].sort((a, b) => itemScore(b) - itemScore(a));
  currentItems = items;
  if (!items.length) {
    itemsEl.innerHTML = `<div class="item"><div class="url">No media links captured yet. Start playback, then refresh.</div></div>`;
    return;
  }

  const hasActionable = items.some((item) => shortType(item) !== "Opaque playback API");
  setStatus(hasActionable ? "" : "Only opaque playback API links captured. Keep video playing, seek forward, then refresh until Video stream or Audio stream appears.");

  itemsEl.innerHTML = items.map((item, index) => `
    <article class="item">
      <div class="url">${escapeHtml(item.url)}</div>
      <div class="meta">${escapeHtml(shortType(item))} - HTTP ${escapeHtml(item.statusCode || "n/a")}</div>
      <div class="actions">
        <button data-action="browser" data-index="${index}" type="button">Browser download</button>
        <button data-action="app" data-index="${index}" type="button">Send to app</button>
      </div>
    </article>
  `).join("");

  for (const button of itemsEl.querySelectorAll("button")) {
    button.addEventListener("click", async () => {
      const item = items[Number(button.dataset.index)];
      button.textContent = "Working...";
      button.disabled = true;
      try {
        if (button.dataset.action === "browser") {
          await chrome.runtime.sendMessage({ type: "browser-download", url: item.url });
        } else {
          await sendToApp(item);
        }
        button.textContent = "Done";
      } catch (error) {
        button.textContent = "Failed";
        setStatus(error.message);
        console.error(error);
      }
    });
  }
}

async function load() {
  await chrome.runtime.sendMessage({ type: "scan-active-page" }).catch(() => null);
  const response = await chrome.runtime.sendMessage({ type: "get-items" });
  activeTabId = response.tabId;
  render(response.items || []);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get({ appBaseUrl });
  appBaseUrl = stored.appBaseUrl || appBaseUrl;
  appUrlEl.value = appBaseUrl;
}

appUrlEl.addEventListener("change", async () => {
  appBaseUrl = appUrlEl.value.trim() || "http://localhost:5177";
  await chrome.storage.local.set({ appBaseUrl });
  setStatus("App address saved.");
});

document.querySelector("#refresh").addEventListener("click", load);
document.querySelector("#openApp").addEventListener("click", () => {
  chrome.tabs.create({ url: appBaseUrl });
});
document.querySelector("#sendAll").addEventListener("click", async () => {
  const button = document.querySelector("#sendAll");
  if (!currentItems.length) return;
  button.textContent = "Sending...";
  button.disabled = true;
  try {
    setStatus("");
    await sendAllToApp(currentItems);
    button.textContent = "Sent";
  } catch (error) {
    button.textContent = "Failed";
    setStatus(error.message);
    console.error(error);
  } finally {
    setTimeout(() => {
      button.textContent = "Send all";
      button.disabled = false;
    }, 1500);
  }
});
document.querySelector("#copyDebug").addEventListener("click", async () => {
  const payload = JSON.stringify(currentItems.map((item) => ({
    url: normalizedUrl(item.url),
    type: item.type,
    statusCode: item.statusCode,
    method: item.method,
    headers: Object.keys(item.headers || {})
  })), null, 2);
  await navigator.clipboard.writeText(payload);
  setStatus("Captured debug copied. Paste it in chat if Send all still fails.");
});
document.querySelector("#clear").addEventListener("click", async () => {
  if (activeTabId) await chrome.runtime.sendMessage({ type: "clear-items", tabId: activeTabId });
  load();
});

loadSettings().then(load);


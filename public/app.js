const form = document.querySelector("#auditForm");
const loading = document.querySelector("#loading");
const results = document.querySelector("#results");
const toolStack = document.querySelector("#toolStack");
const themeToggle = document.querySelector("#themeToggle");
const openSession = document.querySelector("#openSession");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseHeaders() {
  const input = document.querySelector("#headers");
  const value = input ? input.value.trim() : "";
  if (!value) return {};
  return JSON.parse(value);
}

function kv(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "n/a")}</dd></div>`;
}

function findingCard(item) {
  return `
    <article class="finding ${escapeHtml(item.level)}">
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `;
}

function probePill(probe) {
  const ok = probe?.ok;
  const label = probe ? `${probe.status} ${ok ? "reachable" : "blocked"}` : "not tested";
  return `<span class="pill ${ok ? "ok" : "bad"}">${escapeHtml(label)}</span>`;
}

function statusPill(status) {
  const className = status === "success" || status === "complete" ? "ok" : status === "running" ? "running" : status === "skipped" ? "" : "bad";
  return `<span class="pill ${className}">${escapeHtml(status)}</span>`;
}

function attemptList(attempts = []) {
  if (!attempts.length) return `<p class="note">Starting engines...</p>`;
  return `
    <div class="attempt-list">
      ${attempts.map((item) => `
        <div class="attempt-row">
          <span class="attempt-engine">${escapeHtml(item.engine)}</span>
          ${statusPill(item.status)}
          <div>
            <span>${escapeHtml(item.message || "")}</span>
            ${progressView(item.progress)}
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function progressView(progress) {
  if (!progress) return "";
  const downloaded = formatBytes(progress.downloaded || 0);
  const total = progress.total ? formatBytes(progress.total) : "";
  const label = progress.percent !== null && progress.percent !== undefined
    ? `${progress.percent}% - ${downloaded}${total ? ` / ${total}` : ""}`
    : `${downloaded} downloaded`;
  const width = progress.percent !== null && progress.percent !== undefined ? progress.percent : 8;
  return `
    <div class="progress-wrap" aria-label="Download progress">
      <div class="progress-bar ${progress.percent === null || progress.percent === undefined ? "unknown" : ""}">
        <span style="width: ${Math.max(3, Math.min(100, width))}%"></span>
      </div>
      <small>${escapeHtml(label)}</small>
    </div>
  `;
}

function probeTable(title, probes = []) {
  if (!probes.length) return "";
  return `
    <section class="panel result-card">
      <h2>${escapeHtml(title)}</h2>
      <table class="probe-table">
        <thead>
          <tr>
            <th>URL</th>
            <th>With headers</th>
            <th>Without headers</th>
          </tr>
        </thead>
        <tbody>
          ${probes.map((item) => `
            <tr>
              <td>${escapeHtml(item.url)}</td>
              <td>${probePill(item.withAuth)}</td>
              <td>${probePill(item.anonymous)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function displayDownloadName(fileName = "") {
  const clean = String(fileName || "video.mp4").trim() || "video.mp4";
  return /\.bin$/i.test(clean) ? clean.replace(/\.bin$/i, ".mp4") : clean;
}

function startBrowserDownload(downloadUrl, fileName = "") {
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = displayDownloadName(fileName);
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return "n/a";
  const units = ["B", "KB", "MB", "GB"];
  let size = Number(bytes);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

async function loadToolStack() {
  if (!toolStack) return;
  try {
    const response = await fetch("/api/tools");
    const tools = await response.json();
    toolStack.innerHTML = Object.entries(tools).map(([name, info]) => `
      <span class="tool-chip ${info.available ? "available" : "missing"}">${escapeHtml(name)} ${info.available ? "ready" : "missing"}</span>
    `).join("");
  } catch {
    toolStack.innerHTML = `<span class="tool-chip missing">tool check failed</span>`;
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (themeToggle) themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
  localStorage.setItem("theme", theme);
}

function setupTheme() {
  const saved = localStorage.getItem("theme");
  const preferred = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(saved || preferred);
  themeToggle?.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

function renderDownloadAttempt(data, inputUrl, attempts = [], autoDownload = true) {
  if (data.success && autoDownload) {
    startBrowserDownload(data.downloadUrl, data.fileName);
  }

  const statusTitle = data.success ? "Your file is ready" : "Could not prepare the file";
  const statusClass = data.success ? "success" : "high";
  const message = data.success
    ? `${data.fileName || "Your file"} should start downloading now.`
    : data.reason || "This link could not be downloaded.";
  const engineRows = data.engines
    ? Object.entries(data.engines).map(([engine, value]) => kv(engine, value)).join("")
    : "";

  results.innerHTML = `
    <div class="result-grid">
      <section class="panel result-card">
        <h2>Result</h2>
        <article class="finding ${statusClass}">
          <h3>${escapeHtml(statusTitle)}</h3>
          <p>${escapeHtml(message)}</p>
        </article>
        <dl class="kv">
          ${kv("Input URL", inputUrl)}
          ${data.targetUrl ? kv("Download target", data.targetUrl) : ""}
          ${data.source ? kv("Method", data.source) : ""}
          ${data.fileSize ? kv("File size", formatBytes(data.fileSize)) : ""}
          ${data.meta ? kv("HTTP status", `${data.meta.status}${data.meta.ok ? " OK" : ""}`) : ""}
          ${engineRows}
        </dl>
        ${attempts.length ? `<h2 class="checks-title">Details</h2>${attemptList(attempts)}` : ""}
        <div class="actions">
          ${data.success ? `<a class="secondary" href="${escapeHtml(data.downloadUrl)}">Download again</a>` : ""}
          <button id="showAudit" type="button">Details</button>
        </div>
      </section>

      <section class="panel result-card">
        <h2>Status</h2>
        <ul>
          <li>${data.success ? "The video was prepared successfully." : "The app tried to prepare this link and could not finish it."}</li>
          <li>${data.success ? `Used method: ${escapeHtml(data.source || "download")}.` : "Open Details if you want to inspect what happened."}</li>
        </ul>
      </section>
    </div>
  `;
  results.classList.remove("hidden");

  document.querySelector("#showAudit").addEventListener("click", () => runAudit(inputUrl));
}

function renderJob(job, inputUrl) {
  results.innerHTML = `
    <section class="panel result-card">
      <h2>${job.status === "running" ? "Preparing your file" : "Result"}</h2>
      <article class="finding ${job.status === "running" ? "info" : job.status === "complete" ? "success" : "high"}">
        <h3>${escapeHtml(job.status === "running" ? "Please wait" : job.status === "complete" ? "Ready" : "Could not prepare the file")}</h3>
        <p>${escapeHtml(job.error || (job.status === "running" ? "The app is preparing the video. Download starts automatically when it is ready." : "The process has finished."))}</p>
      </article>
      ${attemptList(job.attempts)}
    </section>
  `;
  results.classList.remove("hidden");
}

async function pollJob(jobId, inputUrl) {
  let downloaded = false;
  while (true) {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "Download job was not found.");

    if (job.status === "running") {
      renderJob(job, inputUrl);
      await new Promise((resolve) => setTimeout(resolve, 1400));
      continue;
    }

    const result = job.result || { success: false, reason: job.error || "Download failed." };
    if (result.success && !downloaded) {
      downloaded = true;
      startBrowserDownload(result.downloadUrl, result.fileName);
    }
    renderDownloadAttempt(result, inputUrl, job.attempts, false);
    return;
  }
}

function loadJobFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get("job");
  if (!jobId) return;
  pollJob(jobId, "Extension media link").catch((error) => {
    results.innerHTML = `
      <section class="panel result-card">
        <h2>Could not load job</h2>
        <p class="note">${escapeHtml(error.message)}</p>
      </section>
    `;
    results.classList.remove("hidden");
  });
}

function render(data, inputUrl) {
  const { meta, detail, findings } = data;
  const downloadUrl = `/api/download?url=${encodeURIComponent(meta.finalUrl || inputUrl)}`;
  const candidates = detail.htmlCandidates || [];
  const manifest = detail.manifest;
  const exposure = detail.exposure || {};
  const headers = {
    "content-type": meta.headers?.["content-type"],
    "content-length": meta.headers?.["content-length"],
    "accept-ranges": meta.headers?.["accept-ranges"],
    "cache-control": meta.headers?.["cache-control"],
    "access-control-allow-origin": meta.headers?.["access-control-allow-origin"]
  };

  results.innerHTML = `
    <div class="result-grid">
      <section class="panel result-card">
        <h2>Target</h2>
        <dl class="kv">
          ${kv("Status", `${meta.status}${meta.ok ? " OK" : ""}`)}
          ${kv("Type", detail.type)}
          ${kv("Final URL", meta.finalUrl)}
          ${kv("Range status", meta.rangeStatus || "not confirmed")}
          ${kv("Downloadable", detail.downloadable ? "direct media file" : "not as a direct file")}
        </dl>
        <div class="actions">
          ${detail.downloadable ? `<a class="secondary" href="${downloadUrl}">Download direct file</a>` : ""}
          <a class="secondary" href="${escapeHtml(meta.finalUrl)}" target="_blank" rel="noreferrer">Open target</a>
        </div>
      </section>

      <section class="panel result-card">
        <h2>Findings</h2>
        <div class="results">${findings.map(findingCard).join("")}</div>
      </section>
    </div>

    ${manifest ? `
      <section class="panel result-card">
        <h2>Manifest details</h2>
        <dl class="kv">
          ${kv("Kind", manifest.kind)}
          ${kv("Encrypted", manifest.encrypted ? "yes" : "no")}
          ${manifest.kind === "hls" ? kv("Variants", manifest.variants.length) + kv("Sample segments", manifest.sampleSegments.length) : ""}
          ${manifest.kind === "dash" ? kv("Representations", manifest.representations) + kv("Segment template", manifest.hasSegmentTemplate ? "yes" : "no") : ""}
        </dl>
      </section>
    ` : ""}

    ${candidates.length ? `
      <section class="panel result-card">
        <h2>Discovered media candidates</h2>
        ${candidates.map((url) => `<a class="candidate" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`).join("")}
      </section>
    ` : ""}

    ${probeTable("Segment exposure probes", exposure.segmentProbes)}
    ${probeTable("Key endpoint probes", exposure.keyProbes)}
    ${probeTable("Discovered candidate probes", exposure.candidateProbes)}

    <section class="panel result-card">
      <h2>Security headers snapshot</h2>
      <pre>${escapeHtml(JSON.stringify(headers, null, 2))}</pre>
    </section>
  `;
  results.classList.remove("hidden");
}

async function runAudit(url) {
  results.classList.add("hidden");
  results.innerHTML = "";
  loading.classList.remove("hidden");

  const deep = document.querySelector("#deep")?.checked ?? true;
  const fileName = document.querySelector("#fileName")?.value.trim() || "";
  try {
    const response = await fetch("/api/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, headers: parseHeaders(), deep, fileName })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Audit failed.");
    render(data, url);
  } catch (error) {
    results.innerHTML = `
      <section class="panel result-card">
        <h2>Audit failed</h2>
        <p class="note">${escapeHtml(error.message)}</p>
      </section>
    `;
    results.classList.remove("hidden");
  } finally {
    loading.classList.add("hidden");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  results.classList.add("hidden");
  results.innerHTML = "";
  loading.classList.remove("hidden");

  const url = document.querySelector("#url").value.trim();
  const fileName = document.querySelector("#fileName")?.value.trim() || "";
  try {
    const response = await fetch("/api/download-attempt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, headers: parseHeaders(), fileName })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Download attempt failed.");
    renderJob(data, url);
    await pollJob(data.id, url);
  } catch (error) {
    results.innerHTML = `
      <section class="panel result-card">
        <h2>Download attempt failed</h2>
        <p class="note">${escapeHtml(error.message)}</p>
      </section>
    `;
    results.classList.remove("hidden");
  } finally {
    loading.classList.add("hidden");
  }
});

openSession?.addEventListener("click", async () => {
  const url = document.querySelector("#url").value.trim();
  if (!url) {
    results.innerHTML = `
      <section class="panel result-card">
        <h2>Enter a link first</h2>
        <p class="note">Paste the video page link, then open the session browser.</p>
      </section>
    `;
    results.classList.remove("hidden");
    return;
  }

  try {
    const response = await fetch("/api/session-browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not open session browser.");
    results.innerHTML = `
      <section class="panel result-card">
        <h2>Session browser opened</h2>
        <p class="note">Log in or play the video in the opened browser, then come back and press Try download.</p>
      </section>
    `;
    results.classList.remove("hidden");
  } catch (error) {
    results.innerHTML = `
      <section class="panel result-card">
        <h2>Could not open browser</h2>
        <p class="note">${escapeHtml(error.message)}</p>
      </section>
    `;
    results.classList.remove("hidden");
  }
});

setupTheme();
loadToolStack();
loadJobFromUrl();

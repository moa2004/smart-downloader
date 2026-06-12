import express from "express";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, open as openFile, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const app = express();
const require = createRequire(import.meta.url);
const PORT = process.env.PORT || 5177;
const MAX_TEXT_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 12000;
const PROCESS_TIMEOUT_MS = 120000;
const DIRECT_TIMEOUT_MS = 60000;
const QUICK_STREAM_TIMEOUT_MS = 25000;
const BROWSER_SCAN_TIMEOUT_MS = 35000;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_STREAM_MEDIA_BYTES = 64 * 1024;
const QUERY_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const QUERY_RANGE_CONCURRENCY = 5;
const GOOGLE_AUDIO_ITAGS = new Set(["139", "140", "141", "249", "250", "251"]);
const GOOGLE_VIDEO_ITAGS = new Set(["133", "134", "135", "136", "137", "160", "242", "243", "244", "247", "248", "271", "313", "315"]);
const MAX_DEEP_TARGETS = 8;
const DOWNLOAD_DIR = process.env.VERCEL ? path.join(tmpdir(), "smart-downloader") : path.join(process.cwd(), "downloads");
const TOOL_DIR = process.env.VERCEL ? path.join(tmpdir(), "smart-downloader-tools", "bin") : path.join(process.cwd(), "tools", "bin");
const BROWSER_PROFILE_DIR = process.env.VERCEL ? path.join(tmpdir(), "smart-downloader-browser-profile") : path.join(process.cwd(), "tools", "browser-profile");
const BUNDLED_TOOL_DIR = path.join(tmpdir(), "smart-downloader-bundled-tools");
const MEDIA_TYPES = /^(video|audio)\//i;
const MANIFEST_TYPES = /(mpegurl|x-mpegurl|dash\+xml|mpd|vnd\.apple\.mpegurl)/i;
const MEDIA_EXT = /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|wav|ogg|flac)(\?|#|$)/i;
const MANIFEST_EXT = /\.(m3u8|mpd)(\?|#|$)/i;
const BROWSER_CANDIDATE_TYPES = /(video|audio|mpegurl|dash\+xml|mpd|octet-stream)/i;
const FACEBOOK_MEDIA_URL = /(?:^|\/\/)(?:[^/]+\.)?(?:fbcdn|facebook|fbsbx)\.(?:net|com)\/|(?:^|\/\/)video-[^/]+\.xx\.fbcdn\.net\//i;
const STREAM_MEDIA_URL = /(googlevideo\.com|\/videoplayback\b|[?&]mime=(?:video|audio)%2F|[?&]mime=(?:video|audio)\/|[?&]itag=)/i;
const RANGED_MEDIA_URL = /(googlevideo\.com|workspacevideo|\/drive\/media\/|\/videoplayback\b|\/playback\b|fbcdn\.net|fbsbx\.com|[?&](?:bytestart|byteend)=)/i;
const EMBEDDED_MEDIA_URLS = /https?:\/\/[^\s"'<>\\]+(?:fbcdn\.net|fbsbx\.com|\.mp4|\.m4v|\.webm|\.mov|\.mkv|\.mp3|\.m4a|\.aac|\.wav|\.ogg|\.flac|\.m3u8|\.mpd)[^\s"'<>\\]*/gi;
const SYSTEM_BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\149.0.4022.52\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\148.0.3967.96\\msedge.exe"
];

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const completedDownloads = new Map();
const downloadJobs = new Map();
const bundledTools = {};

await mkdir(DOWNLOAD_DIR, { recursive: true });
await mkdir(TOOL_DIR, { recursive: true });
await mkdir(BROWSER_PROFILE_DIR, { recursive: true });
await prepareBundledTools();
process.env.PATH = `${BUNDLED_TOOL_DIR}${path.delimiter}${TOOL_DIR}${path.delimiter}${process.env.PATH || ""}`;

async function copyBundledTool(name, sourcePath) {
  if (!sourcePath) return;
  const ext = sourcePath.endsWith(".exe") || (process.platform === "win32" && !sourcePath.endsWith(".exe")) ? ".exe" : "";
  const target = path.join(BUNDLED_TOOL_DIR, `${name}${ext}`);
  try {
    await access(sourcePath);
    await copyFile(sourcePath, target);
    if (process.platform !== "win32") await chmod(target, 0o755).catch(() => {});
    bundledTools[name] = target;
  } catch {
  }
}

async function prepareBundledTools() {
  await mkdir(BUNDLED_TOOL_DIR, { recursive: true });
  await copyBundledTool("ffmpeg", safeRequire("ffmpeg-static"));
  await copyBundledTool("yt-dlp", safeRequire("yt-dlp-exec/src/constants")?.YOUTUBE_DL_PATH);
  const aria2Path = process.platform === "linux" && process.arch === "x64"
    ? path.join(process.cwd(), "node_modules", "@naria2", "linux-x64", "aria2c")
    : null;
  await copyBundledTool("aria2c", aria2Path);
}

function safeRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

function parseUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function requestHeaders(input = {}) {
  const headers = { "user-agent": "MediaGuardAuditor/1.0" };
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-z0-9-]+$/i.test(key)) continue;
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "range"].includes(lower)) continue;
    if (typeof value === "string" && value.length < 4096) headers[lower] = value;
  }
  return headers;
}

function headerPairs(headers = {}) {
  return Object.entries(headers).filter(([, value]) => typeof value === "string" && value.length);
}

function headerLines(headers = {}) {
  return headerPairs(headers).map(([key, value]) => `${key}: ${value}`);
}

function ytDlpHeaderArgs(headers = {}) {
  return headerLines(headers).flatMap((header) => ["--add-header", header]);
}

function nM3u8HeaderArgs(headers = {}) {
  return headerLines(headers).flatMap((header) => ["-H", header]);
}

function curlHeaderArgs(headers = {}) {
  return headerLines(headers).flatMap((header) => ["--header", header]);
}

function aria2HeaderArgs(headers = {}) {
  return headerLines(headers).map((header) => `--header=${header}`);
}

function wgetHeaderArgs(headers = {}) {
  return headerLines(headers).map((header) => `--header=${header}`);
}

function ffmpegHeaderArgs(headers = {}) {
  const lines = headerLines(headers);
  return lines.length ? ["-headers", `${lines.join("\r\n")}\r\n`] : [];
}

function streamlinkHeaderArgs(headers = {}) {
  return headerPairs(headers).flatMap(([key, value]) => ["--http-header", `${key}=${value}`]);
}

function luxHeaderArgs(headers = {}) {
  const args = [];
  if (headers.cookie) args.push("--cookie", headers.cookie);
  if (headers["user-agent"]) args.push("--user-agent", headers["user-agent"]);
  if (headers.referer || headers.referrer) args.push("--refer", headers.referer || headers.referrer);
  return args;
}

function mergeHeaders(...sources) {
  return sources.reduce((merged, source = {}) => {
    for (const [key, value] of Object.entries(source)) {
      const lower = key.toLowerCase();
      if (lower === "range") continue;
      if (typeof value === "string" && value.length) merged[lower] = value;
    }
    return merged;
  }, {});
}

function normalizeMediaDownloadUrl(value) {
  const parsed = new URL(value);
  if (STREAM_MEDIA_URL.test(parsed.href) || RANGED_MEDIA_URL.test(parsed.href)) {
    parsed.searchParams.delete("rn");
    parsed.searchParams.delete("rbuf");
    parsed.searchParams.delete("ump");
    parsed.searchParams.delete("srfvp");
    parsed.searchParams.delete("alr");
    parsed.searchParams.delete("cpn");
  }
  return parsed.href;
}

function queryRangeUrl(value, start, end) {
  const parsed = new URL(value);
  parsed.searchParams.set("range", `${start}-${end}`);
  parsed.searchParams.delete("rn");
  parsed.searchParams.delete("rbuf");
  return parsed.href;
}

function isSuspiciousPartial(url, size) {
  return (STREAM_MEDIA_URL.test(url) || RANGED_MEDIA_URL.test(url)) && Number(size) > 0 && Number(size) < MIN_STREAM_MEDIA_BYTES;
}

function parseContentRange(value = "") {
  const match = value.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3])
  };
}

async function pipeResponseToFile(response, stream) {
  if (!response.body) throw new Error("Empty response body.");
  await pipeline(Readable.fromWeb(response.body), stream, { end: false });
}

function cookieHeaderFromCookies(cookies = []) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function headersObject(headers) {
  return Object.fromEntries([...headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function classify(url, headers = {}, ok = true) {
  const contentType = headers["content-type"] || "";
  if (!ok) {
    if (MANIFEST_TYPES.test(contentType)) return "manifest";
    if (/text\/html/i.test(contentType)) return "html";
    if (MEDIA_TYPES.test(contentType)) return "direct-media";
    return "unknown";
  }
  if (MANIFEST_TYPES.test(contentType) || MANIFEST_EXT.test(url)) return "manifest";
  if (STREAM_MEDIA_URL.test(url) || RANGED_MEDIA_URL.test(url) || FACEBOOK_MEDIA_URL.test(url)) return "direct-media";
  if (MEDIA_TYPES.test(contentType) || MEDIA_EXT.test(url)) return "direct-media";
  if (/text\/html/i.test(contentType) || /\.html?(\?|#|$)/i.test(url)) return "html";
  return "unknown";
}

function absolutize(value, base) {
  try {
    return new URL(value.replace(/&amp;/g, "&"), base).href;
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function safeFileName(value) {
  return decodeURIComponent(value || "media.bin").replace(/[^\w.-]+/g, "_").slice(0, 160) || "media.bin";
}

function requestedFileName(value, fallback, ext = "") {
  const base = safeFileName(value || fallback || "video");
  if (!ext) return base;
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext.replace(/^\./, "")}`;
}

function mediaFileNameFromUrl(url, fallback = "media.bin") {
  const parsed = new URL(url);
  const base = parsed.pathname.split("/").pop() || fallback;
  const mime = decodeURIComponent(parsed.searchParams.get("mime") || "");
  if (/\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|wav|ogg|flac)$/i.test(base)) return safeFileName(base);
  if (/audio\/mp4/i.test(mime)) return safeFileName(`${base || "audio"}.m4a`);
  if (/video\/mp4/i.test(mime)) return safeFileName(`${base || "video"}.mp4`);
  if (/audio\/webm/i.test(mime)) return safeFileName(`${base || "audio"}.webm`);
  if (/video\/webm/i.test(mime)) return safeFileName(`${base || "video"}.webm`);
  return safeFileName(base || fallback);
}

function extFromFileName(fileName, fallback = "bin") {
  const match = String(fileName || "").match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1] : fallback;
}

function mediaKindFromUrl(url) {
  const parsed = new URL(url);
  const mime = decodeURIComponent(parsed.searchParams.get("mime") || "");
  const itag = parsed.searchParams.get("itag") || "";
  const path = decodeURIComponent(parsed.pathname);
  if (/^audio\//i.test(mime) || GOOGLE_AUDIO_ITAGS.has(itag)) return "audio";
  if (/^video\//i.test(mime) || GOOGLE_VIDEO_ITAGS.has(itag)) return "video";
  if (/\.(m4a|aac|mp3|opus|oga|ogg)(?:$|[?#])/i.test(path)) return "audio";
  if (/\.(mp4|m4v|webm|mov|mkv)(?:$|[?#])/i.test(path)) return "video";
  return "unknown";
}

function mediaKindFromCandidate(candidate) {
  const url = typeof candidate === "string" ? candidate : candidate.url;
  const kind = mediaKindFromUrl(url);
  if (kind !== "unknown") return kind;
  const type = typeof candidate === "string" ? "" : candidate.type || "";
  if (/^audio\//i.test(type) || /\baudio\b/i.test(type)) return "audio";
  if (/^video\//i.test(type) || /\bvideo\b/i.test(type)) return "video";
  return "unknown";
}

function jobFileName(job, fallback, ext = "") {
  return requestedFileName(job?.fileName, fallback, ext);
}

function isOpaqueWorkspacePlayback(url) {
  const parsed = new URL(url);
  return /workspacevideo|\/drive\/media\/.+\/playback/i.test(parsed.href) && !parsed.searchParams.get("mime") && !parsed.searchParams.get("itag");
}

function candidateScore(candidate) {
  const url = candidate.url || candidate;
  const kind = mediaKindFromCandidate(candidate);
  if (kind === "video") return 100;
  if (kind === "audio") return 80;
  if (FACEBOOK_MEDIA_URL.test(url)) return 70;
  if (/googlevideo\.com|\/videoplayback\b/i.test(url)) return 60;
  if (MANIFEST_EXT.test(url)) return 50;
  if (isOpaqueWorkspacePlayback(url)) return -50;
  return 0;
}

function fileUrl(id) {
  return `/api/file/${encodeURIComponent(id)}`;
}

function publicToolName(name) {
  if (bundledTools[name]) return bundledTools[name];
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function commandExists(command) {
  if (path.isAbsolute(command)) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const check = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    const child = spawn(check, [command], { windowsHide: true });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function toolStatus() {
  const tools = {
    curl: publicToolName("curl"),
    aria2c: publicToolName("aria2c"),
    wget: publicToolName("wget"),
    "yt-dlp": publicToolName("yt-dlp"),
    "N_m3u8DL-RE": publicToolName("N_m3u8DL-RE"),
    lux: publicToolName("lux"),
    "you-get": publicToolName("you-get"),
    "gallery-dl": publicToolName("gallery-dl"),
    "browser-scan": publicToolName("chrome"),
    ffmpeg: publicToolName("ffmpeg"),
    streamlink: publicToolName("streamlink")
  };
  const entries = await Promise.all(Object.entries(tools).map(async ([name, command]) => {
    if (name === "browser-scan") {
      const browserPath = await findSystemBrowser();
      return [name, { command: browserPath || "Playwright Chromium", available: Boolean(browserPath) }];
    }
    return [name, { command, available: await commandExists(command) }];
  }));
  return Object.fromEntries(entries);
}

function runProcess(command, args, timeoutMs = PROCESS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const killProcessTree = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    };
    timer = setTimeout(() => {
      killProcessTree();
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs / 1000}s.`.trim() });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 20000) stdout = stdout.slice(-20000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on("error", (error) => {
      finish({ ok: false, code: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function findGeneratedFile(prefix) {
  const files = await readdir(DOWNLOAD_DIR);
  const matches = [];
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const fullPath = path.join(DOWNLOAD_DIR, file);
    const info = await stat(fullPath).catch(() => null);
    if (info?.isFile() && info.size > 0) matches.push({ file, fullPath, size: info.size, mtimeMs: info.mtimeMs });
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0] || null;
}

async function findSystemBrowser() {
  for (const browserPath of SYSTEM_BROWSERS) {
    try {
      await access(browserPath);
      return browserPath;
    } catch {
    }
  }
  return null;
}

function createDownloadJob(url, headers = requestHeaders(), fileName = "") {
  const id = randomUUID();
  const job = {
    id,
    url,
    headers,
    fileName: safeFileName(fileName || ""),
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    attempts: [],
    result: null,
    error: null
  };
  downloadJobs.set(id, job);
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    attempts: job.attempts,
    result: job.result,
    error: job.error
  };
}

function addAttempt(job, engine, status, message) {
  if (!job) return;
  const existing = job.attempts.find((item) => item.engine === engine);
  const payload = { engine, status, message, at: Date.now(), progress: existing?.progress };
  if (existing) Object.assign(existing, payload);
  else job.attempts.push(payload);
  job.updatedAt = Date.now();
}

function updateAttemptProgress(job, engine, progress) {
  if (!job) return;
  const existing = job.attempts.find((item) => item.engine === engine);
  if (!existing) return;
  existing.progress = progress;
  job.updatedAt = Date.now();
}

function progressFromBytes(downloaded, total) {
  const safeDownloaded = Number(downloaded) || 0;
  const safeTotal = Number(total) || 0;
  return {
    downloaded: safeDownloaded,
    total: safeTotal || null,
    percent: safeTotal > 0 ? Math.max(0, Math.min(100, Math.round((safeDownloaded / safeTotal) * 100))) : null
  };
}

function startFileProgress(job, engine, { filePath, prefix, totalBytes }) {
  if (!job) return () => {};
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    let info = null;
    if (filePath) {
      info = await stat(filePath).catch(() => null);
    } else if (prefix) {
      const file = await findGeneratedFile(prefix).catch(() => null);
      if (file) info = { size: file.size };
    }
    if (info?.size) updateAttemptProgress(job, engine, progressFromBytes(info.size, totalBytes));
  };
  const timer = setInterval(tick, 1000);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function withTimeout(promiseFactory, timeoutMs, message) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true, error: message }), timeoutMs);
    promiseFactory()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        resolve({ timeout: true, error: error.message || message });
      });
  });
}

async function runEngine(job, engine, fn) {
  addAttempt(job, engine, "running", "Trying...");
  const result = await fn();
  addAttempt(job, engine, result.success ? "success" : "failed", result.message || result.reason || "No result.");
  return result;
}

function extractHtmlCandidates(html, base) {
  const candidates = [];
  const attrs = [
    /<(?:video|audio|source|track)\b[^>]*(?:src|data-src)=["']([^"']+)["']/gi,
    /<a\b[^>]*href=["']([^"']+\.(?:mp4|m4v|webm|mov|mkv|mp3|m4a|aac|wav|ogg|flac|m3u8|mpd)(?:\?[^"']*)?)["']/gi,
    /<meta\b[^>]*(?:property|name)=["'](?:og:video|og:audio|twitter:player:stream)["'][^>]*content=["']([^"']+)["']/gi,
    /["']([^"']+\.(?:mp4|m4v|webm|mov|mkv|mp3|m4a|aac|wav|ogg|flac|m3u8|mpd)(?:\?[^"']*)?)["']/gi
  ];
  for (const regex of attrs) {
    for (const match of html.matchAll(regex)) {
      const url = absolutize(match[1], base);
      if (url) candidates.push(url);
    }
  }
  for (const match of html.matchAll(EMBEDDED_MEDIA_URLS)) {
    const url = absolutize(match[0], base);
    if (url) candidates.push(url);
  }
  return unique(candidates).slice(0, 40);
}

function parseHls(text, base) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const encrypted = lines.some((line) => line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/i.test(line));
  const variants = [];
  const segments = [];
  const keys = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-KEY")) {
      const keyUri = lines[i].match(/\bURI=["']([^"']+)["']/i)?.[1];
      const url = keyUri ? absolutize(keyUri, base) : null;
      if (url) keys.push(url);
    }
    if (lines[i].startsWith("#")) continue;
    const url = absolutize(lines[i], base);
    if (!url) continue;
    if (MANIFEST_EXT.test(url)) variants.push(url);
    else segments.push(url);
  }
  return { encrypted, variants: unique(variants), keys: unique(keys), sampleSegments: unique(segments).slice(0, 5) };
}

function parseDash(text) {
  return {
    encrypted: /<ContentProtection\b/i.test(text),
    representations: [...text.matchAll(/<Representation\b/gi)].length,
    hasSegmentTemplate: /<SegmentTemplate\b/i.test(text)
  };
}

function buildFindings(meta, detail) {
  const findings = [];
  const headers = meta.headers || {};
  const type = classify(meta.finalUrl || meta.url, headers, meta.ok);
  const cacheControl = headers["cache-control"] || "";

  if (type === "direct-media") {
    findings.push({
      level: "high",
      title: "Direct media URL is reachable",
      detail: "The URL can be fetched as a media file. Anyone with the URL can likely save it unless authorization is enforced server-side."
    });
  }
  if (headers["accept-ranges"]?.toLowerCase().includes("bytes") || meta.rangeStatus === 206) {
    findings.push({
      level: "medium",
      title: "Byte range requests are supported",
      detail: "Range requests are normal for video playback, but they also make direct media retrieval easier when URLs are public."
    });
  }
  if (!headers["cache-control"] || !/(private|no-store|no-cache|max-age=0)/i.test(cacheControl)) {
    findings.push({
      level: "medium",
      title: "Cache policy may allow reuse",
      detail: "Protected media should generally use private/no-store style caching or short-lived signed URLs."
    });
  }
  if (headers["access-control-allow-origin"] === "*") {
    findings.push({
      level: "medium",
      title: "CORS allows any origin",
      detail: "Wildcard CORS can let other websites read responses from this media endpoint in browsers."
    });
  }
  if (detail?.manifest?.encrypted === false) {
    findings.push({
      level: "high",
      title: "Unencrypted adaptive stream",
      detail: "The playlist is accessible and does not advertise encryption. Segment URLs may be reusable if not individually authorized."
    });
  }
  if (detail?.manifest?.encrypted === true) {
    findings.push({
      level: "info",
      title: "Manifest advertises encryption/protection",
      detail: "The stream references HLS keys or DASH content protection. Verify key/license endpoints require authorization."
    });
  }
  if (detail?.exposure?.anonymousSegments?.length) {
    findings.push({
      level: "high",
      title: "Stream segments are reachable without test credentials",
      detail: `${detail.exposure.anonymousSegments.length} sampled segment(s) responded successfully without the supplied authorization headers.`
    });
  }
  if (detail?.exposure?.anonymousKeys?.length) {
    findings.push({
      level: "high",
      title: "HLS key URL is reachable without test credentials",
      detail: "A sampled encryption key endpoint responded without the supplied authorization headers. Key/license endpoints must be strongly authorized."
    });
  }
  if (detail?.exposure?.anonymousCandidates?.length) {
    findings.push({
      level: "high",
      title: "Discovered media candidate is publicly reachable",
      detail: `${detail.exposure.anonymousCandidates.length} candidate media URL(s) from the page were reachable without supplied authorization headers.`
    });
  }
  if (detail?.htmlCandidates?.length) {
    findings.push({
      level: "medium",
      title: "Media URLs are discoverable in page markup",
      detail: `${detail.htmlCandidates.length} media or manifest candidate(s) were found in the HTML source.`
    });
  }
  if (!findings.length) {
    findings.push({
      level: "info",
      title: "No obvious public media endpoint found",
      detail: "The target did not expose an easily classified media file or manifest during this limited scan."
    });
  }
  return findings;
}

async function probeUrl(url, headers) {
  const head = await fetchWithTimeout(url, { method: "HEAD", headers }).catch(() => null);
  let response = head?.ok ? head : null;
  if (!response) response = await fetchWithTimeout(url, { method: "GET", headers: { ...headers, range: "bytes=0-0" } });

  const meta = {
    url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    headers: headersObject(response.headers)
  };

  const range = await fetchWithTimeout(url, { method: "GET", headers: { ...headers, range: "bytes=0-0" } }).catch(() => null);
  if (range) {
    meta.rangeStatus = range.status;
    meta.rangeHeaders = headersObject(range.headers);
  }
  return meta;
}

async function lightProbe(url, headers) {
  const response = await fetchWithTimeout(url, { method: "GET", headers: { ...headers, range: "bytes=0-0" } }).catch(() => null);
  if (!response) return { url, ok: false, status: 0, type: "unknown", headers: {} };
  const headersOut = headersObject(response.headers);
  return {
    url,
    finalUrl: response.url,
    ok: response.ok || response.status === 206,
    status: response.status,
    type: classify(response.url, headersOut, response.ok || response.status === 206),
    headers: headersOut
  };
}

async function readTextSample(url, headers) {
  const response = await fetchWithTimeout(url, { headers });
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks = [];
  while (size < MAX_TEXT_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function scanExposure(detail, headers) {
  const exposure = { segmentProbes: [], keyProbes: [], candidateProbes: [] };
  const anonymousHeaders = requestHeaders();

  const segments = detail.manifest?.sampleSegments?.slice(0, MAX_DEEP_TARGETS) || [];
  for (const url of segments) {
    const withAuth = await lightProbe(url, headers);
    const anonymous = await lightProbe(url, anonymousHeaders);
    exposure.segmentProbes.push({ url, withAuth, anonymous });
  }

  const keys = detail.manifest?.keys?.slice(0, MAX_DEEP_TARGETS) || [];
  for (const url of keys) {
    const withAuth = await lightProbe(url, headers);
    const anonymous = await lightProbe(url, anonymousHeaders);
    exposure.keyProbes.push({ url, withAuth, anonymous });
  }

  const candidates = detail.htmlCandidates?.slice(0, MAX_DEEP_TARGETS) || [];
  for (const url of candidates) {
    const withAuth = await lightProbe(url, headers);
    const anonymous = await lightProbe(url, anonymousHeaders);
    exposure.candidateProbes.push({ url, withAuth, anonymous });
  }

  exposure.anonymousSegments = exposure.segmentProbes.filter((item) => item.anonymous.ok).map((item) => item.url);
  exposure.anonymousKeys = exposure.keyProbes.filter((item) => item.anonymous.ok).map((item) => item.url);
  exposure.anonymousCandidates = exposure.candidateProbes
    .filter((item) => item.anonymous.ok && ["direct-media", "manifest"].includes(item.anonymous.type))
    .map((item) => item.url);

  return exposure;
}

async function browserScanForMedia(url, headers = requestHeaders()) {
  if (process.env.VERCEL) return [];
  const { chromium } = await import("playwright");
  const executablePath = await findSystemBrowser();
  const candidates = new Map();
  const addCandidate = (candidateUrl, candidateHeaders = {}, source = "browser") => {
    const absolute = absolutize(candidateUrl, url);
    if (!absolute) return;
    const existing = candidates.get(absolute) || { url: absolute, headers: {}, source };
    existing.headers = mergeHeaders(existing.headers, candidateHeaders);
    existing.source = existing.source || source;
    candidates.set(absolute, existing);
  };
  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: true,
    executablePath: executablePath || undefined,
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-networking"],
    userAgent: headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36",
    extraHTTPHeaders: Object.fromEntries(headerPairs(headers).filter(([key]) => key !== "user-agent"))
  });

  try {
    const page = await context.newPage();

    page.on("response", async (response) => {
      const responseUrl = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      if (MEDIA_EXT.test(responseUrl) || MANIFEST_EXT.test(responseUrl) || FACEBOOK_MEDIA_URL.test(responseUrl) || BROWSER_CANDIDATE_TYPES.test(contentType)) {
        addCandidate(responseUrl, await response.request().allHeaders().catch(() => response.request().headers()), "network");
      }
      if (/(javascript|json|html|text)/i.test(contentType)) {
        const text = await response.text().catch(() => "");
        for (const match of text.matchAll(EMBEDDED_MEDIA_URLS)) {
          const absolute = absolutize(match[0], responseUrl);
          if (absolute) addCandidate(absolute, { referer: page.url() }, "embedded");
        }
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.evaluate(async () => {
      for (const media of document.querySelectorAll("video, audio")) {
        media.muted = true;
        await media.play?.().catch(() => {});
      }
      const labels = ["play", "watch", "start", "video"];
      for (const button of document.querySelectorAll("button, [role='button'], .play, .player, [class*='play'], [aria-label*='Play' i]")) {
        const text = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.className || ""}`.toLowerCase();
        if (labels.some((label) => text.includes(label))) button.click?.();
      }
      for (let i = 0; i < 4; i++) {
        window.scrollTo(0, document.body.scrollHeight * ((i + 1) / 4));
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForTimeout(10000);

    const domCandidates = await page.evaluate(() => {
      const values = [];
      for (const item of document.querySelectorAll("video, audio, source, track")) {
        for (const attr of ["src", "currentSrc", "data-src"]) {
          const value = item[attr] || item.getAttribute?.(attr);
          if (value) values.push(value);
        }
      }
      for (const item of document.querySelectorAll("meta[property='og:video'], meta[property='og:audio'], meta[name='twitter:player:stream']")) {
        const value = item.getAttribute("content");
        if (value) values.push(value);
      }
      return values;
    }).catch(() => []);

    for (const candidate of domCandidates) {
      const absolute = absolutize(candidate, page.url());
      if (absolute) addCandidate(absolute, { referer: page.url() }, "dom");
    }

    for (const candidate of candidates.values()) {
      const cookies = await page.context().cookies(candidate.url).catch(() => []);
      const cookie = cookieHeaderFromCookies(cookies);
      candidate.headers = mergeHeaders(headers, { referer: page.url() }, cookie ? { cookie } : {}, candidate.headers);
    }
  } finally {
    await context.close().catch(() => {});
  }

  return [...candidates.values()].slice(0, 30);
}

async function findDownloadableTarget(url, headers) {
  const meta = await probeUrl(url, headers);
  const type = classify(meta.finalUrl, meta.headers, meta.ok);

  if (meta.ok && type === "direct-media") {
    return {
      success: true,
      source: "input-url",
      targetUrl: meta.finalUrl,
      meta,
      message: "The URL is a directly accessible audio/video file."
    };
  }

  if (type === "html") {
    const html = await readTextSample(meta.finalUrl, headers);
    const candidates = extractHtmlCandidates(html, meta.finalUrl);
    for (const candidate of candidates.slice(0, 12)) {
      const probe = await lightProbe(candidate, headers);
      if (probe.ok && probe.type === "direct-media") {
        return {
          success: true,
          source: "page-candidate",
          targetUrl: probe.finalUrl || candidate,
          meta,
          candidates,
          message: "A directly accessible media file was found in the page source."
        };
      }
    }

    return {
      success: false,
      reason: candidates.length
        ? "The page exposes media-like URLs, but none of the sampled candidates is a directly downloadable audio/video file."
        : "No directly downloadable audio/video file was found in the page source.",
      meta,
      candidates
    };
  }

  if (type === "manifest") {
    return {
      success: false,
      reason: "This is an adaptive streaming manifest, not a single downloadable media file. This tool does not reconstruct HLS/DASH streams or bypass protection.",
      meta
    };
  }

  return {
    success: false,
    reason: meta.ok ? "The URL responded, but it is not recognized as a downloadable audio/video file." : `The server returned HTTP ${meta.status}.`,
    meta
  };
}

async function downloadWithYtDlp(url, job = null, headers = requestHeaders()) {
  const command = publicToolName("yt-dlp");
  if (!(await commandExists(command))) return { success: false, reason: "yt-dlp is not installed or not in PATH." };

  const id = randomUUID();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
  const stopProgress = startFileProgress(job, "yt-dlp", { prefix: id });
  const result = await runProcess(command, [
    "--no-playlist",
    "--no-warnings",
    "--max-filesize",
    String(MAX_DOWNLOAD_BYTES),
    "--socket-timeout",
    "20",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--concurrent-fragments",
    "16",
    "--external-downloader",
    "aria2c",
    "--external-downloader-args",
    "aria2c:-x 16 -s 16 -k 1M --lowest-speed-limit=1K --timeout=20 --connect-timeout=15 --max-tries=3",
    ...ytDlpHeaderArgs(headers),
    "--restrict-filenames",
    "--newline",
    "-f",
    "bv*+ba/best",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    url
  ]);
  stopProgress();

  const file = await findGeneratedFile(id);
  if (!result.ok || !file) {
    return {
      success: false,
      reason: "yt-dlp could not download this URL as a normal public media link.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: file.fullPath, fileName: safeFileName(file.file), size: file.size, engine: "yt-dlp" });
  updateAttemptProgress(job, "yt-dlp", progressFromBytes(file.size, file.size));
  return {
    success: true,
    source: "yt-dlp",
    targetUrl: url,
    fileName: safeFileName(file.file),
    fileSize: file.size,
    downloadUrl: fileUrl(id),
    message: "yt-dlp downloaded and prepared the media file."
  };
}

async function downloadWithNM3u8DL(url, job = null, timeoutMs = PROCESS_TIMEOUT_MS, headers = requestHeaders()) {
  const command = publicToolName("N_m3u8DL-RE");
  if (!(await commandExists(command))) return { success: false, reason: "N_m3u8DL-RE is not installed or not in PATH." };

  const id = randomUUID();
  const tmpDir = path.join(DOWNLOAD_DIR, `${id}-tmp`);
  await mkdir(tmpDir, { recursive: true });
  const stopProgress = startFileProgress(job, "N_m3u8DL-RE", { prefix: id });
  const result = await runProcess(command, [
    url,
    "--save-dir",
    DOWNLOAD_DIR,
    "--save-name",
    id,
    "--tmp-dir",
    tmpDir,
    "--auto-select",
    "--thread-count",
    "24",
    "--download-retry-count",
    "3",
    "--http-request-timeout",
    "20",
    ...nM3u8HeaderArgs(headers),
    "-mt",
    "--binary-merge",
    "--del-after-done",
    "--no-log",
    "--log-level",
    "ERROR",
    "--ffmpeg-binary-path",
    publicToolName("ffmpeg")
  ], timeoutMs);
  stopProgress();

  const file = await findGeneratedFile(id);
  if (!result.ok || !file) {
    return {
      success: false,
      reason: "N_m3u8DL-RE could not download this public HLS/DASH stream.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: file.fullPath, fileName: safeFileName(file.file), size: file.size, engine: "N_m3u8DL-RE" });
  updateAttemptProgress(job, "N_m3u8DL-RE", progressFromBytes(file.size, file.size));
  return {
    success: true,
    source: "N_m3u8DL-RE",
    targetUrl: url,
    fileName: safeFileName(file.file),
    fileSize: file.size,
    downloadUrl: fileUrl(id),
    message: "N_m3u8DL-RE downloaded and merged the stream."
  };
}

async function downloadWithLux(url, job = null, headers = requestHeaders()) {
  const command = publicToolName("lux");
  if (!(await commandExists(command))) return { success: false, reason: "lux is not installed or not in PATH." };

  const id = randomUUID();
  const stopProgress = startFileProgress(job, "lux", { prefix: id });
  const result = await runProcess(command, [
    "--silent",
    "--multi-thread",
    "--retry",
    "3",
    "--thread",
    "16",
    "--chunk-size",
    "2",
    ...luxHeaderArgs(headers),
    "--output-path",
    DOWNLOAD_DIR,
    "--output-name",
    id,
    url
  ], PROCESS_TIMEOUT_MS);
  stopProgress();

  const file = await findGeneratedFile(id);
  if (!result.ok || !file) {
    return {
      success: false,
      reason: "lux could not download this URL.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: file.fullPath, fileName: safeFileName(file.file), size: file.size, engine: "lux" });
  updateAttemptProgress(job, "lux", progressFromBytes(file.size, file.size));
  return {
    success: true,
    source: "lux",
    targetUrl: url,
    fileName: safeFileName(file.file),
    fileSize: file.size,
    downloadUrl: fileUrl(id),
    message: "lux downloaded and prepared the media file."
  };
}

async function downloadWithYouGet(url, job = null, _headers = requestHeaders()) {
  const command = publicToolName("you-get");
  if (!(await commandExists(command))) return { success: false, reason: "you-get is not installed or not in PATH." };

  const id = randomUUID();
  const stopProgress = startFileProgress(job, "you-get", { prefix: id });
  const result = await runProcess(command, [
    "--force",
    "--no-caption",
    "--timeout",
    "20",
    "--output-dir",
    DOWNLOAD_DIR,
    "--output-filename",
    id,
    url
  ], PROCESS_TIMEOUT_MS);
  stopProgress();

  const file = await findGeneratedFile(id);
  if (!result.ok || !file) {
    return {
      success: false,
      reason: "you-get could not download this URL.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: file.fullPath, fileName: safeFileName(file.file), size: file.size, engine: "you-get" });
  updateAttemptProgress(job, "you-get", progressFromBytes(file.size, file.size));
  return {
    success: true,
    source: "you-get",
    targetUrl: url,
    fileName: safeFileName(file.file),
    fileSize: file.size,
    downloadUrl: fileUrl(id),
    message: "you-get downloaded and prepared the media file."
  };
}

async function downloadWithGalleryDl(url, job = null, headers = requestHeaders()) {
  const command = publicToolName("gallery-dl");
  if (!(await commandExists(command))) return { success: false, reason: "gallery-dl is not installed or not in PATH." };

  const id = randomUUID();
  const stopProgress = startFileProgress(job, "gallery-dl", { prefix: id });
  const result = await runProcess(command, [
    "--no-input",
    "--quiet",
    "--retries",
    "3",
    "--http-timeout",
    "20",
    ...(headers["user-agent"] ? ["--user-agent", headers["user-agent"]] : []),
    "--destination",
    DOWNLOAD_DIR,
    "--filename",
    `${id}.{extension}`,
    url
  ], PROCESS_TIMEOUT_MS);
  stopProgress();

  const file = await findGeneratedFile(id);
  if (!result.ok || !file) {
    return {
      success: false,
      reason: "gallery-dl could not download this URL.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: file.fullPath, fileName: safeFileName(file.file), size: file.size, engine: "gallery-dl" });
  updateAttemptProgress(job, "gallery-dl", progressFromBytes(file.size, file.size));
  return {
    success: true,
    source: "gallery-dl",
    targetUrl: url,
    fileName: safeFileName(file.file),
    fileSize: file.size,
    downloadUrl: fileUrl(id),
    message: "gallery-dl downloaded and prepared the media file."
  };
}

async function downloadWithCurl(url, job = null, totalBytes = null, headers = requestHeaders()) {
  const command = publicToolName("curl");
  if (!(await commandExists(command))) return { success: false, reason: "curl is not installed or not in PATH." };

  url = normalizeMediaDownloadUrl(url);
  const id = randomUUID();
  const detectedName = mediaFileNameFromUrl(url, `${id}.bin`);
  const originalName = jobFileName(job, detectedName, extFromFileName(detectedName));
  const outputPath = path.join(DOWNLOAD_DIR, `${id}-${originalName}`);
  const stopProgress = startFileProgress(job, "curl", { filePath: outputPath, totalBytes });
  const result = await runProcess(command, [
    "--location",
    "--fail",
    "--silent",
    "--show-error",
    "--max-filesize",
    String(MAX_DOWNLOAD_BYTES),
    "--speed-time",
    "15",
    "--speed-limit",
    "1024",
    ...curlHeaderArgs(headers),
    "--output",
    outputPath,
    url
  ], DIRECT_TIMEOUT_MS);
  stopProgress();

  const info = await stat(outputPath).catch(() => null);
  if (!result.ok || !info?.isFile() || info.size === 0 || isSuspiciousPartial(url, info.size)) {
    await unlink(outputPath).catch(() => {});
    return {
      success: false,
      reason: isSuspiciousPartial(url, info?.size) ? "curl only downloaded a tiny partial media chunk, not the full video." : "curl could not download this direct media URL.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: outputPath, fileName: originalName, size: info.size, engine: "curl" });
  updateAttemptProgress(job, "curl", progressFromBytes(info.size, totalBytes || info.size));
  return {
    success: true,
    source: "curl",
    targetUrl: url,
    fileName: originalName,
    fileSize: info.size,
    downloadUrl: fileUrl(id),
    message: "curl downloaded and prepared the media file."
  };
}

async function downloadWithAria2(url, job = null, totalBytes = null, headers = requestHeaders()) {
  const command = publicToolName("aria2c");
  if (!(await commandExists(command))) return { success: false, reason: "aria2c is not installed or not in PATH." };

  url = normalizeMediaDownloadUrl(url);
  const id = randomUUID();
  const detectedName = mediaFileNameFromUrl(url, `${id}.bin`);
  const originalName = jobFileName(job, detectedName, extFromFileName(detectedName));
  const outputPath = path.join(DOWNLOAD_DIR, `${id}-${originalName}`);
  const stopProgress = startFileProgress(job, "aria2c", { filePath: outputPath, totalBytes });
  const result = await runProcess(command, [
    "--allow-overwrite=true",
    "--auto-file-renaming=false",
    "--continue=true",
    "--max-connection-per-server=16",
    "--split=16",
    "--min-split-size=1M",
    "--lowest-speed-limit=1K",
    "--timeout=20",
    "--connect-timeout=15",
    "--max-tries=3",
    ...aria2HeaderArgs(headers),
    "--dir",
    DOWNLOAD_DIR,
    "--out",
    `${id}-${originalName}`,
    url
  ], DIRECT_TIMEOUT_MS);
  stopProgress();

  const info = await stat(outputPath).catch(() => null);
  if (!result.ok || !info?.isFile() || info.size === 0 || info.size > MAX_DOWNLOAD_BYTES || isSuspiciousPartial(url, info.size)) {
    await unlink(outputPath).catch(() => {});
    return {
      success: false,
      reason: isSuspiciousPartial(url, info?.size) ? "aria2c only downloaded a tiny partial media chunk, not the full video." : "aria2c could not download this direct media URL.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: outputPath, fileName: originalName, size: info.size, engine: "aria2c" });
  updateAttemptProgress(job, "aria2c", progressFromBytes(info.size, totalBytes || info.size));
  return {
    success: true,
    source: "aria2c",
    targetUrl: url,
    fileName: originalName,
    fileSize: info.size,
    downloadUrl: fileUrl(id),
    message: "aria2c downloaded and prepared the media file."
  };
}

async function downloadWithWget(url, job = null, totalBytes = null, headers = requestHeaders()) {
  const command = publicToolName("wget");
  if (!(await commandExists(command))) return { success: false, reason: "wget is not installed or not in PATH." };

  url = normalizeMediaDownloadUrl(url);
  const id = randomUUID();
  const detectedName = mediaFileNameFromUrl(url, `${id}.bin`);
  const originalName = jobFileName(job, detectedName, extFromFileName(detectedName));
  const outputPath = path.join(DOWNLOAD_DIR, `${id}-${originalName}`);
  const stopProgress = startFileProgress(job, "wget", { filePath: outputPath, totalBytes });
  const result = await runProcess(command, [
    "--quiet",
    "--tries=2",
    "--timeout=20",
    "--read-timeout=20",
    "--max-redirect=10",
    ...wgetHeaderArgs(headers),
    "-O",
    outputPath,
    url
  ], DIRECT_TIMEOUT_MS);
  stopProgress();

  const info = await stat(outputPath).catch(() => null);
  if (!result.ok || !info?.isFile() || info.size === 0 || info.size > MAX_DOWNLOAD_BYTES || isSuspiciousPartial(url, info.size)) {
    await unlink(outputPath).catch(() => {});
    return {
      success: false,
      reason: isSuspiciousPartial(url, info?.size) ? "wget only downloaded a tiny partial media chunk, not the full video." : "wget could not download this direct media URL.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: outputPath, fileName: originalName, size: info.size, engine: "wget" });
  updateAttemptProgress(job, "wget", progressFromBytes(info.size, totalBytes || info.size));
  return {
    success: true,
    source: "wget",
    targetUrl: url,
    fileName: originalName,
    fileSize: info.size,
    downloadUrl: fileUrl(id),
    message: "wget downloaded and prepared the media file."
  };
}

async function downloadWithRanges(url, job = null, headers = requestHeaders(), engineName = "range-downloader") {
  url = normalizeMediaDownloadUrl(url);
  if (!RANGED_MEDIA_URL.test(url)) return { success: false, reason: "Range downloader is only used for ranged media playback URLs." };

  const id = randomUUID();
  const finalExt = mediaKindFromUrl(url) === "audio" ? "m4a" : "mp4";
  const fileName = engineName === "range-downloader"
    ? jobFileName(job, mediaFileNameFromUrl(url, `${id}.${finalExt}`), finalExt)
    : mediaFileNameFromUrl(url, `${id}.${finalExt}`);
  const outputPath = path.join(DOWNLOAD_DIR, `${id}-${fileName}`);
  const probeHeaders = { ...headers, range: "bytes=0-0" };
  const probe = await fetchWithTimeout(url, { headers: probeHeaders }).catch((error) => ({ error }));
  if (probe.error) return { success: false, reason: `Range probe failed: ${probe.error.message}` };

  const contentRange = parseContentRange(probe.headers.get("content-range") || "");
  const contentLength = Number(probe.headers.get("content-length") || 0);

  if (probe.status === 200 && contentLength > MIN_STREAM_MEDIA_BYTES && probe.body) {
    const stopProgress = startFileProgress(job, engineName, { filePath: outputPath, totalBytes: contentLength });
    await pipeline(Readable.fromWeb(probe.body), createWriteStream(outputPath));
    stopProgress();
    const info = await stat(outputPath).catch(() => null);
    if (!info?.isFile() || info.size < MIN_STREAM_MEDIA_BYTES) {
      await unlink(outputPath).catch(() => {});
      return { success: false, reason: "Range downloader received a tiny response instead of the full media." };
    }
    completedDownloads.set(id, { path: outputPath, fileName, size: info.size, engine: "range-downloader" });
    updateAttemptProgress(job, engineName, progressFromBytes(info.size, info.size));
    return { success: true, source: engineName, targetUrl: url, fileName, fileSize: info.size, downloadUrl: fileUrl(id), localPath: outputPath, message: "Downloaded full media response." };
  }

  if (probe.status !== 206 || !contentRange?.total || contentRange.total < MIN_STREAM_MEDIA_BYTES) {
    const queryRange = await downloadWithQueryRanges(url, job, headers, id, fileName, outputPath, engineName);
    if (queryRange.success) return queryRange;
    return { success: false, reason: queryRange.reason || "Server did not expose a usable Content-Range for full media reconstruction." };
  }

  const total = contentRange.total;
  const chunkSize = 4 * 1024 * 1024;
  const output = createWriteStream(outputPath);
  let downloaded = 0;

  try {
    for (let start = 0; start < total; start += chunkSize) {
      const end = Math.min(total - 1, start + chunkSize - 1);
      let response = null;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await fetchWithTimeout(url, { headers: { ...headers, range: `bytes=${start}-${end}` } }).catch((error) => {
          lastError = error;
          return null;
        });
        if (response?.status === 206 && response.body) break;
        response = null;
        await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
      if (!response) throw new Error(lastError?.message || `Range ${start}-${end} failed.`);

      await pipeResponseToFile(response, output);
      downloaded = end + 1;
      updateAttemptProgress(job, engineName, progressFromBytes(downloaded, total));
    }
  } catch (error) {
    output.destroy();
    await unlink(outputPath).catch(() => {});
    return { success: false, reason: `Range downloader failed: ${error.message}` };
  }

  await new Promise((resolve, reject) => {
    output.end((error) => (error ? reject(error) : resolve()));
  });

  const info = await stat(outputPath).catch(() => null);
  if (!info?.isFile() || info.size < MIN_STREAM_MEDIA_BYTES) {
    await unlink(outputPath).catch(() => {});
    return { success: false, reason: "Range downloader produced a tiny file, not the full video." };
  }

  completedDownloads.set(id, { path: outputPath, fileName, size: info.size, engine: "range-downloader" });
  updateAttemptProgress(job, engineName, progressFromBytes(info.size, total));
  return {
    success: true,
    source: engineName,
    targetUrl: url,
    fileName,
    fileSize: info.size,
    downloadUrl: fileUrl(id),
    localPath: outputPath,
    message: "Range downloader reconstructed the full media file."
  };
}

async function downloadWithQueryRanges(url, job = null, headers = requestHeaders(), id = randomUUID(), fileName = null, outputPath = null, engineName = "range-downloader") {
  url = normalizeMediaDownloadUrl(url);
  if (!RANGED_MEDIA_URL.test(url)) return { success: false, reason: "Query-range downloader is only used for playback URLs." };

  fileName ||= jobFileName(job, mediaFileNameFromUrl(url, `${id}.mp4`), mediaKindFromUrl(url) === "audio" ? "m4a" : "mp4");
  outputPath ||= path.join(DOWNLOAD_DIR, `${id}-${fileName}`);
  const expectedTotal = Number(new URL(url).searchParams.get("clen") || 0) || null;

  const firstUrl = queryRangeUrl(url, 0, QUERY_RANGE_CHUNK_BYTES - 1);
  const first = await fetchWithTimeout(firstUrl, { headers }).catch((error) => ({ error }));
  if (first.error || !first.ok || !first.body) {
    return { success: false, reason: `Query-range probe failed: ${first.error?.message || `HTTP ${first.status}`}` };
  }

  const firstBuffer = Buffer.from(await first.arrayBuffer());
  if (firstBuffer.length < MIN_STREAM_MEDIA_BYTES) {
    return { success: false, reason: "Query-range probe returned a tiny chunk, not media data." };
  }

  const file = await openFile(outputPath, "w");
  let downloaded = 0;
  const failures = [];

  async function writeChunk(start, buffer, maybeTotal = null) {
    await file.write(buffer, 0, buffer.length, start);
    downloaded += buffer.length;
    const writtenEnd = start + buffer.length;
    updateAttemptProgress(job, engineName, progressFromBytes(writtenEnd, maybeTotal));
  }

  await writeChunk(0, firstBuffer);
  let nextStart = QUERY_RANGE_CHUNK_BYTES;
  let finalTotal = expectedTotal || (firstBuffer.length < QUERY_RANGE_CHUNK_BYTES ? firstBuffer.length : null);
  updateAttemptProgress(job, engineName, progressFromBytes(firstBuffer.length, finalTotal));

  try {
    while (nextStart < (finalTotal || MAX_DOWNLOAD_BYTES)) {
      const start = nextStart;
      const end = Math.min((finalTotal || MAX_DOWNLOAD_BYTES) - 1, start + QUERY_RANGE_CHUNK_BYTES - 1);
      let response = null;
      let buffer = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        response = await fetchWithTimeout(queryRangeUrl(url, start, end), { headers }).catch((error) => {
          failures.push(error.message);
          return null;
        });
        if (response?.ok && response.body) {
          buffer = Buffer.from(await response.arrayBuffer());
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }

      if (!buffer || buffer.length === 0) {
        finalTotal ||= start;
        break;
      }

      await writeChunk(start, buffer, finalTotal);
      if (buffer.length < QUERY_RANGE_CHUNK_BYTES) {
        finalTotal ||= start + buffer.length;
        updateAttemptProgress(job, engineName, progressFromBytes(finalTotal, finalTotal));
        break;
      }
      nextStart += QUERY_RANGE_CHUNK_BYTES;
    }
  } catch (error) {
    failures.push(error.message);
  } finally {
    await file.close().catch(() => {});
  }

  const info = await stat(outputPath).catch(() => null);
  if (!info?.isFile() || info.size < MIN_STREAM_MEDIA_BYTES) {
    await unlink(outputPath).catch(() => {});
    return { success: false, reason: failures[0] || "Query-range downloader produced a tiny file." };
  }
  if (expectedTotal && info.size < expectedTotal) {
    await unlink(outputPath).catch(() => {});
    return { success: false, reason: `Query-range downloader stopped early at ${info.size} bytes; expected ${expectedTotal} bytes.` };
  }

  completedDownloads.set(id, { path: outputPath, fileName, size: info.size, engine: "range-downloader" });
  updateAttemptProgress(job, engineName, progressFromBytes(info.size, finalTotal || info.size));
  return {
    success: true,
    source: engineName,
    targetUrl: url,
    fileName,
    fileSize: info.size,
    downloadUrl: fileUrl(id),
    localPath: outputPath,
    message: "Query-range downloader reconstructed the media file."
  };
}

async function downloadWithFfmpeg(url, job = null, timeoutMs = PROCESS_TIMEOUT_MS, headers = requestHeaders()) {
  const command = publicToolName("ffmpeg");
  if (!(await commandExists(command))) return { success: false, reason: "ffmpeg is not installed or not in PATH." };

  const id = randomUUID();
  const fileName = jobFileName(job, `${id}.mp4`, "mp4");
  const outputPath = path.join(DOWNLOAD_DIR, fileName);
  const stopProgress = startFileProgress(job, "ffmpeg", { filePath: outputPath });
  const result = await runProcess(command, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...ffmpegHeaderArgs(headers),
    "-i",
    url,
    "-fs",
    String(MAX_DOWNLOAD_BYTES),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath
  ], timeoutMs);
  stopProgress();

  const info = await stat(outputPath).catch(() => null);
  if (!result.ok || !info?.isFile() || info.size === 0) {
    await unlink(outputPath).catch(() => {});
    return {
      success: false,
      reason: "ffmpeg could not convert this public stream into a downloadable file.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: outputPath, fileName, size: info.size, engine: "ffmpeg" });
  updateAttemptProgress(job, "ffmpeg", progressFromBytes(info.size, info.size));
  return {
    success: true,
    source: "ffmpeg",
    targetUrl: url,
    fileName,
    fileSize: info.size,
    downloadUrl: fileUrl(id),
    message: "ffmpeg downloaded and prepared the stream as a media file."
  };
}

async function downloadWithStreamlink(url, job = null, timeoutMs = PROCESS_TIMEOUT_MS, headers = requestHeaders()) {
  const command = publicToolName("streamlink");
  if (!(await commandExists(command))) return { success: false, reason: "streamlink is not installed or not in PATH." };

  const id = randomUUID();
  const fileName = `${id}.ts`;
  const outputPath = path.join(DOWNLOAD_DIR, fileName);
  const stopProgress = startFileProgress(job, "streamlink", { filePath: outputPath });
  const result = await runProcess(command, [
    "--force",
    ...streamlinkHeaderArgs(headers),
    "--output",
    outputPath,
    url,
    "best"
  ], timeoutMs);
  stopProgress();

  const info = await stat(outputPath).catch(() => null);
  if (!result.ok || !info?.isFile() || info.size === 0 || info.size > MAX_DOWNLOAD_BYTES) {
    await unlink(outputPath).catch(() => {});
    return {
      success: false,
      reason: "streamlink could not download this public stream.",
      detail: result.stderr || result.stdout
    };
  }

  completedDownloads.set(id, { path: outputPath, fileName, size: info.size, engine: "streamlink" });
  updateAttemptProgress(job, "streamlink", progressFromBytes(info.size, info.size));
  return {
    success: true,
    source: "streamlink",
    targetUrl: url,
    fileName,
    fileSize: info.size,
    downloadUrl: fileUrl(id),
    message: "streamlink downloaded and prepared the stream."
  };
}

async function muxAudioVideo(video, audio, job = null) {
  const command = publicToolName("ffmpeg");
  if (!(await commandExists(command))) return { success: false, reason: "ffmpeg is not installed or not in PATH." };

  const id = randomUUID();
  const fileName = `${id}.mp4`;
  const outputPath = path.join(DOWNLOAD_DIR, fileName);
  addAttempt(job, "ffmpeg-mux", "running", "Combining video and audio...");
  const result = await runProcess(command, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    video.localPath,
    "-i",
    audio.localPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath
  ], PROCESS_TIMEOUT_MS);

  const info = await stat(outputPath).catch(() => null);
  if (!result.ok || !info?.isFile() || info.size < MIN_STREAM_MEDIA_BYTES) {
    await unlink(outputPath).catch(() => {});
    addAttempt(job, "ffmpeg-mux", "failed", "Could not combine video and audio.");
    return { success: false, reason: "ffmpeg could not combine the captured audio and video streams.", detail: result.stderr || result.stdout };
  }

  completedDownloads.set(id, { path: outputPath, fileName, size: info.size, engine: "ffmpeg-mux" });
  updateAttemptProgress(job, "ffmpeg-mux", progressFromBytes(info.size, info.size));
  addAttempt(job, "ffmpeg-mux", "success", "Combined video and audio.");
  return {
    success: true,
    source: "ffmpeg-mux",
    targetUrl: video.targetUrl,
    fileName,
    fileSize: info.size,
    downloadUrl: fileUrl(id),
    message: "Combined captured video and audio into one MP4 file."
  };
}

async function downloadCapturedCandidates(candidates, job) {
  candidates.sort((a, b) => candidateScore(b) - candidateScore(a));
  const actionable = candidates.filter((candidate) => !isOpaqueWorkspacePlayback(candidate.url));
  const ranged = actionable.filter((candidate) => RANGED_MEDIA_URL.test(candidate.url));
  const videoCandidate = ranged.find((candidate) => mediaKindFromCandidate(candidate) === "video");
  const audioCandidate = ranged.find((candidate) => mediaKindFromCandidate(candidate) === "audio");
  const kinds = {
    total: candidates.length,
    ranged: ranged.length,
    video: ranged.filter((candidate) => mediaKindFromCandidate(candidate) === "video").length,
    audio: ranged.filter((candidate) => mediaKindFromCandidate(candidate) === "audio").length,
    unknown: ranged.filter((candidate) => mediaKindFromCandidate(candidate) === "unknown").length
  };

  if (!actionable.length) {
    return {
      success: false,
      reason: `Only opaque Google Workspace playback API links were captured. Keep playback running and seek until Chrome emits googlevideo/videoplayback URLs with mime or itag. Captured: ${kinds.total}.`,
      engines: { extension: "Captured only opaque playback control endpoints, not media streams." }
    };
  }

  if (videoCandidate && audioCandidate) {
    addAttempt(job, "capture-pair", "running", "Found separate video and audio streams.");
    const videoHeaders = mergeHeaders({ referer: new URL(videoCandidate.url).origin, origin: new URL(videoCandidate.url).origin }, videoCandidate.headers);
    const audioHeaders = mergeHeaders({ referer: new URL(audioCandidate.url).origin, origin: new URL(audioCandidate.url).origin }, audioCandidate.headers);
    const video = await runEngine(job, "video-download", () => downloadWithRanges(videoCandidate.url, job, videoHeaders, "video-download"));
    if (!video.success) return video;
    const audio = await runEngine(job, "audio-download", () => downloadWithRanges(audioCandidate.url, job, audioHeaders, "audio-download"));
    if (!audio.success) return audio;
    return muxAudioVideo(video, audio, job);
  }

  for (const candidate of actionable) {
    addAttempt(job, "extension-candidate", "running", candidate.url);
    const headers = mergeHeaders({ referer: new URL(candidate.url).origin, origin: new URL(candidate.url).origin }, candidate.headers);
    const result = await downloadDiscoveredCandidate({ url: candidate.url, headers }, job, headers);
    if (result.success) {
      if (mediaKindFromCandidate(candidate) === "audio") {
        addAttempt(job, "audio-only", "failed", "Captured stream is audio-only; keep playback running and press Send all after a video stream appears.");
        continue;
      }
      return result;
    }
  }

  return {
    success: false,
    reason: `No complete video could be built from captured links. Captured: ${kinds.total}, ranged: ${kinds.ranged}, video: ${kinds.video}, audio: ${kinds.audio}, unknown: ${kinds.unknown}.`,
    engines: { extension: "Tried captured browser media requests.", captured: JSON.stringify(kinds) }
  };
}

async function downloadDiscoveredCandidate(candidate, job, headers = requestHeaders()) {
  const url = normalizeMediaDownloadUrl(typeof candidate === "string" ? candidate : candidate.url);
  const candidateHeaders = mergeHeaders(headers, typeof candidate === "string" ? {} : candidate.headers);
  const probe = await lightProbe(url, candidateHeaders);
  if (!probe.ok && FACEBOOK_MEDIA_URL.test(url)) {
    const ytdlp = await runEngine(job, "yt-dlp", () => downloadWithYtDlp(url, job, candidateHeaders));
    if (ytdlp.success) return ytdlp;
  }
  if (!probe.ok) return { success: false, reason: `Discovered URL returned HTTP ${probe.status}.` };

  if (probe.type === "direct-media") {
    const totalBytes = Number(probe.headers?.["content-length"] || 0) || null;
    if (RANGED_MEDIA_URL.test(url)) {
      const ranged = await runEngine(job, "range-downloader", () => downloadWithRanges(url, job, candidateHeaders));
      if (ranged.success) return ranged;
    }
    if (FACEBOOK_MEDIA_URL.test(url)) {
      const ytdlp = await runEngine(job, "yt-dlp", () => downloadWithYtDlp(probe.finalUrl || url, job, candidateHeaders));
      if (ytdlp.success) return ytdlp;
    }
    const aria2 = await runEngine(job, "aria2c", () => downloadWithAria2(probe.finalUrl || url, job, totalBytes, candidateHeaders));
    if (aria2.success) return aria2;
    const curl = await runEngine(job, "curl", () => downloadWithCurl(probe.finalUrl || url, job, totalBytes, candidateHeaders));
    if (curl.success) return curl;
    const wget = await runEngine(job, "wget", () => downloadWithWget(probe.finalUrl || url, job, totalBytes, candidateHeaders));
    if (wget.success) return wget;
    return { success: false, reason: "Discovered direct media URL could not be downloaded." };
  }

  if (probe.type === "manifest") {
    const nm3u8 = await runEngine(job, "N_m3u8DL-RE", () => downloadWithNM3u8DL(probe.finalUrl || url, job, PROCESS_TIMEOUT_MS, candidateHeaders));
    if (nm3u8.success) return nm3u8;
    const streamlink = await runEngine(job, "streamlink", () => downloadWithStreamlink(probe.finalUrl || url, job, PROCESS_TIMEOUT_MS, candidateHeaders));
    if (streamlink.success) return streamlink;
    const ffmpeg = await runEngine(job, "ffmpeg", () => downloadWithFfmpeg(probe.finalUrl || url, job, PROCESS_TIMEOUT_MS, candidateHeaders));
    if (ffmpeg.success) return ffmpeg;
    return { success: false, reason: "Discovered stream manifest could not be downloaded." };
  }

  return { success: false, reason: "Discovered URL is not a recognized media file or stream." };
}

async function advancedDownloadAttempt(url, job = null, headers = requestHeaders()) {
  const basic = await findDownloadableTarget(url, headers);
  if (basic.success) {
    const fileName = safeFileName(new URL(basic.targetUrl).pathname.split("/").pop() || "media.bin");
    const totalBytes = Number(basic.meta?.headers?.["content-length"] || basic.meta?.rangeHeaders?.["content-length"] || 0) || null;
    const aria2 = await runEngine(job, "aria2c", () => downloadWithAria2(basic.targetUrl, job, totalBytes, headers));
    if (aria2.success) return aria2;

    const curl = await runEngine(job, "curl", () => downloadWithCurl(basic.targetUrl, job, totalBytes, headers));
    if (curl.success) return curl;

    const wget = await runEngine(job, "wget", () => downloadWithWget(basic.targetUrl, job, totalBytes, headers));
    if (wget.success) return wget;

    addAttempt(job, "direct", "success", "Browser direct download is available.");
    return {
      ...basic,
      fileName,
      downloadUrl: `/api/download?url=${encodeURIComponent(basic.targetUrl)}`,
      engines: {
        direct: "Direct media proxy is available.",
        curl: curl.reason,
        aria2c: aria2.reason,
        wget: wget.reason
      }
    };
  }

  const type = basic.meta ? classify(basic.meta.finalUrl, basic.meta.headers, basic.meta.ok) : "unknown";
  const streamInput = basic.meta?.finalUrl || url;
  let nm3u8 = { reason: "Not tried yet." };
  let streamlink = { reason: "Not tried yet." };
  let ffmpeg = { reason: "Not tried yet." };

  if (type === "manifest" || MANIFEST_EXT.test(url)) {
    nm3u8 = await runEngine(job, "N_m3u8DL-RE", () => downloadWithNM3u8DL(streamInput, job, PROCESS_TIMEOUT_MS, headers));
    if (nm3u8.success) return nm3u8;

    streamlink = await runEngine(job, "streamlink", () => downloadWithStreamlink(streamInput, job, PROCESS_TIMEOUT_MS, headers));
    if (streamlink.success) return streamlink;

    ffmpeg = await runEngine(job, "ffmpeg", () => downloadWithFfmpeg(streamInput, job, PROCESS_TIMEOUT_MS, headers));
    if (ffmpeg.success) return ffmpeg;
  }

  const browserScan = await runEngine(job, "browser-scan", async () => {
    const result = await withTimeout(() => browserScanForMedia(url, headers), BROWSER_SCAN_TIMEOUT_MS, "Browser scan timed out.");
    if (result?.timeout) return { success: false, reason: result.error };
    const candidates = result;
    return candidates.length
      ? { success: true, message: `Found ${candidates.length} media candidate(s).`, candidates }
      : { success: false, reason: "No media requests were visible in a normal browser session." };
  });

  if (browserScan.success) {
    for (const candidate of browserScan.candidates) {
      addAttempt(job, "browser-candidate", "running", typeof candidate === "string" ? candidate : candidate.url);
      const result = await downloadDiscoveredCandidate(candidate, job, headers);
      if (result.success) return { ...result, source: `${result.source} via browser-scan` };
    }
  }

  if (type !== "manifest" && !MANIFEST_EXT.test(url)) {
    nm3u8 = await runEngine(job, "N_m3u8DL-RE", () => downloadWithNM3u8DL(streamInput, job, QUICK_STREAM_TIMEOUT_MS, headers));
    if (nm3u8.success) return nm3u8;

    streamlink = await runEngine(job, "streamlink", () => downloadWithStreamlink(streamInput, job, QUICK_STREAM_TIMEOUT_MS, headers));
    if (streamlink.success) return streamlink;

    ffmpeg = await runEngine(job, "ffmpeg", () => downloadWithFfmpeg(streamInput, job, QUICK_STREAM_TIMEOUT_MS, headers));
    if (ffmpeg.success) return ffmpeg;
  }

  const ytDlp = await runEngine(job, "yt-dlp", () => downloadWithYtDlp(url, job, headers));
  if (ytDlp.success) return ytDlp;
  if (/timed out/i.test(ytDlp.detail || "")) {
    return {
      ...basic,
      reason: "The public extractor started but did not finish within the download time limit. The media may be too large, too slow, or not suitable for one-click download.",
      engines: {
        direct: basic.reason || "No direct media file found.",
        ytDlp: ytDlp.reason,
        ffmpeg: "Skipped because yt-dlp reached the time limit."
      }
    };
  }

  const lux = await runEngine(job, "lux", () => downloadWithLux(url, job, headers));
  if (lux.success) return lux;

  const youGet = await runEngine(job, "you-get", () => downloadWithYouGet(url, job, headers));
  if (youGet.success) return youGet;

  const galleryDl = await runEngine(job, "gallery-dl", () => downloadWithGalleryDl(url, job, headers));
  if (galleryDl.success) return galleryDl;

  return {
    ...basic,
    engines: {
      direct: basic.reason || "No direct media file found.",
      "N_m3u8DL-RE": nm3u8.reason,
      streamlink: streamlink.reason,
      ffmpeg: ffmpeg.reason,
      ytDlp: ytDlp.reason,
      lux: lux.reason,
      "you-get": youGet.reason,
      "gallery-dl": galleryDl.reason
    }
  };
}

app.get("/api/tools", async (_req, res) => {
  res.json(await toolStatus());
});

app.post("/api/session-browser", async (req, res) => {
  if (process.env.VERCEL) return res.status(501).json({ error: "Session browser is not available on this host." });
  const parsed = parseUrl(req.body?.url);
  if (!parsed) return res.status(400).json({ error: "Enter a valid http(s) URL." });

  const executablePath = await findSystemBrowser();
  try {
    const { chromium } = await import("playwright");
    const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: false,
      executablePath: executablePath || undefined,
      args: ["--autoplay-policy=no-user-gesture-required"]
    });
    const page = await context.newPage();
    await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    res.json({ ok: true, message: "Session browser opened. Log in or play the video there, then run download again." });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/audit", async (req, res) => {
  const parsed = parseUrl(req.body?.url);
  if (!parsed) return res.status(400).json({ error: "Enter a valid http(s) URL." });

  const headers = requestHeaders(req.body?.headers);
  try {
    const meta = await probeUrl(parsed.href, headers);
    const type = classify(meta.finalUrl, meta.headers, meta.ok);
    const detail = { type };

    if (type === "html") {
      const html = await readTextSample(meta.finalUrl, headers);
      detail.htmlCandidates = extractHtmlCandidates(html, meta.finalUrl);
    }

    if (type === "manifest") {
      const text = await readTextSample(meta.finalUrl, headers);
      if (/\.m3u8(\?|#|$)/i.test(meta.finalUrl) || /mpegurl/i.test(meta.headers["content-type"] || "")) {
        detail.manifest = { kind: "hls", ...parseHls(text, meta.finalUrl) };
        if (detail.manifest.variants.length && !detail.manifest.sampleSegments.length) {
          const variantText = await readTextSample(detail.manifest.variants[0], headers).catch(() => "");
          const variant = parseHls(variantText, detail.manifest.variants[0]);
          detail.manifest.sampleSegments = variant.sampleSegments;
          detail.manifest.keys = unique([...detail.manifest.keys, ...variant.keys]);
        }
      } else {
        detail.manifest = { kind: "dash", ...parseDash(text) };
      }
    }

    detail.downloadable = type === "direct-media";
    if (req.body?.deep !== false) {
      detail.exposure = await scanExposure(detail, headers);
    }
    res.json({ meta, detail, findings: buildFindings(meta, detail) });
  } catch (error) {
    res.status(502).json({ error: error.name === "AbortError" ? "Request timed out." : error.message });
  }
});

app.post("/api/download-attempt", async (req, res) => {
  const parsed = parseUrl(req.body?.url);
  if (!parsed) return res.status(400).json({ error: "Enter a valid http(s) URL." });

  const headers = mergeHeaders({ referer: parsed.origin, origin: parsed.origin }, requestHeaders(req.body?.headers));
  const job = createDownloadJob(parsed.href, headers, req.body?.fileName);
  advancedDownloadAttempt(parsed.href, job, headers)
    .then((result) => {
      job.status = result.success ? "complete" : "failed";
      job.result = result;
      job.updatedAt = Date.now();
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error.name === "AbortError" ? "Request timed out." : error.message;
      job.updatedAt = Date.now();
    });
  res.status(202).json(publicJob(job));
});

app.options("/api/extension-candidate", (_req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.sendStatus(204);
});

app.post("/api/extension-candidate", async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  const parsed = parseUrl(req.body?.url);
  if (!parsed) return res.status(400).json({ error: "Enter a valid http(s) URL." });

  const headers = mergeHeaders({ referer: parsed.origin, origin: parsed.origin }, requestHeaders(req.body?.headers));
  const job = createDownloadJob(parsed.href, headers, req.body?.fileName);
  downloadDiscoveredCandidate({
    url: parsed.href,
    headers,
    type: typeof req.body?.type === "string" ? req.body.type : "",
    statusCode: req.body?.statusCode || "",
    method: req.body?.method || "GET"
  }, job, headers)
    .then((result) => {
      job.status = result.success ? "complete" : "failed";
      job.result = result;
      job.updatedAt = Date.now();
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error.name === "AbortError" ? "Request timed out." : error.message;
      job.updatedAt = Date.now();
    });
  res.status(202).json(publicJob(job));
});

app.options("/api/extension-candidates", (_req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.sendStatus(204);
});

app.post("/api/extension-candidates", async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates.slice(0, 30) : [];
  const valid = candidates
    .map((item) => {
      const parsed = parseUrl(item?.url);
      return {
        url: parsed ? normalizeMediaDownloadUrl(parsed.href) : null,
        headers: requestHeaders(item?.headers),
        type: typeof item?.type === "string" ? item.type : "",
        statusCode: item?.statusCode || "",
        method: item?.method || "GET"
      };
    })
    .filter((item) => item.url);
  const deduped = [...new Map(valid.map((item) => [item.url, item])).values()];
  if (!deduped.length) return res.status(400).json({ error: "No valid media candidates were provided." });

  const job = createDownloadJob(deduped[0].url, requestHeaders(), req.body?.fileName);
  downloadCapturedCandidates(deduped, job)
    .then((result) => {
      job.status = result.success ? "complete" : "failed";
      job.result = result;
      job.updatedAt = Date.now();
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error.name === "AbortError" ? "Request timed out." : error.message;
      job.updatedAt = Date.now();
    });
  res.status(202).json(publicJob(job));
});

app.get("/api/jobs/:id", (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Download job was not found." });
  res.json(publicJob(job));
});

app.get("/api/file/:id", async (req, res) => {
  const record = completedDownloads.get(req.params.id);
  if (!record) return res.status(404).send("Download file is no longer available. Try the download again.");

  const info = await stat(record.path).catch(() => null);
  if (!info?.isFile()) {
    completedDownloads.delete(req.params.id);
    return res.status(404).send("Download file is no longer available. Try the download again.");
  }

  res.setHeader("content-type", "application/octet-stream");
  res.setHeader("content-length", String(info.size));
  res.setHeader("content-disposition", `attachment; filename="${record.fileName}"`);
  createReadStream(record.path).pipe(res);
});

app.get("/api/download", async (req, res) => {
  const parsed = parseUrl(req.query.url);
  if (!parsed) return res.status(400).send("Invalid URL.");

  try {
    const probe = await probeUrl(parsed.href, requestHeaders());
    if (classify(probe.finalUrl, probe.headers, probe.ok) !== "direct-media") {
      return res.status(403).send("This endpoint only streams directly accessible audio/video files. It does not reconstruct streams or bypass protection.");
    }
    const upstream = await fetchWithTimeout(probe.finalUrl, { headers: requestHeaders() });
    if (!upstream.ok || !upstream.body) return res.status(502).send("Upstream media request failed.");

    const fileName = safeFileName(new URL(probe.finalUrl).pathname.split("/").pop() || "media.bin");
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="${fileName}"`);
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    res.status(502).send(error.name === "AbortError" ? "Request timed out." : error.message);
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Media Guard Auditor running on port ${PORT}`);
  });
}

export default app;

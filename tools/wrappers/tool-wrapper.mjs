#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";

const [, , tool, ...args] = process.argv;

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function valuesAfterPrefix(prefix) {
  return args.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function lastUrl() {
  return [...args].reverse().find((arg) => /^https?:\/\//i.test(arg));
}

function headersFromArgs() {
  const headers = {};
  for (const header of valuesAfterPrefix("--header=")) {
    const separator = header.indexOf(":");
    if (separator > 0) headers[header.slice(0, separator).trim()] = header.slice(separator + 1).trim();
  }
  for (let i = 0; i < args.length; i++) {
    if (["--header", "-H"].includes(args[i]) && args[i + 1]) {
      const separator = args[i + 1].indexOf(":");
      if (separator > 0) headers[args[i + 1].slice(0, separator).trim()] = args[i + 1].slice(separator + 1).trim();
    }
  }
  return headers;
}

async function simpleFetchDownload(outputPath) {
  const url = lastUrl();
  if (!url || !outputPath) throw new Error("Missing URL or output path.");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const response = await fetch(url, { headers: headersFromArgs(), redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath));
}

function run(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    child.on("close", resolve);
    child.on("error", () => resolve(1));
  });
}

function ytDlpPath() {
  return process.env.SMART_DOWNLOADER_YTDLP || "yt-dlp";
}

async function runYtDlp(outputTemplate) {
  const url = lastUrl();
  if (!url || !outputTemplate) throw new Error("Missing URL or output template.");
  await mkdir(path.dirname(outputTemplate), { recursive: true });
  const code = await run(ytDlpPath(), [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--merge-output-format",
    "mp4",
    "-f",
    "bv*+ba/best",
    "-o",
    outputTemplate,
    url
  ]);
  process.exit(code || 0);
}

try {
  if (tool === "curl") {
    await simpleFetchDownload(valueAfter("--output") || valueAfter("-o"));
  } else if (tool === "wget") {
    await simpleFetchDownload(valueAfter("-O"));
  } else if (tool === "streamlink") {
    await runYtDlp(valueAfter("--output"));
  } else if (tool === "lux") {
    const outDir = valueAfter("--output-path") || process.cwd();
    const outName = valueAfter("--output-name") || "%(title)s.%(ext)s";
    await runYtDlp(path.join(outDir, `${outName}.%(ext)s`));
  } else if (tool === "you-get") {
    const outDir = valueAfter("--output-dir") || process.cwd();
    const outName = valueAfter("--output-filename") || "%(title)s";
    await runYtDlp(path.join(outDir, `${outName}.%(ext)s`));
  } else if (tool === "gallery-dl") {
    const outDir = valueAfter("--destination") || process.cwd();
    const filename = valueAfter("--filename") || "%(title)s.%(ext)s";
    await runYtDlp(path.join(outDir, filename.replace("{extension}", "%(ext)s")));
  } else if (tool === "browser-scan") {
    process.exit(0);
  } else {
    throw new Error(`Unknown wrapper tool: ${tool}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

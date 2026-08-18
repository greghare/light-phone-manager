#!/usr/bin/env node
// Downloads the official Google Android SDK Platform Tools and extracts just
// the adb binary (+ its Windows companion DLLs) into resources/platform-tools/<os>/
// so it can be bundled into the app via electron-builder's extraResources.
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const extractZip = require("extract-zip");

const RESOURCES_DIR = path.join(__dirname, "..", "resources", "platform-tools");

// electron-builder platform dir name -> Google's platform-tools zip suffix
const TARGETS = {
  win32: { zipName: "windows", files: ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"] },
  darwin: { zipName: "darwin", files: ["adb"] },
  linux: { zipName: "linux", files: ["adb"] },
};

function download(url, destFile, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects: " + url));
    const file = fs.createWriteStream(destFile);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destFile);
          return resolve(download(res.headers.location, destFile, redirects + 1));
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destFile);
          return reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        file.close();
        fs.rm(destFile, { force: true }, () => {});
        reject(err);
      });
  });
}

async function fetchOne(platformKey) {
  const target = TARGETS[platformKey];
  const destDir = path.join(RESOURCES_DIR, platformKey);
  const marker = path.join(destDir, ".version");
  const alreadyThere = target.files.every((f) => fs.existsSync(path.join(destDir, f)));

  if (alreadyThere && fs.existsSync(marker)) {
    console.log(`[platform-tools] ${platformKey}: already present, skipping (delete ${destDir} to refetch)`);
    return;
  }

  const url = `https://dl.google.com/android/repository/platform-tools-latest-${target.zipName}.zip`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-tools-"));
  const zipPath = path.join(tmpDir, "platform-tools.zip");

  console.log(`[platform-tools] ${platformKey}: downloading ${url}`);
  await download(url, zipPath);

  console.log(`[platform-tools] ${platformKey}: extracting`);
  const extractDir = path.join(tmpDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  await extractZip(zipPath, { dir: extractDir });

  fs.mkdirSync(destDir, { recursive: true });
  const srcDir = path.join(extractDir, "platform-tools");
  for (const f of target.files) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src)) {
      throw new Error(`Expected file missing from platform-tools zip: ${f}`);
    }
    fs.copyFileSync(src, path.join(destDir, f));
  }
  if (platformKey !== "win32") {
    fs.chmodSync(path.join(destDir, "adb"), 0o755);
  }
  fs.writeFileSync(marker, new Date().toISOString());
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[platform-tools] ${platformKey}: done -> ${destDir}`);
}

async function main() {
  // No arg -> just the host platform (what a bare `npm run dist` needs to
  // build locally). Pass "all" explicitly to prefetch every OS's bundle —
  // that's what CI's dist:win/dist:mac/dist:linux scripts do implicitly by
  // always passing their own platform, and what you'd want before e.g.
  // committing resources for all three. Defaulting to "all" instead of the
  // host here used to make plain `npm run dist` fetch macOS's build even on
  // Windows, which fails: python-build-standalone's macOS tarball contains
  // Unix symlinks that Windows' bundled tar can't create.
  const arg = process.argv[2] || os.platform();
  const keys = arg === "all" ? Object.keys(TARGETS) : [arg];
  for (const k of keys) {
    if (!TARGETS[k]) {
      console.error(`Unknown platform "${k}". Expected one of: all, ${Object.keys(TARGETS).join(", ")}`);
      process.exit(1);
    }
  }
  for (const k of keys) {
    try {
      await fetchOne(k);
    } catch (err) {
      console.error(`[platform-tools] ${k}: FAILED — ${err.message}`);
      console.error(`[platform-tools] The app will still run using an "adb" found on PATH for this platform.`);
    }
  }
}

main();

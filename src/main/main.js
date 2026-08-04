"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const adb = require("./adb");
const github = require("./github");
const apkLib = require("./apk");
const store = require("./store");
const mediaLib = require("./media");
const ringtonesLib = require("./ringtones");
const ffmpegLib = require("./ffmpeg");

const DEVICE_POLL_MS = 2500;

let mainWindow = null;
let deviceState = { status: "none", serial: null, model: null, androidVersion: null, freeBytes: null, totalBytes: null };
let pollTimer = null;

// Mirrors a couple of LightOS device settings (not app state, so this isn't
// persisted to store.js — it's read fresh off the device whenever one is
// connected). null means "unknown" (no device connected yet to read it from).
const ANIMATION_SCALE_KEYS = ["window_animation_scale", "animator_duration_scale", "transition_animation_scale"];
const SHOW_EXTERNAL_TOOLS_KEY = "LIGHTOS_SHOW_EXTERNAL_TOOLS";
let osSettings = { animationsOn: null, showExternalTools: null, chromiumAvailable: null, chromiumHidden: null };
// The Chromium package name isn't fixed across LightOS builds, so it's
// resolved by searching installed packages the first time a device connects
// (see refreshOsSettings) and cached here rather than re-searched every poll.
let chromiumPackageId = null;

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

// GitHub release tags are usually "v1.2.3" but the versionName adb reads back
// off the device is just "1.2.3" — compare ignoring a leading "v" so a
// released version that's already installed doesn't show as "update available".
function versionsEqual(a, b) {
  if (a == null || b == null) return false;
  const norm = (s) => String(s).trim().replace(/^v/i, "");
  return norm(a) === norm(b);
}

// GitHub tags can be named almost anything ("chess-v1.0.0-alpha") with no
// real relationship to the tool's actual versionName, so tag-stripping alone
// can't reliably tell "up to date" from "update available". Once a
// release's APK has actually been downloaded and parsed (adding the repo,
// or installing/updating to it), trueVersion holds its real internal
// version — prefer that, falling back to the raw tag otherwise.
function releaseVersion(rel) {
  return (rel && (rel.trueVersion || rel.version)) || null;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastRepos() {
  send("repos:changed", store.getRepos());
}

function githubToken() {
  return store.getSettings().githubToken || process.env.GITHUB_TOKEN || "";
}

// ---------- device polling ----------

async function pollDevice(force = false) {
  try {
    const devices = await adb.listDevices();
    const authorized = devices.filter((d) => d.state === "device");

    if (devices.length === 0) {
      setDeviceState({ status: "none", serial: null, model: null, androidVersion: null, freeBytes: null, totalBytes: null });
      resetOsSettings();
      return;
    }
    if (authorized.length === 0) {
      setDeviceState({ status: "unauthorized", serial: devices[0].serial, model: devices[0].model, androidVersion: null, freeBytes: null, totalBytes: null });
      resetOsSettings();
      return;
    }
    if (authorized.length > 1) {
      setDeviceState({ status: "multiple", serial: null, model: null, androidVersion: null, freeBytes: null, totalBytes: null });
      resetOsSettings();
      return;
    }

    const dev = authorized[0];
    const wasConnectedSerial = deviceState.status === "connected" ? deviceState.serial : null;
    if (!force && wasConnectedSerial === dev.serial) {
      return; // already known-good, no need to re-fetch props every tick
    }

    const info = await adb.getDeviceInfo(dev.serial);
    setDeviceState({
      status: "connected",
      serial: dev.serial,
      model: info.model || dev.model,
      androidVersion: info.androidVersion,
      freeBytes: info.freeBytes,
      totalBytes: info.totalBytes,
    });
    refreshInstalledVersions(dev.serial).catch((err) => console.error("refreshInstalledVersions failed:", err));
    discoverDeviceApps(dev.serial).catch((err) => console.error("discoverDeviceApps failed:", err));
    backupAllMediaNow(dev.serial).catch((err) => console.error("backupAllMediaNow failed:", err));
    refreshOsSettings(dev.serial).catch((err) => console.error("refreshOsSettings failed:", err));
  } catch (err) {
    setDeviceState({ status: "error", serial: null, model: null, androidVersion: null, freeBytes: null, totalBytes: null, error: err.message });
    resetOsSettings();
  }
}

function resetOsSettings() {
  chromiumPackageId = null;
  const empty = { animationsOn: null, showExternalTools: null, chromiumAvailable: null, chromiumHidden: null };
  if (JSON.stringify(osSettings) !== JSON.stringify(empty)) {
    osSettings = empty;
    send("os-settings:update", osSettings);
  }
}

async function refreshOsSettings(serial) {
  if (chromiumPackageId === null) {
    // -u so it's found even if a previous session already hid it.
    const packages = await adb.listAllPackagesIncludingHidden(serial);
    chromiumPackageId = packages.find((p) => /chromium/i.test(p)) || false;
  }

  const [scaleRaw, showExternalRaw, visiblePackages] = await Promise.all([
    adb.getSetting(serial, "global", ANIMATION_SCALE_KEYS[0]),
    adb.getSetting(serial, "system", SHOW_EXTERNAL_TOOLS_KEY),
    chromiumPackageId ? adb.listAllPackages(serial) : Promise.resolve([]),
  ]);
  const next = {
    animationsOn: scaleRaw != null && parseFloat(scaleRaw) > 0,
    showExternalTools: showExternalRaw === "1",
    chromiumAvailable: !!chromiumPackageId,
    chromiumHidden: chromiumPackageId ? !visiblePackages.includes(chromiumPackageId) : null,
  };
  if (JSON.stringify(next) !== JSON.stringify(osSettings)) {
    osSettings = next;
    send("os-settings:update", osSettings);
  }
}

function setDeviceState(next) {
  const changed = JSON.stringify(next) !== JSON.stringify(deviceState);
  deviceState = next;
  if (changed) send("device:update", deviceState);
}

async function refreshInstalledVersions(serial) {
  const repos = store.getRepos();
  let changed = false;
  for (const repo of repos) {
    if (!repo.packageId) continue;
    try {
      const version = await adb.getInstalledVersion(serial, repo.packageId);
      if (version !== repo.installedVersion) {
        store.patchRepo(repo.id, { installedVersion: version });
        changed = true;
      }
    } catch (err) {
      // ignore per-package lookup failures
    }
  }
  if (changed) broadcastRepos();
}

let discoveringDevice = false;

// Finds tools already installed on the device that aren't tracked yet (e.g.
// sideloaded before this tool was ever used, or installed straight via adb)
// and adds them to the list, pulling the APK off the device just to read its
// name/icon/version — the same parser used for drag-and-drop installs.
async function discoverDeviceApps(serial) {
  if (discoveringDevice) return;
  discoveringDevice = true;
  try {
    const known = new Set(store.getRepos().map((r) => r.packageId).filter(Boolean));
    const pkgs = await adb.listThirdPartyPackages(serial);
    const unknown = pkgs.filter((p) => !known.has(p));
    if (unknown.length === 0) return;

    const pullPath = path.join(store.getCacheDir(), "_device-scan.apk");
    let changed = false;
    for (const pkg of unknown) {
      try {
        const remotePath = await adb.getApkPath(serial, pkg);
        if (!remotePath) continue;
        await adb.pullFile(serial, remotePath, pullPath);
        const parsed = await apkLib.parseApk(pullPath);
        const name = parsed.appName || pkg.split(".").filter(Boolean).pop().replace(/\b\w/g, (c) => c.toUpperCase());
        store.upsertRepo({
          id: newId("device"),
          owner: null,
          repo: null,
          name,
          appName: name,
          author: null,
          category: "On Device",
          packageId: pkg,
          icon: parsed.icon || null,
          description: "Found already installed on your Light Phone 3 — no repo tracked for it.",
          repoUrl: null,
          installedVersion: parsed.versionName || null,
          releases: [],
          sideloaded: true,
          busy: false,
        });
        changed = true;
      } catch (err) {
        console.error(`Failed to inspect installed package ${pkg}:`, err);
      } finally {
        fs.rm(pullPath, { force: true }, () => {});
      }
    }
    if (changed) broadcastRepos();
  } finally {
    discoveringDevice = false;
  }
}

// The gallery grid shows `thumbUrl`, a small cached JPEG — never the
// multi-MB original — which is what actually keeps scrolling smooth.
// Falls back to the full file until its thumbnail exists (renderer treats
// that as "no thumbnail ready" and shows a placeholder instead of paying
// for a full-res decode). Videos never get a thumbUrl from here — the
// renderer reads a frame straight off the video file itself.
function withFileUrls(items) {
  return items.map((p) => {
    const hasThumb = fs.existsSync(p.thumbPath);
    return {
      ...p,
      url: pathToFileURL(p.path).href,
      thumbUrl: pathToFileURL(hasThumb ? p.thumbPath : p.path).href,
      hasThumb,
    };
  });
}

function sendMediaChanged(backupDir, mediaType) {
  send("media:changed", { key: mediaType.key, items: withFileUrls(mediaLib.listBackedUpMedia(backupDir, mediaType)) });
}

let backingUpMedia = false;

// Pulls any new file for every media type (Photos/Screenshots/Zero/Videos)
// that isn't already in the configured backup folder. Silent no-op if no
// backup folder is set yet.
async function backupAllMediaNow(serial) {
  const backupDir = store.getSettings().photoBackupDir;
  if (!backupDir || backingUpMedia) return;
  backingUpMedia = true;
  try {
    let totalCopied = 0;
    for (const mediaType of Object.values(mediaLib.MEDIA_TYPES)) {
      const copied = await mediaLib.backupMedia(serial, backupDir, mediaType);
      if (copied > 0) {
        totalCopied += copied;
        sendMediaChanged(backupDir, mediaType);
      }
    }
    if (totalCopied > 0) {
      send("toast", { message: `Backed up ${totalCopied} new file${totalCopied === 1 ? "" : "s"}` });
    }
  } finally {
    backingUpMedia = false;
  }
  refreshThumbnails(backupDir).catch((err) => console.error("refreshThumbnails failed:", err));
}

let thumbnailingInProgress = false;

// Builds any missing/stale image thumbnails, across every media type, in
// the background and pushes an update per type once done. Not awaited by
// callers — thumbnail generation can take a while the first time (e.g. an
// existing folder of 100+ photos) and mustn't block adb polling, IPC, or
// tool boot while it works.
async function refreshThumbnails(backupDir) {
  if (!backupDir || thumbnailingInProgress) return;
  thumbnailingInProgress = true;
  try {
    for (const mediaType of Object.values(mediaLib.MEDIA_TYPES)) {
      if (mediaType.kind !== "image") continue;
      const built = await mediaLib.ensureThumbnails(backupDir, mediaType, mediaLib.listBackedUpMedia(backupDir, mediaType));
      if (built > 0) sendMediaChanged(backupDir, mediaType);
    }
  } finally {
    thumbnailingInProgress = false;
  }
}

// ---------- ringtones & alerts ----------

async function fetchRingtoneEntries(serial) {
  const filenames = await adb.listFiles(serial, ringtonesLib.RINGTONE_DIR);
  return ringtonesLib.buildEntries(filenames, store.getSettings().ringtoneOverrides || {});
}

// ---------- app logs ----------

let activeLogcat = null; // { repoId, child }

function stopLogcat() {
  if (activeLogcat) {
    activeLogcat.child.kill();
    activeLogcat = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startAppLogs(repoId) {
  stopLogcat();
  const serial = requireConnectedDevice();
  const repo = store.getRepos().find((r) => r.id === repoId);
  if (!repo) throw new Error("Repo not found.");
  if (!repo.packageId) throw new Error("No package to show logs for.");

  let pid = await adb.getPid(serial, repo.packageId);
  if (!pid) {
    // Not running yet — launch it and give it a moment to start so logcat
    // has a pid to filter on, rather than reporting "not running" for an
    // app the user just asked to view logs for.
    await adb.launchApp(serial, repo.packageId);
    for (let i = 0; i < 10 && !pid; i++) {
      await sleep(300);
      pid = await adb.getPid(serial, repo.packageId);
    }
  }
  if (!pid) throw new Error(`${repo.appName || repo.name} isn't running.`);

  const child = adb.startLogcat(serial, pid, (line) => send("applogs:line", { repoId, line }));
  activeLogcat = { repoId, child };
  child.on("close", () => {
    if (activeLogcat && activeLogcat.child === child) activeLogcat = null;
  });
}

function requireConnectedDevice() {
  if (deviceState.status !== "connected") {
    throw new Error(
      deviceState.status === "multiple"
        ? "Multiple Android devices are connected — disconnect the others first."
        : deviceState.status === "unauthorized"
        ? "Device is plugged in but unauthorized — check its screen to allow USB debugging."
        : "Connect your Light Phone 3 first."
    );
  }
  return deviceState.serial;
}

// ---------- window ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    // Below this, the detail panel's fixed-width sidebar + list columns
    // leave too little room for its title row (icon, name, author/repo
    // link, and the uninstall/stop-tracking actions) to lay out without
    // the tool name overflowing into the action buttons.
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: "#000000",
    title: "Light Phone Manager",
    // Packaged builds get their icon baked into the .exe/.app by
    // electron-builder (from build/icon.png) — this is only what shows up
    // running unpackaged (`npm start`) on Windows/Linux, where there's no
    // packaged binary for the OS to pull an icon from.
    icon: path.join(__dirname, "..", "..", "build", "icon.png"),
    // frame:false (a truly "frameless" window under Win32) is what was
    // drawing that stray light-gray 1px border — it's a known Windows quirk
    // with WS_THICKFRAME frameless windows, not something Electron exposes
    // a way to recolor/remove directly. titleBarStyle:"hidden" sidesteps it
    // entirely: Windows still treats this as a normal framed window (native
    // shadow, Win11 corner rounding, Aero Snap all keep working) with the
    // caption area just hidden — our own drag region (data-titlebar) and
    // custom minimize/maximize/close buttons already stand in for it, so no
    // native window controls are needed back.
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => {
    send("device:update", deviceState);
    broadcastRepos();
  });
  mainWindow.on("maximize", () => send("window:maximized", true));
  mainWindow.on("unmaximize", () => send("window:maximized", false));
}

// ---------- install / uninstall orchestration ----------

function cachedApkPathFor(repo, version) {
  const safePkg = (repo.packageId || repo.id).replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeVer = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(store.getCacheDir(), safePkg, `${safeVer}.apk`);
}

async function downloadReleaseApk(repo, version) {
  const release = (repo.releases || []).find((r) => r.version === version);
  if (!release || !release.apkAsset) throw new Error(`No APK asset found for ${version}.`);

  const dest = cachedApkPathFor(repo, version);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    await github.downloadAsset(release.apkAsset.url, dest, githubToken());
  }
  return dest;
}

// Self-heals repos that ended up listed twice under the same package —
// e.g. discovered on-device first, then a repo added for it later, from
// before that was reliably collapsed into one entry. Whichever entry is
// actually tracked from a repo wins; a bare "On Device"/sideloaded
// duplicate for the same package gets dropped, carrying over its
// installedVersion first if the survivor doesn't have one.
function dedupeRepos() {
  const repos = store.getRepos();
  const byPackage = new Map();
  const noPackage = [];

  for (const r of repos) {
    if (!r.packageId) {
      noPackage.push(r);
      continue;
    }
    const existing = byPackage.get(r.packageId);
    if (!existing) {
      byPackage.set(r.packageId, r);
      continue;
    }
    const winner = !existing.sideloaded ? existing : r;
    const loser = winner === existing ? r : existing;
    byPackage.set(r.packageId, { ...winner, installedVersion: winner.installedVersion || loser.installedVersion });
  }

  const deduped = [...noPackage, ...byPackage.values()];
  if (deduped.length !== repos.length) {
    store.setRepos(deduped);
    return true;
  }
  return false;
}

// Self-heals repos that were added/installed before trueVersion existed (or
// whose probe/parse failed at the time): if a release's APK happens to
// already be sitting in the local cache, parse it for the real version —
// no network needed — instead of leaving that repo stuck comparing by tag.
async function backfillTrueVersions() {
  let changed = false;
  for (const repo of store.getRepos()) {
    const rel = repo.releases && repo.releases[0];
    if (!rel || rel.trueVersion) continue;
    const cachedPath = cachedApkPathFor(repo, rel.version);
    if (!fs.existsSync(cachedPath)) continue;
    try {
      const parsed = await apkLib.parseApk(cachedPath);
      if (parsed.versionName) {
        const releases = repo.releases.map((r) => (r.version === rel.version ? { ...r, trueVersion: parsed.versionName } : r));
        store.patchRepo(repo.id, { releases });
        changed = true;
      }
    } catch (err) {
      console.error(`Failed to backfill trueVersion for ${repo.name}:`, err.message);
    }
  }
  if (changed) broadcastRepos();
}

// Self-heals repos whose icon was saved before app-info-parser's mislabeled
// (always "image/png" regardless of actual format) or bogus (adaptive-icon
// XML descriptor, not a raster image) icon data was caught — no APK
// re-parse needed, since the fix is just re-sniffing the bytes already
// stored and relabeling or dropping them.
function backfillIcons() {
  let changed = false;
  for (const repo of store.getRepos()) {
    if (!repo.icon) continue;
    const fixed = apkLib.fixIconDataUri(repo.icon);
    if (fixed !== repo.icon) {
      store.patchRepo(repo.id, { icon: fixed });
      changed = true;
    }
  }
  if (changed) broadcastRepos();
}

async function performInstall(repoId, version) {
  const serial = requireConnectedDevice();
  const repo = store.getRepos().find((r) => r.id === repoId);
  if (!repo) throw new Error("Repo not found.");

  const apkPath = await downloadReleaseApk(repo, version);
  send("install:log", { repoId, line: `$ downloading ${version}… ok` });

  try {
    await adb.install(serial, apkPath, (line) => send("install:log", { repoId, line }));
  } catch (err) {
    // Android blocks installing a lower versionCode over a release-signed
    // build (the -d flag in adb.js only covers debuggable ones). The only
    // way to actually roll back is to remove the current install first —
    // that does mean losing that tool's local data, which is inherent to
    // how Android handles downgrades, not something adb can avoid.
    if (repo.packageId && /INSTALL_FAILED_VERSION_DOWNGRADE/i.test(err.message)) {
      send("install:log", { repoId, line: `$ downgrade blocked by Android — uninstalling ${repo.packageId} first (its data will be lost), then reinstalling ${version}` });
      await adb.uninstall(serial, repo.packageId, (line) => send("install:log", { repoId, line }));
      await adb.install(serial, apkPath, (line) => send("install:log", { repoId, line }));
    } else {
      throw err;
    }
  }

  const installedVersion = await adb.getInstalledVersion(serial, repo.packageId);

  // Now that this release's APK has actually been downloaded, read its real
  // internal version and attach it to the matching release — future "up to
  // date"/"update available" checks for this release use that instead of
  // however the repo happens to name its GitHub tag.
  let trueVersion = null;
  try {
    trueVersion = (await apkLib.parseApk(apkPath)).versionName;
  } catch (err) {
    // not fatal — that release just keeps comparing by its raw tag
  }
  const releases = trueVersion
    ? (repo.releases || []).map((r) => (r.version === version ? { ...r, trueVersion } : r))
    : repo.releases;

  store.patchRepo(repoId, { installedVersion: installedVersion || version, releases });
  broadcastRepos();
  send("toast", { message: `${repo.appName || repo.name} installed ${version}` });
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle("repos:list", () => store.getRepos());

  ipcMain.handle("device:get", () => deviceState);

  ipcMain.handle("device:refresh", async () => {
    await pollDevice(true);
    return deviceState;
  });

  ipcMain.handle("device:reboot", async () => {
    const serial = requireConnectedDevice();
    await adb.reboot(serial);
    // The device drops off adb immediately on reboot — reflect that right
    // away instead of waiting for the next poll tick to notice it's gone.
    setDeviceState({ status: "none", serial: null, model: null, androidVersion: null, freeBytes: null, totalBytes: null });
  });

  ipcMain.handle("os-settings:get", () => osSettings);

  ipcMain.handle("os-settings:setAnimations", async (_evt, on) => {
    const serial = requireConnectedDevice();
    const scale = on ? "0.5" : "0";
    for (const key of ANIMATION_SCALE_KEYS) {
      await adb.putSetting(serial, "global", key, scale);
    }
    osSettings = { ...osSettings, animationsOn: on };
    send("os-settings:update", osSettings);
    send("toast", { message: `OS animations turned ${on ? "on" : "off"}` });
    return osSettings;
  });

  ipcMain.handle("os-settings:setShowExternalTools", async (_evt, on) => {
    const serial = requireConnectedDevice();
    await adb.putSetting(serial, "system", SHOW_EXTERNAL_TOOLS_KEY, on ? "1" : "0");
    osSettings = { ...osSettings, showExternalTools: on };
    send("os-settings:update", osSettings);
    send("toast", { message: `External tools ${on ? "shown" : "hidden"} in LightOS` });
    return osSettings;
  });

  ipcMain.handle("os-settings:setChromiumHidden", async (_evt, hidden) => {
    const serial = requireConnectedDevice();
    if (!chromiumPackageId) throw new Error("No Chromium browser found on this device.");
    await adb.setPackageHidden(serial, chromiumPackageId, hidden);
    osSettings = { ...osSettings, chromiumHidden: hidden };
    send("os-settings:update", osSettings);
    send("toast", { message: `Chromium browser ${hidden ? "hidden" : "restored"}` });
    return osSettings;
  });

  ipcMain.handle("repos:add", async (_evt, rawUrl) => {
    const parsed = github.parseRepoUrl(rawUrl);
    if (!parsed) throw new Error("Enter a GitHub repo URL like github.com/author/tool");
    const { owner, repo } = parsed;

    if (store.getRepos().some((r) => r.owner === owner && r.repo === repo)) {
      throw new Error(`${owner}/${repo} is already tracked.`);
    }

    const [meta, releases] = await Promise.all([
      github.fetchRepoMeta(owner, repo, githubToken()),
      github.fetchReleases(owner, repo, githubToken()),
    ]);
    if (releases.length === 0) throw new Error(`${owner}/${repo} has no releases on GitHub.`);

    const id = newId("repo");
    let packageId = null;
    let appName = null;
    let icon = null;

    const withApk = releases.find((r) => r.apkAsset);
    if (withApk) {
      const tmpDest = path.join(store.getCacheDir(), `_probe-${id}.apk`);
      try {
        await github.downloadAsset(withApk.apkAsset.url, tmpDest, githubToken());
        const parsedApk = await apkLib.parseApk(tmpDest);
        packageId = parsedApk.packageId;
        appName = parsedApk.appName;
        icon = parsedApk.icon;
        if (parsedApk.versionName) withApk.trueVersion = parsedApk.versionName;
        // Keep this first download cached under its real package id so
        // installing it right after adding doesn't re-download.
        if (packageId) {
          const safePkg = packageId.replace(/[^a-zA-Z0-9._-]/g, "_");
          const safeVer = withApk.version.replace(/[^a-zA-Z0-9._-]/g, "_");
          const finalDir = path.join(store.getCacheDir(), safePkg);
          fs.mkdirSync(finalDir, { recursive: true });
          fs.renameSync(tmpDest, path.join(finalDir, `${safeVer}.apk`));
        }
      } catch (err) {
        console.error("Failed to probe APK for package info:", err);
      } finally {
        fs.rm(tmpDest, { force: true }, () => {});
      }
    }

    const niceName =
      appName ||
      repo
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

    // If this package was already showing up as an "On Device"/sideloaded
    // entry (no repo tracked for it yet), replace it in place instead of
    // adding a second row for the same tool — reusing its id also means
    // whatever's currently selected/showing that entry just updates rather
    // than pointing at a row that no longer exists.
    const existingByPackage = packageId ? store.getRepos().find((r) => r.packageId === packageId) : null;

    const entry = {
      id: existingByPackage ? existingByPackage.id : id,
      owner,
      repo,
      name: niceName,
      appName: niceName,
      author: owner,
      category: "Utility",
      packageId,
      icon,
      description: meta.description || `Tracked from github.com/${owner}/${repo}.`,
      repoUrl: `github.com/${owner}/${repo}`,
      installedVersion: existingByPackage ? existingByPackage.installedVersion : null,
      releases,
      sideloaded: false,
      busy: false,
    };
    store.upsertRepo(entry);
    broadcastRepos();

    if (deviceState.status === "connected" && packageId) {
      refreshInstalledVersions(deviceState.serial).catch(() => {});
    }
    return entry;
  });

  ipcMain.handle("repos:remove", (_evt, id) => {
    store.removeRepo(id);
    broadcastRepos();
  });

  ipcMain.handle("repos:refresh", async (_evt, id) => {
    const repo = store.getRepos().find((r) => r.id === id);
    if (!repo || repo.sideloaded) return null;
    const releases = await github.fetchReleases(repo.owner, repo.repo, githubToken());
    // Carry forward any trueVersion already learned for a release that's
    // still in the refetched list, so re-checking releases doesn't throw
    // away a real APK-parsed version in favor of the raw tag again.
    const oldByTag = new Map((repo.releases || []).map((r) => [r.version, r]));
    for (const rel of releases) {
      const old = oldByTag.get(rel.version);
      if (old && old.trueVersion) rel.trueVersion = old.trueVersion;
    }
    const updated = store.patchRepo(id, { releases });
    broadcastRepos();
    return updated;
  });

  ipcMain.handle("install:start", async (_evt, { repoId, version }) => {
    await performInstall(repoId, version);
  });

  ipcMain.handle("install:latest", async (_evt, repoId) => {
    const repo = store.getRepos().find((r) => r.id === repoId);
    if (!repo) throw new Error("Repo not found.");
    await performInstall(repoId, repo.releases[0].version);
  });

  ipcMain.handle("install:updateAll", async () => {
    const updatable = store
      .getRepos()
      .filter((r) => r.installedVersion && r.releases[0] && !versionsEqual(releaseVersion(r.releases[0]), r.installedVersion));
    for (const repo of updatable) {
      try {
        await performInstall(repo.id, repo.releases[0].version);
      } catch (err) {
        send("toast", { message: `${repo.appName || repo.name}: ${err.message}` });
      }
    }
  });

  ipcMain.handle("uninstall:start", async (_evt, repoId) => {
    const serial = requireConnectedDevice();
    const repo = store.getRepos().find((r) => r.id === repoId);
    if (!repo) throw new Error("Repo not found.");
    await adb.uninstall(serial, repo.packageId, (line) => send("install:log", { repoId, line }));
    store.patchRepo(repoId, { installedVersion: null });
    broadcastRepos();
    send("toast", { message: `${repo.appName || repo.name} removed from device` });
  });

  ipcMain.handle("app:launch", async (_evt, repoId) => {
    const serial = requireConnectedDevice();
    const repo = store.getRepos().find((r) => r.id === repoId);
    if (!repo) throw new Error("Repo not found.");
    if (!repo.packageId) throw new Error("No package to launch.");
    await adb.launchApp(serial, repo.packageId);
  });

  ipcMain.handle("applogs:start", async (_evt, repoId) => {
    await startAppLogs(repoId);
  });

  ipcMain.handle("applogs:stop", () => {
    stopLogcat();
  });

  ipcMain.handle("apk:pickFile", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select an APK to install",
      filters: [{ name: "Android tool", extensions: ["apk"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("apk:inspect", async (_evt, filePath) => {
    const parsed = await apkLib.parseApk(filePath);
    const repos = store.getRepos();
    const match = parsed.packageId ? repos.find((r) => r.packageId === parsed.packageId) : null;
    return { ...parsed, filePath, matchId: match ? match.id : null, matchName: match ? match.name : null };
  });

  ipcMain.handle("apk:installDropped", async (_evt, { filePath, parsed, matchId, newId: clientId }) => {
    const serial = requireConnectedDevice();

    if (matchId) {
      const repo = store.getRepos().find((r) => r.id === matchId);
      if (!repo) throw new Error("Tracked repo not found.");
      await adb.install(serial, filePath, (line) => send("install:log", { repoId: matchId, line }));
      const installedVersion = await adb.getInstalledVersion(serial, repo.packageId);
      store.patchRepo(matchId, { installedVersion });
      broadcastRepos();
      send("toast", { message: `${repo.appName || repo.name} installed` });
      return { repoId: matchId };
    }

    const id = clientId || newId("sideload");
    const name = parsed.appName || parsed.packageId || "Unknown Tool";
    const entry = {
      id,
      owner: null,
      repo: null,
      name,
      appName: name,
      author: null,
      category: "Sideloaded",
      packageId: parsed.packageId,
      icon: parsed.icon || null,
      description: "Installed manually from an APK file.",
      repoUrl: null,
      installedVersion: null,
      releases: [{ version: parsed.versionName || "unknown", date: new Date().toLocaleDateString(), apkAsset: null }],
      sideloaded: true,
      busy: false,
    };
    store.upsertRepo(entry);
    broadcastRepos();

    await adb.install(serial, filePath, (line) => send("install:log", { repoId: id, line }));
    const installedVersion = await adb.getInstalledVersion(serial, entry.packageId);
    store.patchRepo(id, { installedVersion: installedVersion || parsed.versionName });
    broadcastRepos();
    send("toast", { message: `${name} installed` });
    return { repoId: id };
  });

  ipcMain.handle("shell:openExternal", (_evt, url) => {
    const full = /^https?:\/\//.test(url) ? url : `https://${url}`;
    shell.openExternal(full);
  });

  ipcMain.handle("media:openFolder", (_evt, key) => {
    const mediaType = mediaLib.MEDIA_TYPES[key];
    const backupDir = store.getSettings().photoBackupDir;
    if (!mediaType || !backupDir) return;
    const dir = mediaLib.localDirFor(backupDir, mediaType);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  ipcMain.handle("media:getSettings", () => ({
    backupDir: store.getSettings().photoBackupDir || "",
    types: Object.values(mediaLib.MEDIA_TYPES).map((t) => ({ key: t.key, label: t.label, kind: t.kind, devicePath: t.devicePath })),
  }));

  ipcMain.handle("media:chooseBackupDir", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder to back up Light Phone media to",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const dir = result.filePaths[0];
    store.setSettings({ photoBackupDir: dir });
    if (deviceState.status === "connected") {
      backupAllMediaNow(deviceState.serial).catch((err) => console.error("backupAllMediaNow failed:", err));
    }
    return dir;
  });

  ipcMain.handle("media:list", (_evt, key) => {
    const mediaType = mediaLib.MEDIA_TYPES[key];
    if (!mediaType) throw new Error(`Unknown media type "${key}".`);
    const backupDir = store.getSettings().photoBackupDir;
    refreshThumbnails(backupDir).catch((err) => console.error("refreshThumbnails failed:", err));
    return withFileUrls(mediaLib.listBackedUpMedia(backupDir, mediaType));
  });

  ipcMain.handle("media:backupNow", async () => {
    const serial = requireConnectedDevice();
    if (!store.getSettings().photoBackupDir) throw new Error("Choose a backup folder first.");
    await backupAllMediaNow(serial);
  });

  ipcMain.handle("ringtones:list", async () => {
    if (deviceState.status !== "connected") return { ringtones: [], alerts: [] };
    return fetchRingtoneEntries(deviceState.serial);
  });

  ipcMain.handle("ringtones:pickAndUpload", async (_evt, { remoteFilename, backupFilename }) => {
    const serial = requireConnectedDevice();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select an audio file",
      filters: [{ name: "Audio", extensions: ["mp3", "m4a", "aac", "wav", "ogg", "flac", "wma", "aiff", "opus"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const srcPath = result.filePaths[0];
    // Shown in the "Override Ringtone Name" column: the file the user picked,
    // renamed to .m4a since that's the format it's actually stored as on the
    // device now (the on-device filename itself stays the standardized
    // "ringtone_<key>.m4a" — this is just the human-readable label).
    const originalName = `${path.parse(srcPath).name}.m4a`;

    const remotePath = `${ringtonesLib.RINGTONE_DIR}/${remoteFilename}`;
    const backupPath = `${ringtonesLib.RINGTONE_DIR}/${backupFilename}`;

    // Back up the stock sound the first time this device ringtone gets
    // overridden — and never again, since a second backup here would
    // overwrite the stock file with whatever the last custom upload was.
    const existing = await adb.listFiles(serial, ringtonesLib.RINGTONE_DIR);
    if (!existing.includes(backupFilename)) {
      await adb.moveFile(serial, remotePath, backupPath);
    }

    const tmpOut = path.join(store.getCacheDir(), `_ringtone-${Date.now()}.m4a`);
    try {
      await ffmpegLib.convertToM4a(srcPath, tmpOut);
      await adb.pushFile(serial, tmpOut, remotePath);
    } finally {
      fs.rm(tmpOut, { force: true }, () => {});
    }
    await adb.rescanMediaFile(serial, `${ringtonesLib.RINGTONE_DIR_CANONICAL}/${remoteFilename}`);

    store.setSettings({ ringtoneOverrides: { ...(store.getSettings().ringtoneOverrides || {}), [remoteFilename]: originalName } });
    send("toast", { message: `Replaced with ${originalName}` });
    return fetchRingtoneEntries(serial);
  });

  ipcMain.handle("ringtones:restore", async (_evt, { remoteFilename, backupFilename }) => {
    const serial = requireConnectedDevice();
    const remotePath = `${ringtonesLib.RINGTONE_DIR}/${remoteFilename}`;
    const backupPath = `${ringtonesLib.RINGTONE_DIR}/${backupFilename}`;
    await adb.deleteFile(serial, remotePath);
    await adb.moveFile(serial, backupPath, remotePath);
    await adb.rescanMediaFile(serial, `${ringtonesLib.RINGTONE_DIR_CANONICAL}/${remoteFilename}`);

    const overrides = { ...(store.getSettings().ringtoneOverrides || {}) };
    delete overrides[remoteFilename];
    store.setSettings({ ringtoneOverrides: overrides });
    send("toast", { message: "Restored the original sound" });
    return fetchRingtoneEntries(serial);
  });

  ipcMain.handle("ringtones:getPlayUrl", async (_evt, { remoteFilename }) => {
    const serial = requireConnectedDevice();
    const remotePath = `${ringtonesLib.RINGTONE_DIR}/${remoteFilename}`;
    const localDir = path.join(store.getCacheDir(), "ringtone-playback");
    fs.mkdirSync(localDir, { recursive: true });
    // Always re-pull rather than reusing a cached copy — the file at this
    // path may have just been replaced or restored, and a stale cached copy
    // would play the wrong sound.
    const localPath = path.join(localDir, remoteFilename);
    await adb.pullFile(serial, remotePath, localPath);
    return pathToFileURL(localPath).href;
  });

  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:toggleMaximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:isMaximized", () => !!mainWindow?.isMaximized());
}

// ---------- lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    store.init();
    dedupeRepos(); // runs before the window loads, so the first repos:changed already reflects it
    backfillIcons();
    // Packaged .app bundles get their dock icon from the .icns baked in at
    // build time — running unpackaged (`npm start`) on macOS has nothing to
    // pull one from otherwise, so set it explicitly for dev.
    if (process.platform === "darwin" && !app.isPackaged && app.dock) {
      app.dock.setIcon(path.join(__dirname, "..", "..", "build", "icon.png"));
    }
    registerIpc();
    createWindow();
    backfillTrueVersions().catch((err) => console.error("backfillTrueVersions failed:", err));
    pollDevice();
    pollTimer = setInterval(pollDevice, DEVICE_POLL_MS);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (pollTimer) clearInterval(pollTimer);
    stopLogcat();
    if (process.platform !== "darwin") app.quit();
  });
}

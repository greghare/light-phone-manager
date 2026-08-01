"use strict";

const { execFile, spawn } = require("child_process");
const { resolveAdbPath } = require("./adbPath");

function run(args, opts = {}) {
  const { path: adbPath } = resolveAdbPath();
  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { timeout: 20000, ...opts }, (err, stdout, stderr) => {
      if (err && !opts.allowFailure) {
        const e = new Error(stderr?.trim() || err.message);
        e.stdout = stdout;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// Parses `adb devices -l` output into a list of { serial, state, model }.
async function listDevices() {
  const { stdout } = await run(["devices", "-l"]);
  const lines = stdout.split(/\r?\n/).slice(1).filter((l) => l.trim().length);
  return lines.map((line) => {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    const modelMatch = rest.join(" ").match(/model:(\S+)/);
    return {
      serial,
      state, // "device" (authorized), "unauthorized", "offline"
      model: modelMatch ? modelMatch[1].replace(/_/g, " ") : null,
    };
  });
}

async function getDeviceInfo(serial) {
  const { stdout } = await run([
    "-s",
    serial,
    "shell",
    "getprop ro.product.model && echo :::SEP::: && getprop ro.build.version.release && echo :::SEP::: && df /data",
  ]);
  const [modelRaw, versionRaw, dfRaw] = stdout.split(":::SEP:::").map((s) => (s || "").trim());

  let freeBytes = null;
  let totalBytes = null;
  if (dfRaw) {
    const lines = dfRaw.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    const cols = last ? last.trim().split(/\s+/) : [];
    // Filesystem 1K-blocks Used Available Use% Mounted-on
    if (cols.length >= 4 && /^\d+$/.test(cols[1]) && /^\d+$/.test(cols[3])) {
      totalBytes = Number(cols[1]) * 1024;
      freeBytes = Number(cols[3]) * 1024;
    }
  }

  return {
    model: modelRaw || null,
    androidVersion: versionRaw || null,
    freeBytes,
    totalBytes,
  };
}

async function getInstalledVersion(serial, packageId) {
  const { stdout } = await run(["-s", serial, "shell", "dumpsys", "package", packageId], {
    allowFailure: true,
  });
  const match = stdout.match(/versionName=(\S+)/);
  return match ? match[1] : null;
}

// Lists non-system ("third party") installed package names — i.e. tools
// someone sideloaded, which is everything on a Light Phone 3.
async function listThirdPartyPackages(serial) {
  const { stdout } = await run(["-s", serial, "shell", "pm", "list", "packages", "-3"]);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => l.slice("package:".length).trim())
    .filter(Boolean);
}

// Resolves the on-device path to a package's base APK (skipping split/config APKs).
async function getApkPath(serial, packageId) {
  const { stdout } = await run(["-s", serial, "shell", "pm", "path", packageId], { allowFailure: true });
  const paths = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => l.slice("package:".length).trim());
  return paths.find((p) => p.endsWith("base.apk")) || paths[0] || null;
}

async function pullFile(serial, remotePath, localPath) {
  await run(["-s", serial, "pull", remotePath, localPath], { timeout: 60000 });
  return localPath;
}

async function pushFile(serial, localPath, remotePath) {
  await run(["-s", serial, "push", localPath, remotePath], { timeout: 60000 });
  return remotePath;
}

async function moveFile(serial, fromPath, toPath) {
  await run(["-s", serial, "shell", "mv", fromPath, toPath]);
}

async function deleteFile(serial, remotePath) {
  await run(["-s", serial, "shell", "rm", "-f", remotePath]);
}

// Tells Android's media scanner about a file that changed on disk outside
// of its usual APIs (e.g. adb push) — without this, LightOS keeps using
// whatever it last indexed for that path instead of the new file.
async function rescanMediaFile(serial, canonicalRemotePath) {
  await run(["-s", serial, "shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${canonicalRemotePath}`], {
    allowFailure: true,
  });
}

// Lists filenames in a directory on the device. Returns [] if the path
// doesn't exist rather than throwing (e.g. no Pictures folder yet).
async function listFiles(serial, remotePath) {
  const { stdout } = await run(["-s", serial, "shell", "ls", "-1", remotePath], { allowFailure: true });
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/no such file or directory/i.test(l));
}

// Streams `adb install -r -d <apk>`, invoking onLine(text) for each line of
// combined stdout/stderr as it arrives. Resolves/rejects on process exit.
// `-d` allows a version downgrade for debuggable builds; release-signed
// builds still reject downgrades, which callers handle by uninstalling
// first (see performInstall in main.js).
function install(serial, apkPath, onLine) {
  const { path: adbPath } = resolveAdbPath();
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath, ["-s", serial, "install", "-r", "-d", apkPath]);
    let buffer = "";
    let stderrAll = "";
    const emit = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) onLine(line.trim());
      }
    };
    child.stdout.on("data", emit);
    child.stderr.on("data", (chunk) => {
      stderrAll += chunk.toString();
      emit(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) onLine(buffer.trim());
      if (code === 0 && !/Failure/i.test(stderrAll)) {
        resolve();
      } else {
        reject(new Error(stderrAll.trim() || `adb install exited with code ${code}`));
      }
    });
  });
}

function uninstall(serial, packageId, onLine) {
  const { path: adbPath } = resolveAdbPath();
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath, ["-s", serial, "uninstall", packageId]);
    let buffer = "";
    let stderrAll = "";
    const emit = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim() && onLine) onLine(line.trim());
      }
    };
    child.stdout.on("data", emit);
    child.stderr.on("data", (chunk) => {
      stderrAll += chunk.toString();
      emit(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim() && onLine) onLine(buffer.trim());
      if (code === 0) resolve();
      else reject(new Error(stderrAll.trim() || `adb uninstall exited with code ${code}`));
    });
  });
}

// Launches an app's default launcher activity and brings it to the
// foreground. `monkey -c android.intent.category.LAUNCHER` finds the right
// activity itself, so this works without knowing the app's activity name.
async function launchApp(serial, packageId) {
  await run(["-s", serial, "shell", "monkey", "-p", packageId, "-c", "android.intent.category.LAUNCHER", "1"]);
}

// Returns the running process id for a package, or null if it's not running.
// `pidof` can print more than one pid for a multi-process app — the first is
// always its main process.
async function getPid(serial, packageId) {
  const { stdout } = await run(["-s", serial, "shell", "pidof", packageId], { allowFailure: true });
  const pid = stdout.trim().split(/\s+/)[0];
  return /^\d+$/.test(pid) ? pid : null;
}

// Streams `adb logcat --pid=<pid>`, invoking onLine(text) per line as it
// arrives. Returns the child process so the caller can `.kill()` it to stop
// the stream — logcat runs until killed, it never exits on its own.
function startLogcat(serial, pid, onLine) {
  const { path: adbPath } = resolveAdbPath();
  const child = spawn(adbPath, ["-s", serial, "logcat", "--pid", String(pid), "-v", "time"]);
  let buffer = "";
  const emit = (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (line) onLine(line);
    }
  };
  child.stdout.on("data", emit);
  child.stderr.on("data", emit);
  return child;
}

async function reboot(serial) {
  await run(["-s", serial, "reboot"]);
}

// Reads an `adb shell settings get <namespace> <key>` value, e.g.
// getSetting(serial, "global", "window_animation_scale"). Returns null for
// an unset key (adb prints the literal string "null" in that case) rather
// than the string "null" itself.
async function getSetting(serial, namespace, key) {
  const { stdout } = await run(["-s", serial, "shell", "settings", "get", namespace, key], { allowFailure: true });
  const value = stdout.trim();
  return value && value !== "null" ? value : null;
}

async function putSetting(serial, namespace, key, value) {
  await run(["-s", serial, "shell", "settings", "put", namespace, key, String(value)]);
}

module.exports = {
  listDevices,
  getDeviceInfo,
  getInstalledVersion,
  listThirdPartyPackages,
  getApkPath,
  pullFile,
  pushFile,
  moveFile,
  deleteFile,
  rescanMediaFile,
  listFiles,
  install,
  uninstall,
  launchApp,
  getPid,
  startLogcat,
  reboot,
  getSetting,
  putSetting,
};

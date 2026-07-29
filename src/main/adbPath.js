"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const BIN_NAME = process.platform === "win32" ? "adb.exe" : "adb";

// Resolves the adb binary to use, in priority order:
//   1. Bundled copy shipped in resources/platform-tools/<platform>/ (dev) or
//      process.resourcesPath/platform-tools/ (packaged build).
//   2. A user override via the LTM_ADB_PATH env var.
//   3. Whatever "adb" resolves to on the system PATH.
function resolveAdbPath() {
  const candidates = [];

  if (process.env.LTM_ADB_PATH) {
    candidates.push(process.env.LTM_ADB_PATH);
  }

  const isPackaged = app && typeof app.isPackaged === "boolean" ? app.isPackaged : false;
  if (isPackaged) {
    candidates.push(path.join(process.resourcesPath, "platform-tools", BIN_NAME));
  } else {
    candidates.push(
      path.join(__dirname, "..", "..", "resources", "platform-tools", process.platform, BIN_NAME)
    );
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return { path: candidate, bundled: true };
    }
  }

  // Fall back to PATH lookup — child_process will resolve "adb" itself.
  return { path: BIN_NAME, bundled: false };
}

module.exports = { resolveAdbPath, BIN_NAME };

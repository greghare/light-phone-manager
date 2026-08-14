"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// Resolves how to invoke the Light CLI, the same shape adbPath.js uses for
// adb ({ path/command, bundled }), except the CLI here is a Python package
// (`light-phone-cli-tui`, github.com/garado/light — GPL-3.0 as of the
// 0.3.0 this app requires for --json support, kept separate from this app's
// own MIT license by shipping it as a standalone process, never imported
// into this codebase) rather than a native binary, so what's bundled is a
// whole portable Python + vendored install of it — see
// scripts/fetch-light-cli.js for how resources/light-cli/<platform>/ gets
// built, and resources/README-light-cli.txt for what's actually in there.
//
// Two entry-point scripts ship in resources/light-cli/, both run against
// the same bundled interpreter:
//   - run_light.py — the `light` CLI itself (light_cli_tui), for every
//     command it actually exposes (devices, podcasts, login/logout).
//   - notes_cli.py — notes list/get/create/update/delete. The CLI only
//     exposes notes list/add/download (no edit, delete, or single-note
//     fetch), so this talks to light_api (light_cli_tui's own dependency,
//     already vendored alongside it) directly instead. See notes_cli.py's
//     own header for details.
//
// Priority order for resolveLightCommand(script):
//   1. LTM_LIGHT_PATH — a user override, used as-is with no extra args.
//      Only usable for RUN_LIGHT_SCRIPT: it points at a `light` executable
//      on the user's machine, which has no equivalent for notes_cli.py's
//      light_api-direct calls.
//   2. The bundled interpreter + the requested script — what every packaged
//      build and ordinary dev checkout uses. light.js never depends on a
//      `light` command existing on the user's own machine.
//   3. For RUN_LIGHT_SCRIPT only, whatever "light" resolves to on PATH — a
//      last-resort dev fallback for a checkout that hasn't run `npm run
//      fetch-light-cli` yet.
// Returns null if none of the above apply (e.g. notes_cli.py requested but
// no bundled runtime is present) — callers should surface that as a clear
// "notes need the bundled Light CLI" error rather than trying to run it.
const RUN_LIGHT_SCRIPT = "run_light.py";
const NOTES_SCRIPT = "notes_cli.py";

function pythonRelPath() {
  return process.platform === "win32"
    ? path.join(process.platform, "python", "python.exe")
    : path.join(process.platform, "python", "bin", "python3");
}

function resourcesDir() {
  const isPackaged = app && typeof app.isPackaged === "boolean" ? app.isPackaged : false;
  return isPackaged
    ? path.join(process.resourcesPath, "light-cli")
    : path.join(__dirname, "..", "..", "resources", "light-cli");
}

function resolveLightCommand(script = RUN_LIGHT_SCRIPT) {
  if (process.env.LTM_LIGHT_PATH) {
    if (script !== RUN_LIGHT_SCRIPT) return null;
    return { command: process.env.LTM_LIGHT_PATH, args: [], bundled: false };
  }

  const dir = resourcesDir();
  const python = path.join(dir, pythonRelPath());
  const runner = path.join(dir, script);
  if (fs.existsSync(python) && fs.existsSync(runner)) {
    return { command: python, args: ["-I", runner], bundled: true };
  }

  if (script !== RUN_LIGHT_SCRIPT) return null;
  const fallback = process.platform === "win32" ? "light.exe" : "light";
  return { command: fallback, args: [], bundled: false };
}

module.exports = { resolveLightCommand, RUN_LIGHT_SCRIPT, NOTES_SCRIPT };

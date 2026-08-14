"use strict";

// Wraps the `light` CLI (github.com/garado/light) — Light Account sign-in,
// device listing, and podcast management. This app bundles its own copy
// (see lightPath.js and scripts/fetch-light-cli.js) rather than depending on
// one being installed on the user's machine. Every read command (`devices
// list`, `podcasts list`) is run with `--json`, added in the CLI's 0.3.0
// release — each prints one JSON object of the shape `{ data: [...], error:
// string|null }` on stdout instead of a `rich`-drawn table, so there's no
// more need to scrape box-drawing-separated columns out of human-readable
// output. Write commands (`login`, `logout`, `podcasts add/delete`) have no
// output this module needs to parse and are run without `--json`.
//
// `error` can come back populated instead of (or alongside) a non-zero exit
// — e.g. the "which device did you mean" ambiguity on a multi-device
// account — so runJson() below checks stdout for that shape both on success
// and on a failed exec, rather than assuming a clean exit is the only way to
// get a usable JSON response.
//
// Credential handling: the CLI accepts a password three ways — env var,
// `--password=...` on argv, or `--password-file <path>`. Argv is never used
// here, because process arguments are visible to any other process on the
// machine (`ps`/Task Manager, e.g.) for as long as this one runs. Instead,
// the email/password are written to a private temp file per login attempt,
// passed via `--email-file`/`--password-file`, and deleted immediately
// afterward in a `finally` — so the plaintext only ever touches disk
// briefly, in a file no other user account can read. The password is never
// persisted anywhere (not in store.js, not in the temp file after login
// completes) and never logged. Once logged in, the CLI caches its own auth
// token itself (good for ~30 days per its README) — this module never reads
// or stores that token; every call after login simply re-invokes `light`
// and lets it use its own cache.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { resolveLightCommand, NOTES_SCRIPT } = require("./lightPath");

// `stdin`, when given, is written to the child and the pipe closed right
// away — needed for commands like `podcasts delete`, which ask
// `click.confirm("Unfollow?")` on stdin before doing anything and have no
// --yes/-f flag to skip it. This module only ever calls that after already
// asking the user to confirm in the UI (see podcastsDelete), so answering
// "y" here isn't skipping a real confirmation — it's just relaying the one
// that already happened.
function run(args, opts = {}) {
  const resolved = resolveLightCommand(opts.script);
  if (!resolved) {
    return Promise.reject(new Error("Notes need the bundled Light CLI runtime, which is missing here. Try reinstalling Light Phone Manager."));
  }
  const { command, args: baseArgs } = resolved;
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...baseArgs, ...args],
      {
        timeout: opts.timeout || 30000,
        // NO_COLOR keeps ANSI escapes out of error text; PYTHONIOENCODING/
        // PYTHONUTF8 keep non-ASCII podcast titles etc. intact in JSON output.
        env: { ...process.env, NO_COLOR: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error((stderr && stderr.trim()) || (stdout && stdout.trim()) || err.message);
          e.code = err.code;
          e.stdout = stdout;
          e.stderr = stderr;
          return reject(e);
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      }
    );
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Shared by runJson() (run_light.py --json) and runNotesJson() (notes_cli.py,
// which always prints JSON, no flag needed): both print one
// `{"data": ..., "error": string|null}` object to stdout, on success or
// failure alike, so a populated `error` field is raised as an Error the same
// way whether the process exited cleanly or not — every caller below gets to
// handle both with one catch.
async function runJsonResult(runPromise) {
  let stdout;
  try {
    ({ stdout } = await runPromise);
  } catch (err) {
    const parsed = tryParseJson(err.stdout);
    if (parsed && parsed.error) {
      const e = new Error(parsed.error);
      e.code = err.code;
      throw e;
    }
    // A `light` older than 0.3.0 (--json was added there) rejects the flag
    // outright with a Click usage error rather than an {data,error} JSON
    // body. The bundled copy is always pinned to a >=0.3.0 version (see
    // scripts/fetch-light-cli.js), so this normally only means an
    // LTM_LIGHT_PATH override points at a stale system install — surface
    // that as a clear hint instead of the raw CLI usage text.
    if (/no such option.*--json/i.test(err.message)) {
      const e = new Error('The Light CLI at LTM_LIGHT_PATH is out of date (needs light-phone-cli-tui>=0.3.0 for --json support) — update it, or unset LTM_LIGHT_PATH to use the bundled copy.');
      e.code = err.code;
      throw e;
    }
    throw err;
  }
  const parsed = tryParseJson(stdout);
  if (!parsed) throw new Error(`Couldn't parse JSON from the light CLI: ${stdout.slice(0, 200)}`);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.data;
}

// Runs a read command with `--json` appended and returns its `data` array.
async function runJson(args) {
  const data = await runJsonResult(run([...args, "--json"]));
  return data || [];
}

// Runs a notes_cli.py command (see lightPath.js) and returns its `data`.
async function runNotesJson(args) {
  return runJsonResult(run(args, { script: NOTES_SCRIPT }));
}

// `rich` reports "can't tell which device you mean" as an error rather than
// a normal listing, but it conveniently lists the candidate ids right there
// — e.g. "Available device ids: <id1>, <id2>". This pulls those back out so
// a login that hits this on a multi-device account doesn't have to be
// treated as a failure.
function extractDeviceIdsFromError(message) {
  const match = String(message || "").match(/Available device ids:\s*([^\n]+)/i);
  if (!match) return [];
  return Array.from(
    new Set(
      match[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

function mapDevices(data) {
  return data.map((d) => ({
    deviceId: d.id || "",
    phoneNumber: d.phone_number || "",
    serialNumber: d.serial_number || "",
    sku: d.sku || "",
  }));
}

// An account can end up with more than one device *record* pointing at the
// same physical phone (e.g. a re-pairing that got a fresh device id instead
// of reusing the old one) — that shows up as visually identical duplicate
// rows in the device picker. Collapse those down to one entry per physical
// device, keyed by whatever actually identifies the phone (serial number,
// falling back to phone number, falling back to the device id itself so a
// row is never silently dropped just because both are blank).
function dedupeDevices(devices) {
  const seen = new Set();
  return devices.filter((d) => {
    const key = d.serialNumber || d.phoneNumber || d.deviceId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// notes_cli.py already returns camelCase keys (it's this app's own script,
// not the `light` CLI's own JSON shape), so this is just a light normalize —
// `content` is only present for get/create/update, never for list.
function mapNote(n) {
  const note = { id: n.id || "", title: n.title || "", noteType: n.noteType || "text", updatedAt: n.updatedAt || "" };
  if (n.content != null) note.content = n.content;
  if (n.preview !== undefined) note.preview = n.preview || "";
  return note;
}

function mapPodcasts(data) {
  const podcasts = data.map((p) => ({ index: p.podcast_id || "", title: p.title || "", publisher: p.publisher || "" }));
  // The CLI lists these in whatever order the account followed them in —
  // always show them alphabetically instead, regardless of caller.
  return podcasts.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

function deviceArgs(selector) {
  if (selector && selector.deviceId) return ["--device-id", selector.deviceId];
  if (selector && selector.phoneNumber) return ["--phone-number", selector.phoneNumber];
  return [];
}

// Writes email/password to a private temp file for the duration of one CLI
// call, then always deletes them — see the security note at the top of this
// file for why files (not argv, not a long-lived env var) are used here.
async function withCredFiles(email, password, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `light-cli-${crypto.randomBytes(4).toString("hex")}-`));
  const emailFile = path.join(dir, "email");
  const passwordFile = path.join(dir, "password");
  try {
    fs.writeFileSync(emailFile, email, { mode: 0o600 });
    fs.writeFileSync(passwordFile, password, { mode: 0o600 });
    return await fn(["--email-file", emailFile, "--password-file", passwordFile]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `devices list` needs one specific device picked once an account has more
// than one — it's not just a listing command, despite the name — so the
// ambiguity error is what a multi-device account actually looks like both
// for "am I logged in" (status) and for a fresh login. Once that error's
// ids are in hand, each one can be listed individually (which isn't
// ambiguous) to fill in its phone number/serial/SKU for the UI. `credArgs`
// is passed through here too, in case the very first call in a fresh login
// is the one that hits this — the device-specific follow-ups still need
// those same credentials, since nothing's cached them yet at that point.
async function resolveAmbiguousDevices(deviceIds, credArgs = []) {
  const devices = [];
  for (const deviceId of deviceIds) {
    try {
      const data = await runJson([...credArgs, "--device-id", deviceId, "devices", "list"]);
      devices.push(mapDevices(data)[0] || { deviceId, phoneNumber: "", serialNumber: "", sku: "" });
    } catch {
      devices.push({ deviceId, phoneNumber: "", serialNumber: "", sku: "" });
    }
  }
  return dedupeDevices(devices);
}

// Checks whether `light` is installed and currently signed in, without ever
// supplying credentials — a bare `devices list` succeeds (or fails with the
// multi-device ambiguity error, which only happens post-auth) only if the
// CLI still has a cached, unexpired token from an earlier login.
async function status() {
  try {
    const data = await runJson(["devices", "list"]);
    return { installed: true, loggedIn: true, devices: dedupeDevices(mapDevices(data)), error: null };
  } catch (err) {
    if (err.code === "ENOENT") {
      // Only reachable here if the bundled copy is missing (a broken
      // install) or LTM_LIGHT_PATH points nowhere — normal packaged builds
      // and dev checkouts that have run `npm run fetch-light-cli` ship
      // their own copy and never touch PATH at all (see lightPath.js).
      return { installed: false, loggedIn: false, devices: [], error: "Bundled Light CLI is missing or broken, and no \"light\" found on PATH." };
    }
    const ambiguousIds = extractDeviceIdsFromError(err.message);
    if (ambiguousIds.length > 0) {
      return { installed: true, loggedIn: true, devices: await resolveAmbiguousDevices(ambiguousIds), error: null };
    }
    return { installed: true, loggedIn: false, devices: [], error: err.message };
  }
}

// Verifies email/password by listing the account's devices with them, which
// also causes the CLI to cache its auth token for later, credential-free
// calls. Never returns or persists the password.
async function login(email, password) {
  return withCredFiles(email, password, async (credArgs) => {
    try {
      const data = await runJson([...credArgs, "devices", "list"]);
      return dedupeDevices(mapDevices(data));
    } catch (err) {
      const ambiguousIds = extractDeviceIdsFromError(err.message);
      if (ambiguousIds.length === 0) throw err;
      return resolveAmbiguousDevices(ambiguousIds, credArgs);
    }
  });
}

async function logout() {
  await run(["logout"]);
}

async function podcastsList(selector) {
  const data = await runJson([...deviceArgs(selector), "podcasts", "list"]);
  return mapPodcasts(data);
}

async function podcastsAdd(rssUrl, selector) {
  await run([...deviceArgs(selector), "podcasts", "add", rssUrl]);
}

async function podcastsDelete(title, selector) {
  await run([...deviceArgs(selector), "podcasts", "delete", title], { stdin: "y\n" });
}

// Metadata only (title/type/updated-at) — no preview, no content — to keep
// a full list fetch fast. Most-recently-updated first, matching the Light
// device's own Notes app ordering. See notesListPreviews for why previews
// are a separate, slower call rather than a flag on this one.
async function notesList(selector) {
  const data = await runNotesJson([...deviceArgs(selector), "list"]);
  return (data || []).map(mapNote).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

// One-line content previews, same order as notesList. Each preview needs
// its own presigned-URL fetch + HTTP GET (there's no bulk/inline way to get
// note content from Light's API — the CLI's own `--content-preview` does
// the same N+1 and warns "this might take a while"), so for an account
// with even a modest number of notes this can take several seconds —
// callers should render notesList()'s fast result first and merge this in
// once it resolves, not block on it.
async function notesListPreviews(selector) {
  const data = await runNotesJson([...deviceArgs(selector), "list", "--preview"]);
  return (data || []).map(mapNote);
}

// Metadata + content (decoded as UTF-8 text; omitted for audio notes — see
// notes_cli.py).
async function notesGet(noteId, selector) {
  const data = await runNotesJson([...deviceArgs(selector), "get", noteId]);
  return mapNote(data);
}

async function notesCreate(title, content, selector) {
  const args = [...deviceArgs(selector), "create", "--title", title];
  if (content != null) args.push("--content", content);
  const data = await runNotesJson(args);
  return mapNote(data);
}

// `title`/`content` are each independently optional — only the ones present
// (non-null) get updated, so e.g. saving just a title edit doesn't also
// overwrite the content with whatever was last fetched.
async function notesUpdate(noteId, { title, content } = {}, selector) {
  const args = [...deviceArgs(selector), "update", noteId];
  if (title != null) args.push("--title", title);
  if (content != null) args.push("--content", content);
  const data = await runNotesJson(args);
  return mapNote(data);
}

async function notesDelete(noteId, selector) {
  await runNotesJson([...deviceArgs(selector), "delete", noteId]);
}

module.exports = {
  status,
  login,
  logout,
  podcastsList,
  podcastsAdd,
  podcastsDelete,
  notesList,
  notesListPreviews,
  notesGet,
  notesCreate,
  notesUpdate,
  notesDelete,
};

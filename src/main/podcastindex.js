"use strict";

const crypto = require("crypto");

// The API key/secret are never committed — see .gitignore and
// scripts/generate-podcastindex-key.js. Release builds get theirs baked in
// at package time by that script, run from CI with the key/secret pulled out
// of repo secrets (see .github/workflows/build.yml); it writes the generated
// file this require() picks up, which is why it can be a plain require
// (no async fs read) even though it's optional. A fresh checkout that hasn't
// run the script yet just doesn't have the file, so this falls through to
// env vars — handy for `npm start` during local development without having
// to run the generator first.
let generated = {};
try {
  generated = require("./podcastindex-credentials.generated.json");
} catch {
  // Not generated — fall through to env vars below.
}

const API_KEY = (generated && generated.apiKey) || process.env.PODCASTINDEX_API_KEY || "";
const API_SECRET = (generated && generated.apiSecret) || process.env.PODCASTINDEX_API_SECRET || "";

const API_ROOT = "https://api.podcastindex.org/api/1.0";

function isConfigured() {
  return !!(API_KEY && API_SECRET);
}

// Runs once at startup, in the main process's own console (not sent to the
// renderer) — a 401 from PodcastIndex is indistinguishable at the network
// level between "wrong credentials" and "env vars never actually reached
// this process" (stale terminal, IDE launch config missing them, etc.), so
// this at least confirms which of those it is without printing the secret.
if (API_KEY || API_SECRET) {
  const mask = (s) => (s.length > 4 ? `${s.slice(0, 4)}…(${s.length} chars)` : `(${s.length} chars)`);
  console.log(`[podcastindex] Loaded API key ${mask(API_KEY)} / secret ${mask(API_SECRET)}${generated.apiKey ? " (from generated file)" : " (from env vars)"}.`);
} else {
  console.log("[podcastindex] No PODCASTINDEX_API_KEY/PODCASTINDEX_API_SECRET found — podcast search is disabled.");
}

// PodcastIndex's auth scheme: sha1(apiKey + apiSecret + unixTime), sent
// alongside the raw key and the timestamp it was hashed with — see
// https://podcastindex-org.github.io/docs-api/#overview--authentication-details
function authHeaders() {
  const authDate = Math.floor(Date.now() / 1000).toString();
  const authHash = crypto.createHash("sha1").update(API_KEY + API_SECRET + authDate).digest("hex");
  // authDate is logged (not the hash/key/secret) so a 401 caused by clock
  // skew is distinguishable from one caused by wrong credentials — compare
  // the printed timestamp against `[System.Environment]::UtcNow` (or just
  // real UTC time) if search keeps failing after credentials are confirmed.
  console.log(`[podcastindex] Signing request with X-Auth-Date=${authDate} (${new Date(Number(authDate) * 1000).toISOString()}).`);
  return {
    "User-Agent": "LightPhoneManager/1.0",
    "X-Auth-Date": authDate,
    "X-Auth-Key": API_KEY,
    Authorization: authHash,
  };
}

async function searchByTerm(term) {
  if (!isConfigured()) throw new Error("Podcast search isn't set up for this build — add a podcast by its RSS feed URL instead.");
  const res = await fetch(`${API_ROOT}/search/byterm?q=${encodeURIComponent(term)}&max=25`, { headers: authHeaders() });
  if (!res.ok) {
    // Read as text first (the body can only be consumed once) and try to
    // parse it as PodcastIndex's usual { description: "..." } shape; if it's
    // not JSON at all (an edge proxy's plain-text/HTML error page, say),
    // fall back to showing the raw text so there's still something to go on
    // beyond the bare status code.
    const bodyText = await res.text().catch(() => "");
    let description = null;
    try {
      description = JSON.parse(bodyText).description || null;
    } catch {
      // Not JSON — bodyText itself is the fallback below.
    }
    console.log(`[podcastindex] ${res.status} response body: ${bodyText.slice(0, 500) || "(empty)"}`);
    throw new Error(`Podcast search failed (${res.status})${description ? `: ${description}` : bodyText ? `: ${bodyText.slice(0, 200)}` : ""}.`);
  }
  const data = await res.json();
  return (data.feeds || []).map((f) => ({
    id: f.id,
    title: f.title || "",
    author: f.author || "",
    feedUrl: f.url || "",
    artwork: f.artwork || f.image || "",
    description: f.description || "",
  }));
}

module.exports = { isConfigured, searchByTerm };

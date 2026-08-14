"use strict";

// Writes the PodcastIndex API credentials src/main/podcastindex.js loads at
// runtime, sourced from PODCASTINDEX_API_KEY / PODCASTINDEX_API_SECRET in the
// environment. Run by CI (see .github/workflows/build.yml, which populates
// those from repo secrets) before packaging, and wired into each `dist:*`
// script so a plain `npm run dist:win` etc. still produces a working build.
//
// The output file is gitignored — it holds a real credential and must never
// reach source control. If the env vars aren't set (e.g. a fresh contributor
// checkout with no access to the project's secrets), this still writes a
// file with empty values so the app has something to require(); podcast
// search just reports itself as unconfigured and the app falls back to
// "add by RSS feed URL" instead of failing to build.
const fs = require("fs");
const path = require("path");

const apiKey = process.env.PODCASTINDEX_API_KEY || "";
const apiSecret = process.env.PODCASTINDEX_API_SECRET || "";
const outPath = path.join(__dirname, "..", "src", "main", "podcastindex-credentials.generated.json");

fs.writeFileSync(outPath, `${JSON.stringify({ apiKey, apiSecret }, null, 2)}\n`);
console.log(apiKey && apiSecret ? "Wrote PodcastIndex credentials." : "No PODCASTINDEX_API_KEY/PODCASTINDEX_API_SECRET set — podcast search will be unavailable in this build.");

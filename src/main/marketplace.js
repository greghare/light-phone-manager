"use strict";

// Fetches the community app catalog for the Marketplace tab from
// awesome-light (garado.dev) — a third-party, unofficial directory of Light
// Phone tools, unrelated to Light itself. Schema: https://awesome-light.garado.dev/apps.schema.json
const INDEX_URL = "https://awesome-light.garado.dev/apps/index.json";

// The renderer can't fetch this directly (CSP's default-src 'self' blocks
// it — see index.html), so it's fetched here in the main process and handed
// over via IPC instead, same as GitHub/Apple Search API calls.
let cache = null; // { apps, fetchedAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

function mapApp(a) {
  const latest = a.latest_release || {};
  return {
    slug: a.slug || "",
    title: a.title || "",
    permalink: a.permalink || "",
    author: a.author || "",
    authorUrl: a.author_url || "",
    dateAdded: a.date_added || "",
    category: a.category || "",
    description: a.description || "",
    content: a.content || "",
    repo: a.repo || "",
    download: a.download || "",
    badges: a.badges || [],
    latestRelease: { version: latest.version || "", date: latest.date || "", url: latest.url || "" },
    images: a.images || [],
    videos: a.videos || [],
  };
}

async function fetchApps({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.apps;
  const res = await fetch(INDEX_URL, { headers: { "User-Agent": "LightPhoneManager/1.0" } });
  if (!res.ok) throw new Error(`Couldn't load the Marketplace listing (${res.status}).`);
  const data = await res.json();
  const apps = (data.apps || []).map(mapApp);
  cache = { apps, fetchedAt: Date.now() };
  return apps;
}

module.exports = { fetchApps };

"use strict";

// Podcast search backs the Add Podcast screen with Apple's iTunes Search
// API (documented for podcast publishers at
// https://performance-partners.apple.com/search-api). Unlike PodcastIndex,
// it's a plain unauthenticated GET — no API key/secret, nothing to bake in
// at build time — so this module has no credentials setup and search is
// always available.
const API_ROOT = "https://itunes.apple.com";

function isConfigured() {
  return true;
}

async function searchByTerm(term) {
  const url = `${API_ROOT}/search?entity=podcast&limit=25&term=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.log(`[applepodcasts] ${res.status} response body: ${bodyText.slice(0, 500) || "(empty)"}`);
    throw new Error(`Podcast search failed (${res.status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}.`);
  }
  const data = await res.json();
  return (data.results || []).map((r) => ({
    id: r.collectionId,
    title: r.collectionName || "",
    author: r.artistName || "",
    feedUrl: r.feedUrl || "",
    artwork: r.artworkUrl600 || r.artworkUrl100 || "",
    // The Search API doesn't return a description for podcast results
    // (that lives in the feed itself, fetched once a podcast is added).
    description: "",
  }));
}

module.exports = { isConfigured, searchByTerm };

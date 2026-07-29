"use strict";

const API_ROOT = "https://api.github.com";

function parseRepoUrl(input) {
  if (!input) return null;
  let s = input.trim();
  s = s.replace(/^git\+/, "").replace(/\.git$/, "");
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.replace(/^github\.com\//, "");
  s = s.replace(/^\/+|\/+$/g, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  return { owner, repo };
}

function authHeaders(token) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "light-phone-tool-manager" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function apiGet(pathname, token) {
  const res = await fetch(`${API_ROOT}${pathname}`, { headers: authHeaders(token) });
  if (!res.ok) {
    if (res.status === 404) throw new Error("Repository not found on GitHub.");
    if (res.status === 403) throw new Error("GitHub API rate limit hit. Try again later, or add a token in settings.");
    throw new Error(`GitHub API error (${res.status}) for ${pathname}`);
  }
  return res.json();
}

async function fetchRepoMeta(owner, repo, token) {
  const data = await apiGet(`/repos/${owner}/${repo}`, token);
  return {
    description: data.description || "",
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch,
  };
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function fetchReleases(owner, repo, token) {
  const data = await apiGet(`/repos/${owner}/${repo}/releases?per_page=15`, token);
  return data
    .filter((r) => !r.draft)
    .map((r) => {
      const apkAssets = (r.assets || [])
        .filter((a) => /\.apk$/i.test(a.name))
        .sort((a, b) => Number(/debug/i.test(a.name)) - Number(/debug/i.test(b.name)));
      const apkAsset = apkAssets[0] || null;
      return {
        version: r.tag_name || r.name || "unknown",
        name: r.name || r.tag_name,
        date: formatDate(r.published_at || r.created_at),
        publishedAt: r.published_at || r.created_at,
        prerelease: !!r.prerelease,
        apkAsset: apkAsset ? { name: apkAsset.name, url: apkAsset.browser_download_url, size: apkAsset.size } : null,
        apkAssetCount: apkAssets.length,
      };
    });
}

async function downloadAsset(url, destPath, token) {
  const fs = require("fs");
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Failed to download asset (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

module.exports = { parseRepoUrl, fetchRepoMeta, fetchReleases, downloadAsset };

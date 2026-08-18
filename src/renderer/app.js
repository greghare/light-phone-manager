"use strict";

/* ---------- tiny helpers ---------- */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function initial(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function formatBytes(bytes) {
  if (bytes == null) return null;
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

// GitHub release tags are usually "v1.2.3" but the versionName installed on
// the device is just "1.2.3" — ignore a leading "v" so that doesn't read as
// an available update.
function versionsEqual(a, b) {
  if (a == null || b == null) return false;
  const norm = (s) => String(s).trim().replace(/^v/i, "");
  return norm(a) === norm(b);
}

// Releases are listed newest-published-first, but "most recently published"
// isn't the same as "highest version" — a lower-numbered stable release can
// go out after a higher-numbered beta (e.g. v1.4.0 published after someone
// already sideloaded v2.0.0-beta.2). Comparing numerically here, instead of
// just checking inequality, keeps that from reading as an "update available"
// (or worse, offering to install it as one and quietly downgrading).
function parseVersion(v) {
  const s = String(v).trim().replace(/^v/i, "");
  const hyphen = s.indexOf("-");
  const main = hyphen === -1 ? s : s.slice(0, hyphen);
  const pre = hyphen === -1 ? null : s.slice(hyphen + 1);
  return { parts: main.split(".").map((p) => parseInt(p, 10) || 0), pre };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // Equal numeric version: a prerelease (has a "-" suffix) ranks below its
  // corresponding release, per semver precedence rules.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre.localeCompare(pb.pre);
  return 0;
}

function isVersionNewer(candidate, base) {
  if (candidate == null || base == null) return false;
  return compareVersions(candidate, base) > 0;
}

// GitHub tags can be named almost anything ("chess-v1.0.0-alpha") and don't
// have to resemble the tool's actual versionName at all, so tag-stripping
// alone can't reliably tell "up to date" from "update available". Once we've
// had a reason to download+parse a release's APK (adding the repo, or
// installing/updating to it), trueVersion holds its real internal version —
// prefer that for comparisons, and only fall back to the raw tag otherwise.
function releaseVersion(rel) {
  return (rel && (rel.trueVersion || rel.version)) || null;
}

function releaseUrl(repo, rel) {
  if (!repo.repoUrl) return null;
  return `${repo.repoUrl}/releases/tag/${encodeURIComponent(rel.version)}`;
}

// Repos have a real author (the GitHub owner); sideloaded/on-device tools
// don't, so just show the category on its own ("On Device") rather than a
// second made-up "author" next to it. Ignores whatever's in r.author for
// these regardless — older versions of this tool did store a fake one there.
function byline(r) {
  return r.sideloaded ? r.category : `${r.author} · ${r.category}`;
}

function avatar(r, size) {
  const radius = Math.round(size * 0.25);
  if (r.icon) {
    return `<img src="${esc(r.icon)}" style="width:${size}px;height:${size}px;border-radius:${radius}px;object-fit:cover;flex-shrink:0;border:1px solid rgba(255,255,255,0.1)">`;
  }
  return `<div style="width:${size}px;height:${size}px;flex-shrink:0;border-radius:${radius}px;border:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.4)}px;font-weight:600;color:rgba(255,255,255,0.7)">${esc(initial(r.name))}</div>`;
}

/* ---------- state ---------- */

const state = {
  device: { status: "none", serial: null, model: null, androidVersion: null, freeBytes: null, totalBytes: null },
  section: "tools", // "tools" | "media" | "install" | "settings" | "ringtones" | "podcasts" | "notes" | "about"
  repos: [],
  nav: "repos",
  category: "all",
  selectedId: null,
  showAddRepo: false,
  addRepoUrl: "",
  addRepoBusy: false,
  drop: null, // { filePath, parsed, matchId }
  dropBusy: false,
  toast: null,
  logOpen: {}, // id -> bool
  logs: {}, // id -> string[]
  activeRepoId: null,
  activeLabel: "",
  updateAllRunning: false,
  windowMaximized: false,
  mediaKey: "photos", // "photos" | "screenshots" | "zero" | "videos"
  mediaTypes: [], // [{ key, label, kind, devicePath }]
  media: { photos: [], screenshots: [], zero: [], videos: [] },
  mediaBackupDir: "",
  backupRunning: false,
  deviceRefreshing: false,
  deviceRebooting: false,
  lightboxIndex: null,
  confirmDialog: null, // { message, confirmLabel, danger }
  contextMenu: null, // { x, y, repoId }
  appLogs: null, // { repoId, lines: string[], loading, error }
  osSettings: { animationsOn: null, showExternalTools: null, chromiumAvailable: null, chromiumHidden: null }, // null = unknown (no device connected yet)
  osSettingsBusy: {}, // { animations?: bool, showExternalTools?: bool, chromium?: bool }
  osSettingsBaseline: null, // { animationsOn, showExternalTools } as first observed this device connection — the value LightOS is actually running with until a reboot
  ringtones: { ringtones: [], alerts: [] },
  ringtonesLoading: false,
  ringtoneBusy: {}, // remoteFilename -> bool ("uploading"/"restoring")
  ringtonePlayLoading: {}, // remoteFilename -> bool (pulling the file to play it)
  playingRingtone: null, // remoteFilename currently playing, or null

  podcasts: [], // [{ index, title, publisher }]
  podcastsLoading: false,
  podcastBusy: {}, // title -> bool
  showAddPodcast: false,
  addPodcastMode: "search", // "search" | "rss"
  addPodcastUrl: "",
  addPodcastBusy: false,
  podcastSearchAvailable: null, // null = not checked yet; set once at boot from podcasts:searchAvailable
  podcastSearchQuery: "",
  podcastSearchLoading: false,
  podcastSearchResults: [], // [{ id, title, author, feedUrl, artwork, description }]
  podcastSearchError: null,
  podcastSearchAddBusy: {}, // feedUrl -> bool

  notes: [], // [{ id, title, noteType, updatedAt, preview }]
  notesLoading: false,
  selectedNoteId: null, // a real note's id, or NEW_NOTE_ID for an unsaved draft (see actions.addNote)
  noteDetail: null, // last-saved-state of the open note: { id, title, noteType, updatedAt, content }
  noteDetailLoading: false,
  noteEditTitle: "", // live-edited copies bound to the title/content fields —
  noteEditContent: "", // diffed against noteDetail to tell whether Save has anything to do
  noteSaving: false,
  noteBusy: {}, // id -> bool (deleting)
  noteContextMenu: null, // { x, y, noteId }

  // null fields = not checked yet (status hasn't come back from the CLI).
  light: { installed: null, loggedIn: null, devices: [], selectedDeviceId: null, error: null },
  lightEmail: "",
  lightPassword: "",
  lightLoginBusy: false,
  lightLoginError: null,
  lightDeviceSelectBusy: false,
  lightLogoutBusy: false,
};

// One shared <audio> element for previewing ringtones/alerts — reused across
// rows rather than creating a new one per row, so starting a new preview
// always stops whatever was already playing.
const ringtoneAudio = new Audio();
ringtoneAudio.addEventListener("ended", () => setState({ playingRingtone: null }));

let pendingConfirm = null;

function openConfirm({ message, confirmLabel, danger, run }) {
  pendingConfirm = run;
  setState({ confirmDialog: { message, confirmLabel, danger } });
}

let toastTimer = null;
function showToast(message) {
  state.toast = message;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 3200);
}

function setState(patch) {
  Object.assign(state, patch);
  render();
}

/* ---------- derived view model ---------- */

// "Repos" only ever means things actually tracked from a GitHub repo —
// tools found already on the phone or dragged in as a raw APK belong under
// "Installed" (once installed) instead, not mixed into the repo list.
function toolsBaseList() {
  return state.repos.filter((r) => !r.sideloaded);
}

function deriveCategories() {
  const baseForCounts = state.nav === "installed" ? state.repos.filter((r) => r.installedVersion) : toolsBaseList();
  const uniqueCats = Array.from(new Set(state.repos.map((r) => r.category)));
  return [{ key: "all", label: "All" }, ...uniqueCats.map((c) => ({ key: c, label: c }))]
    .map((c) => ({
      key: c.key,
      label: c.label,
      count: c.key === "all" ? baseForCounts.length : baseForCounts.filter((r) => r.category === c.key).length,
    }))
    .filter((c) => c.key === "all" || c.count > 0);
}

function deriveList() {
  let list = state.nav === "installed" ? state.repos.filter((r) => r.installedVersion) : toolsBaseList();
  if (state.category !== "all") list = list.filter((r) => r.category === state.category);
  return list.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function repoStatus(r) {
  const latest = r.releases && r.releases[0];
  const updateAvailable = !!r.installedVersion && latest && isVersionNewer(releaseVersion(latest), r.installedVersion);
  return { latest, updateAvailable };
}

/* ---------- rendering ---------- */

function renderTopBar() {
  const d = state.device;
  const dotColor = d.status === "connected" ? "#34c759" : d.status === "none" ? "rgba(255,255,255,0.25)" : "#f5a623";
  let statusText;
  if (d.status === "connected") {
    const parts = [`Connected via USB`];
    if (d.androidVersion) parts.push(`Android ${d.androidVersion}`);
    const free = formatBytes(d.freeBytes);
    if (free) parts.push(`${free} free`);
    statusText = parts.join(" · ");
  } else if (d.status === "unauthorized") {
    statusText = "Unauthorized — check the phone's screen to allow USB debugging";
  } else if (d.status === "multiple") {
    statusText = "Multiple devices connected — disconnect the others";
  } else if (d.status === "error") {
    statusText = "Couldn't reach adb — is it installed?";
  } else {
    statusText = "Not connected — plug in your Light Phone 3";
  }

  const updatable = state.repos.filter((r) => {
    const { latest, updateAvailable } = repoStatus(r);
    return updateAvailable && latest.apkAsset;
  });

  const maximizeGlyph = state.windowMaximized ? "❐" : "▢";
  const maximizeTitle = state.windowMaximized ? "Restore" : "Maximize";

  return `
  <div data-titlebar style="height:48px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding-left:16px;-webkit-app-region:drag">
    <div style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${dotColor}"></div>
    <div style="font-size:14px;font-weight:500;color:#fff;white-space:nowrap">Light Phone 3</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.45);white-space:nowrap">${esc(statusText)}</div>
    <div style="flex:1"></div>
    <div style="display:flex;align-items:center;gap:8px;-webkit-app-region:no-drag;padding-right:10px">
      ${
        updatable.length > 0
          ? `<button data-action="updateAll" style="background:transparent;border:1px solid rgba(245,166,35,0.5);color:#f5a623;font-size:12px;font-weight:600;padding:6px 12px;border-radius:6px;cursor:pointer" ${state.updateAllRunning ? "disabled" : ""}>${state.updateAllRunning ? "Updating…" : `Update all (${updatable.length})`}</button>`
          : ""
      }
      ${
        d.status === "connected"
          ? `<button data-action="rebootDevice" ${state.deviceRebooting ? "disabled" : ""} style="background:transparent;border:none;color:rgba(255,255,255,0.4);font-size:12px;cursor:${state.deviceRebooting ? "default" : "pointer"};text-decoration:underline;padding:0">${state.deviceRebooting ? "Rebooting…" : "Reboot"}</button>`
          : ""
      }
      <button data-action="refreshDevice" ${state.deviceRefreshing ? "disabled" : ""} style="background:transparent;border:none;color:rgba(255,255,255,0.4);font-size:12px;cursor:${state.deviceRefreshing ? "default" : "pointer"};text-decoration:underline;padding:0">${state.deviceRefreshing ? "Refreshing…" : "Refresh"}</button>
    </div>
    <div style="display:flex;height:100%">
      <button data-action="winMinimize" title="Minimize" class="winbtn">&#8722;</button>
      <button data-action="winMaximize" title="${maximizeTitle}" class="winbtn" style="font-size:11px">${maximizeGlyph}</button>
      <button data-action="winClose" title="Close" class="winbtn close">&#10005;</button>
    </div>
  </div>`;
}

function renderSidebar() {
  const categories = deriveCategories();
  return `
  <div style="width:230px;flex-shrink:0;padding:20px 0;display:flex;flex-direction:column;gap:4px;overflow-y:auto">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);padding:0 22px;margin-bottom:12px">Tools</div>
    <div data-action="openAddRepo" style="display:flex;align-items:center;gap:8px;padding:6px 22px;font-size:15px;font-weight:700;color:#fff;cursor:pointer;margin-bottom:18px">
      <span style="font-size:19px;line-height:1;font-weight:400">+</span> Add Repo
    </div>
    <div data-action="selectNav" data-nav="repos" style="display:flex;align-items:center;justify-content:space-between;padding:6px 22px;cursor:pointer">
      <span style="font-size:15px;font-weight:700;color:${state.section === "tools" && state.nav === "repos" ? "#fff" : "rgba(255,255,255,0.55)"};text-decoration:${state.section === "tools" && state.nav === "repos" ? "underline" : "none"}">Repos</span>
      <span style="font-size:12px;color:rgba(255,255,255,0.3)">${toolsBaseList().length}</span>
    </div>
    <div data-action="selectNav" data-nav="installed" style="display:flex;align-items:center;justify-content:space-between;padding:6px 22px;cursor:pointer;margin-bottom:20px">
      <span style="font-size:15px;font-weight:700;color:${state.section === "tools" && state.nav === "installed" ? "#fff" : "rgba(255,255,255,0.55)"};text-decoration:${state.section === "tools" && state.nav === "installed" ? "underline" : "none"}">Installed</span>
      <span style="font-size:12px;color:rgba(255,255,255,0.3)">${state.repos.filter((r) => r.installedVersion).length}</span>
    </div>
    ${categories
      .map(
        (c) => `
      <div data-action="selectCategory" data-cat="${esc(c.key)}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 22px;cursor:pointer">
        <span style="font-size:14px;font-weight:600;color:${state.section === "tools" && state.category === c.key ? "#fff" : "rgba(255,255,255,0.45)"}">${esc(c.label)}</span>
        <span style="font-size:12px;color:rgba(255,255,255,0.28)">${c.count}</span>
      </div>`
      )
      .join("")}
    <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);padding:0 22px;margin:28px 0 12px">Media</div>
    ${["photos", "screenshots", "zero", "videos"]
      .map((key) => {
        const type = state.mediaTypes.find((t) => t.key === key);
        // Falls back to a capitalized key before mediaTypes has loaded from
        // the main process (mediaGetSettings is one of the boot() calls,
        // not instant) — every one of these labels is just its key
        // capitalized anyway, so this never visibly changes once it loads.
        const label = type ? type.label : key.charAt(0).toUpperCase() + key.slice(1);
        const active = state.section === "media" && state.mediaKey === key;
        return `
      <div data-action="selectMedia" data-key="${esc(key)}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 22px;cursor:pointer">
        <span style="font-size:15px;font-weight:700;color:${active ? "#fff" : "rgba(255,255,255,0.55)"};text-decoration:${active ? "underline" : "none"}">${esc(label)}</span>
        <span style="font-size:12px;color:rgba(255,255,255,0.3)">${(state.media[key] || []).length}</span>
      </div>`;
      })
      .join("")}
    <div data-action="openPodcasts" style="display:flex;align-items:center;justify-content:space-between;padding:6px 22px;cursor:pointer">
      <span style="font-size:15px;font-weight:700;color:${state.section === "podcasts" ? "#fff" : "rgba(255,255,255,0.55)"};text-decoration:${state.section === "podcasts" ? "underline" : "none"}">Podcasts</span>
      <span style="font-size:12px;color:rgba(255,255,255,0.3)">${state.podcasts.length}</span>
    </div>
    <div data-action="openRingtones" style="display:flex;align-items:center;justify-content:space-between;padding:6px 22px;cursor:pointer">
      <span style="font-size:15px;font-weight:700;color:${state.section === "ringtones" ? "#fff" : "rgba(255,255,255,0.55)"};text-decoration:${state.section === "ringtones" ? "underline" : "none"}">Ringtones &amp; Alerts</span>
    </div>
    <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);padding:0 22px;margin:28px 0 12px">Notes</div>
    <div data-action="openNotes" style="display:flex;align-items:center;justify-content:space-between;padding:6px 22px;cursor:pointer">
      <span style="font-size:15px;font-weight:700;color:${state.section === "notes" ? "#fff" : "rgba(255,255,255,0.55)"};text-decoration:${state.section === "notes" ? "underline" : "none"}">Notes</span>
      <span style="font-size:12px;color:rgba(255,255,255,0.3)">${state.notes.length}</span>
    </div>

    <div style="flex:1"></div>
    <div style="padding:0 22px">
      <div data-action="openInstallView" style="font-size:12px;color:rgba(255,255,255,0.4);cursor:pointer;text-decoration:underline;margin-bottom:14px">Install APK file…</div>
      <div data-action="openSettings" style="display:flex;align-items:center;gap:8px;padding-bottom:16px;font-size:15px;font-weight:700;color:${state.section === "settings" ? "#fff" : "rgba(255,255,255,0.55)"};cursor:pointer">
        ${gearIcon()} Settings
      </div>
      <div data-action="openAbout" style="display:flex;align-items:center;gap:8px;padding-bottom:16px;font-size:15px;font-weight:700;color:${state.section === "about" ? "#fff" : "rgba(255,255,255,0.55)"};cursor:pointer">
        ${infoIcon()} About
      </div>
    </div>
  </div>`;
}

function gearIcon() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>`;
}

function infoIcon() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="12" y1="16" x2="12" y2="11.5"></line>
    <line x1="12" y1="8" x2="12.01" y2="8"></line>
  </svg>`;
}

function renderList() {
  const list = deriveList();
  const items = list
    .map((r) => {
      const { latest, updateAvailable } = repoStatus(r);
      const statusText = r.installedVersion || "Not installed";
      const statusSub = updateAvailable ? `Update → ${esc(latest.version)}` : r.installedVersion ? "Up to date" : "";
      const dotColor = !r.installedVersion ? "rgba(255,255,255,0.25)" : updateAvailable ? "#f5a623" : "#34c759";
      const rowBg = r.id === state.selectedId ? "rgba(255,255,255,0.08)" : "transparent";
      return `
      <div data-action="selectRepo" data-context-repo="${esc(r.id)}" data-id="${esc(r.id)}" style="display:flex;align-items:center;gap:12px;padding:11px 14px;margin:0 10px 2px;border-radius:12px;cursor:pointer;background:${rowBg}">
        ${avatar(r, 36)}
        <div style="flex:1;min-width:0">
          <div style="font-size:16px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px">${esc(byline(r))}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="display:flex;align-items:center;gap:5px;justify-content:flex-end">
            <div style="width:6px;height:6px;border-radius:50%;background:${dotColor}"></div>
            <span style="font-size:13px;color:#fff;font-weight:600">${esc(statusText)}</span>
          </div>
          <div style="font-size:11px;color:rgba(255,255,255,0.35)">${esc(statusSub)}</div>
        </div>
      </div>`;
    })
    .join("");

  return `
  <div style="width:350px;flex-shrink:0;display:flex;flex-direction:column;overflow-y:auto">
    <div style="padding:22px 24px 14px;display:flex;align-items:baseline;gap:8px;flex-shrink:0">
      <div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">${state.nav === "installed" ? "Installed" : "Repos"}</div>
      <div style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.3)">${list.length}</div>
    </div>
    ${items}
    ${list.length === 0 ? `<div style="padding:40px 20px;text-align:center;font-size:13px;color:rgba(255,255,255,0.35)">No tools in this view</div>` : ""}
  </div>`;
}

function renderDetail() {
  const r = state.repos.find((x) => x.id === state.selectedId);
  if (!r) {
    return `
    <div style="flex:1;overflow-y:auto;position:relative">
      <div style="height:100%;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.3);font-size:14px">Select a tool to see details</div>
    </div>`;
  }

  const { latest, updateAvailable } = repoStatus(r);
  const upToDate = !!r.installedVersion && latest && versionsEqual(releaseVersion(latest), r.installedVersion);
  const busy = state.activeRepoId === r.id;
  const notConnected = state.device.status !== "connected";

  let primaryLabel, primaryDisabled;
  if (upToDate) {
    primaryLabel = "Up to date";
    primaryDisabled = true;
  } else if (!latest) {
    primaryLabel = "No releases";
    primaryDisabled = true;
  } else if (!latest.apkAsset) {
    primaryLabel = r.sideloaded ? "Drag the APK in again to reinstall" : "No APK in this release";
    primaryDisabled = true;
  } else if (updateAvailable) {
    primaryLabel = `Update to ${latest.version}`;
    primaryDisabled = busy || notConnected;
  } else {
    primaryLabel = `Install ${latest.version}`;
    primaryDisabled = busy || notConnected;
  }

  const logLines = state.logs[r.id] || [];
  const logOpen = !!state.logOpen[r.id];

  const releasesHtml = (r.releases || [])
    .map((rel) => {
      const isCurrent = versionsEqual(releaseVersion(rel), r.installedVersion);
      const disabled = isCurrent || busy || notConnected || !rel.apkAsset;
      const label = isCurrent ? "Installed" : !rel.apkAsset ? "No APK" : "Install";
      const url = releaseUrl(r, rel);
      const titleHtml = url
        ? `<span data-action="openRepoUrl" data-url="${esc(url)}" style="cursor:pointer;text-decoration:underline">${esc(rel.version)}</span>`
        : esc(rel.version);
      return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0">
        <div>
          <div style="font-size:14px;font-weight:700;color:#fff">${titleHtml}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px">${esc(rel.date)}</div>
        </div>
        <button data-action="installVersion" data-id="${esc(r.id)}" data-version="${esc(rel.version)}" ${disabled ? "disabled" : ""} style="background:${isCurrent ? "transparent" : "#fff"};color:${isCurrent ? "rgba(255,255,255,0.35)" : "#000"};border:1px solid ${isCurrent ? "rgba(255,255,255,0.15)" : "#fff"};border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:${disabled ? "default" : "pointer"}">${label}</button>
      </div>`;
    })
    .join("");

  return `
  <div style="flex:1;overflow-y:auto;position:relative">
    <div style="padding:22px 48px 60px;max-width:640px">
      <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:20px">
        ${avatar(r, 56)}
        <div style="flex:1;min-width:0">
          <div style="font-size:32px;font-weight:500;color:#fff;line-height:1.15;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${r.sideloaded ? esc(r.category) : `${esc(r.author)} · ${esc(r.category)}`}
          </div>
          ${
            !r.sideloaded && r.repoUrl
              ? `<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:2px;overflow-wrap:anywhere"><span data-action="openRepoUrl" data-url="${esc(r.repoUrl)}" style="cursor:pointer;text-decoration:underline">${esc(r.repoUrl)}</span></div>`
              : ""
          }
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
          ${
            r.installedVersion && !busy
              ? `<div data-action="uninstall" data-id="${esc(r.id)}" style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,120,110,0.8);cursor:pointer;white-space:nowrap">UNINSTALL FROM PHONE</div>`
              : ""
          }
          <div data-action="stopTracking" data-id="${esc(r.id)}" style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);cursor:pointer;white-space:nowrap">${r.sideloaded ? "REMOVE FROM LIST" : "STOP TRACKING REPO"}</div>
        </div>
      </div>
      <div style="font-size:14px;color:rgba(255,255,255,0.6);line-height:1.6;margin-bottom:28px">${esc(r.description)}</div>

      <div style="display:flex;flex-direction:column;gap:16px;margin-bottom:24px">
        <div>
          <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:4px">Installed</div>
          <div style="font-size:16px;color:#fff">${esc(r.installedVersion || "Not installed")}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:4px">Latest release</div>
          <div style="font-size:16px;color:#fff">${latest ? `${esc(latest.version)} · ${esc(latest.date)}` : "—"}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:4px">Package</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.55);font-family:'SF Mono',ui-monospace,Menlo,monospace">${esc(r.packageId || "unknown")}</div>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:14px;margin-bottom:8px">
        <button data-action="installLatest" data-id="${esc(r.id)}" ${primaryDisabled ? "disabled" : ""} style="background:${primaryDisabled ? "rgba(255,255,255,0.1)" : "#fff"};color:${primaryDisabled ? "rgba(255,255,255,0.4)" : "#000"};border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:${primaryDisabled ? "default" : "pointer"}">${esc(primaryLabel)}</button>
        ${
          busy
            ? `<div style="display:flex;align-items:center;gap:8px">
                <div style="width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,0.2);border-top-color:#fff;animation:lp-spin 0.8s linear infinite"></div>
                <span style="font-size:13px;color:rgba(255,255,255,0.6)">${esc(state.activeLabel)}…</span>
              </div>`
            : ""
        }
      </div>
      ${notConnected ? `<div style="font-size:12px;color:#f5a623;margin-bottom:8px">Connect your Light Phone 3 to install or update.</div>` : ""}

      <div data-action="toggleLog" data-id="${esc(r.id)}" style="font-size:12px;color:rgba(255,255,255,0.4);cursor:pointer;text-decoration:underline;display:inline-block;margin:8px 0 4px">${logOpen ? "Hide command output" : "Show command output"}</div>
      ${
        logOpen
          ? `<div style="background:#0a0a0a;border-radius:10px;padding:12px 14px;margin-bottom:8px;font-family:'SF Mono',ui-monospace,Menlo,monospace;font-size:12px;color:#8fd19e;max-height:160px;overflow-y:auto">
              ${logLines.map((l) => `<div style="white-space:pre;line-height:1.6">${esc(l)}</div>`).join("")}
              ${logLines.length === 0 ? `<div style="color:rgba(255,255,255,0.3)">No output yet — run an install or update to see adb command output here.</div>` : ""}
            </div>`
          : ""
      }

      <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin:28px 0 4px">Releases</div>
      <div>${releasesHtml || `<div style="font-size:13px;color:rgba(255,255,255,0.35);padding:12px 0">No releases yet.</div>`}</div>
    </div>
  </div>`;
}

/* ---------- notes ---------- */

// "Just now" within 5 minutes (matches how fresh an edit still feels),
// otherwise a plain date — same two-tier scheme the screenshot this was
// built from uses.
function formatNoteDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  if (diffMs >= 0 && diffMs < 5 * 60 * 1000) return "Just now";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function sortNotesByUpdated(a, b) {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

// Sentinel selectedNoteId for a note that only exists in the renderer so
// far — "+" opens one of these instead of calling notesCreate immediately,
// so a note doesn't get created on the account until Save is actually
// clicked (and never, if the user just navigates away from an empty draft).
const NEW_NOTE_ID = "__new__";

function noteIsDirty() {
  const n = state.noteDetail;
  if (!n) return false;
  if (n.id === NEW_NOTE_ID) return true;
  const title = state.noteEditTitle.trim() || "Untitled";
  return title !== n.title || state.noteEditContent !== (n.content || "");
}

function renderNoteRow(n) {
  const title = n.title && n.title.trim() ? n.title : "Untitled";
  const rowBg = n.id === state.selectedNoteId ? "rgba(255,255,255,0.08)" : "transparent";
  const subtitle = n.noteType === "audio" ? "(audio note)" : n.preview || "";
  return `
  <div data-action="selectNote" data-context-note="${esc(n.id)}" data-id="${esc(n.id)}" style="display:flex;align-items:center;gap:12px;padding:11px 14px;margin:0 10px 2px;border-radius:12px;cursor:pointer;background:${rowBg}">
    ${avatar({ name: title }, 36)}
    <div style="flex:1;min-width:0">
      <div style="font-size:15px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px">${esc(subtitle)}</div>
    </div>
    <div style="font-size:11px;color:rgba(255,255,255,0.3);flex-shrink:0;white-space:nowrap;align-self:flex-start;margin-top:2px">${esc(formatNoteDate(n.updatedAt))}</div>
  </div>`;
}

function renderNotesListPane() {
  const notes = state.notes;
  return `
  <div style="width:350px;flex-shrink:0;display:flex;flex-direction:column;overflow-y:auto">
    <div style="padding:22px 24px 14px;display:flex;align-items:center;gap:8px;flex-shrink:0">
      <div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">Notes</div>
      <div style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.3)">${notes.length}</div>
      <div style="flex:1"></div>
      <button data-action="addNote" title="New note" style="background:#fff;color:#000;border:none;border-radius:8px;width:28px;height:28px;font-size:18px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">+</button>
    </div>
    ${
      state.notesLoading
        ? `<div style="padding:12px 24px;font-size:13px;color:rgba(255,255,255,0.4)">Loading…</div>`
        : notes.length === 0
        ? `<div style="padding:40px 20px;text-align:center;font-size:13px;color:rgba(255,255,255,0.35)">No notes yet</div>`
        : notes.map(renderNoteRow).join("")
    }
  </div>`;
}

function renderNoteDetailPane() {
  if (!state.selectedNoteId) {
    return `
    <div style="flex:1;overflow-y:auto;position:relative">
      <div style="height:100%;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.3);font-size:14px">Select a note to view it, or create a new one</div>
    </div>`;
  }
  if (state.noteDetailLoading || !state.noteDetail) {
    return `
    <div style="flex:1;overflow-y:auto;position:relative">
      <div style="height:100%;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.35);font-size:14px">Loading…</div>
    </div>`;
  }
  const n = state.noteDetail;
  const isNew = n.id === NEW_NOTE_ID;
  const busy = !!state.noteBusy[n.id];
  const isAudio = n.noteType === "audio";
  const dirty = noteIsDirty();
  const saveDisabled = isAudio || state.noteSaving || !dirty;
  const dateLine = isNew ? "Not saved yet" : `Last updated ${esc(formatNoteDate(n.updatedAt))}`;
  return `
  <div style="flex:1;overflow-y:auto;position:relative">
    <div style="padding:22px 48px 60px;max-width:640px">
      <input data-bind="noteEditTitle" data-note-field="title" value="${esc(state.noteEditTitle)}" placeholder="Untitled" ${isAudio ? "disabled" : ""} style="width:100%;background:transparent;border:none;color:#fff;font-size:32px;font-weight:500;letter-spacing:-0.01em;padding:0;margin-bottom:6px;outline:none">
      <div style="font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:20px">${dateLine}</div>
      ${
        isAudio
          ? `<div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6">This is an audio note — Light Phone Manager can't play or edit audio notes yet.</div>`
          : `<textarea data-bind="noteEditContent" data-note-field="content" placeholder="Start writing…" style="width:100%;min-height:320px;background:transparent;border:none;color:rgba(255,255,255,0.85);font-size:15px;line-height:1.6;padding:0;outline:none;resize:vertical;font-family:inherit">${esc(state.noteEditContent)}</textarea>`
      }
      <div style="display:flex;align-items:center;gap:16px;margin-top:32px">
        <button data-action="saveNote" ${saveDisabled ? "disabled" : ""} style="background:${saveDisabled ? "rgba(255,255,255,0.1)" : "#fff"};color:${saveDisabled ? "rgba(255,255,255,0.4)" : "#000"};border:none;border-radius:8px;padding:9px 20px;font-size:13px;font-weight:600;cursor:${saveDisabled ? "default" : "pointer"}">${state.noteSaving ? "Saving…" : "Save"}</button>
        ${
          isNew
            ? ""
            : busy
            ? `<div style="font-size:11px;font-weight:700;letter-spacing:0.05em;color:rgba(255,255,255,0.3)">DELETING…</div>`
            : `<div data-action="deleteNote" data-id="${esc(n.id)}" style="font-size:11px;font-weight:700;letter-spacing:0.05em;color:rgba(255,120,110,0.85);cursor:pointer;display:inline-block">DELETE NOTE</div>`
        }
      </div>
    </div>
  </div>`;
}

function renderNotesView() {
  const light = state.light;
  let gateMessage = null;
  let gateColor = "rgba(255,255,255,0.45)";
  if (light.installed === false) {
    gateMessage = "The bundled Light CLI is missing or broken. Try reinstalling Light Phone Manager.";
    gateColor = "#f5a623";
  } else if (light.loggedIn === null) {
    gateMessage = "Checking your Light Account…";
  } else if (!light.loggedIn) {
    gateMessage = `Sign in to your Light Account in <span data-action="openSettings" style="color:#fff;cursor:pointer;text-decoration:underline">Settings</span> to manage notes.`;
  } else if (light.devices.length > 1 && !light.selectedDeviceId) {
    gateMessage = `Multiple Light devices found on this account — choose one in <span data-action="openSettings" style="color:#fff;cursor:pointer;text-decoration:underline">Settings</span> before managing notes.`;
    gateColor = "#f5a623";
  }

  if (gateMessage) {
    return `
    <div style="flex:1;overflow-y:auto">
      <div style="padding:22px 24px 8px"><div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">Notes</div></div>
      <div style="padding:8px 24px 60px;max-width:760px"><div style="font-size:13px;color:${gateColor};line-height:1.6">${gateMessage}</div></div>
    </div>`;
  }

  return `${renderNotesListPane()}${renderNoteDetailPane()}`;
}

function renderNoteContextMenu() {
  const m = state.noteContextMenu;
  if (!m) return "";
  const note = state.notes.find((n) => n.id === m.noteId);
  if (!note) return "";
  const itemStyle = `padding:9px 12px;border-radius:7px;font-size:13px;font-weight:600;color:#ff7a6e;cursor:pointer`;
  const hoverAttrs = `onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='transparent'"`;
  return `
  <div data-action="closeNoteContextMenu" style="position:fixed;inset:0;z-index:50"></div>
  <div style="position:fixed;left:${m.x}px;top:${m.y}px;z-index:51;min-width:170px;background:#181818;border:1px solid rgba(255,255,255,0.1);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,0.55);padding:6px;">
    <div data-action="deleteNote" data-id="${esc(note.id)}" style="${itemStyle}" ${hoverAttrs}>Delete Note</div>
  </div>`;
}

function currentMediaType() {
  return state.mediaTypes.find((t) => t.key === state.mediaKey) || { key: state.mediaKey, label: "Media", kind: "image" };
}

function currentMediaItems() {
  return state.media[state.mediaKey] || [];
}

function formatDuration(totalSeconds) {
  if (!isFinite(totalSeconds)) return "";
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`;
}

function renderMediaTile(p, i, kind) {
  if (kind === "video") {
    return `
    <div data-action="openLightbox" data-index="${i}" style="position:relative;aspect-ratio:1;overflow:hidden;cursor:pointer;background:#111">
      <video data-video-tile src="${esc(p.url)}" muted preload="metadata" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;-webkit-user-drag:none"></video>
      <div data-duration-label style="position:absolute;left:0;right:0;bottom:6px;text-align:center;font-size:11px;font-weight:600;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.9);pointer-events:none"></div>
    </div>`;
  }
  return `
  <div data-action="openLightbox" data-index="${i}" style="aspect-ratio:1;overflow:hidden;cursor:pointer;background:#111">
    ${
      p.hasThumb
        ? `<img src="${esc(p.thumbUrl)}" loading="lazy" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block;-webkit-user-drag:none">`
        : "" // thumbnail still being generated in the background — an empty tile beats decoding the full-res original just to show it small
    }
  </div>`;
}

function renderMediaView() {
  const mediaType = currentMediaType();
  const items = currentMediaItems();
  const notConnected = state.device.status !== "connected";
  const hasDir = !!state.mediaBackupDir;

  let body;
  if (!hasDir) {
    body = `
    <div style="flex:1;display:flex;align-items:center;justify-content:center">
      <div style="text-align:center;max-width:360px">
        <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px">No backup folder set</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;margin-bottom:18px">Choose a folder on this PC and your Light Phone 3's photos, screenshots, and videos will be copied there automatically every time it's connected.</div>
        <button data-action="chooseMediaBackupDir" style="background:#fff;color:#000;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer">Choose Folder…</button>
      </div>
    </div>`;
  } else if (items.length === 0) {
    body = `
    <div style="flex:1;display:flex;align-items:center;justify-content:center">
      <div style="text-align:center;font-size:13px;color:rgba(255,255,255,0.35);max-width:320px;line-height:1.6">
        ${notConnected ? `No ${esc(mediaType.label.toLowerCase())} backed up yet — connect your Light Phone 3 to back them up.` : "Nothing found yet. Try Back up now."}
      </div>
    </div>`;
  } else {
    body = `
    <div style="flex:1;overflow-y:auto;padding:0 24px">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0">
        ${items.map((p, i) => renderMediaTile(p, i, mediaType.kind)).join("")}
      </div>
    </div>`;
  }

  return `
  <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;position:relative">
    <div style="padding:22px 24px 16px;display:flex;align-items:center;gap:18px;flex-shrink:0">
      <div style="display:flex;align-items:baseline;gap:8px;flex-shrink:0">
        <div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">${esc(mediaType.label)}</div>
        <div style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.3)">${items.length}</div>
      </div>
      <div style="flex:1"></div>
      <div style="display:flex;align-items:center;gap:14px;min-width:0">
        <div style="min-width:0;font-size:12px;color:rgba(255,255,255,0.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${hasDir ? esc(state.mediaBackupDir) : ""}">
          ${hasDir ? `Backing up to <span style="color:#fff;font-weight:600">${esc(state.mediaBackupDir)}</span>` : "No backup folder set"}
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
          ${
            hasDir
              ? `<button data-action="openMediaBackupFolder" style="background:transparent;border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:12px;font-weight:600;padding:6px 12px;border-radius:6px;cursor:pointer">Open Folder</button>`
              : ""
          }
          <button data-action="chooseMediaBackupDir" style="background:transparent;border:none;color:rgba(255,255,255,0.5);font-size:12px;cursor:pointer;text-decoration:underline;padding:0">${hasDir ? "Change…" : "Choose Folder…"}</button>
          ${
            hasDir
              ? `<button data-action="backupMediaNow" ${notConnected || state.backupRunning ? "disabled" : ""} style="background:transparent;border:1px solid rgba(255,255,255,0.2);color:${notConnected ? "rgba(255,255,255,0.3)" : "#fff"};font-size:12px;font-weight:600;padding:6px 12px;border-radius:6px;cursor:${notConnected || state.backupRunning ? "default" : "pointer"}">${state.backupRunning ? "Backing up…" : "Back up now"}</button>`
              : ""
          }
        </div>
      </div>
    </div>
    ${body}
    ${renderLightbox()}
  </div>`;
}

function renderLightbox() {
  if (state.lightboxIndex == null) return "";
  const items = currentMediaItems();
  const item = items[state.lightboxIndex];
  if (!item) return "";
  const isVideo = currentMediaType().kind === "video";
  const mediaEl = isVideo
    ? `<video data-lightbox-img data-action="lightboxNoop" src="${esc(item.url)}" controls autoplay style="max-width:88vw;max-height:80vh;background:#000;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.6)"></video>`
    : `<img data-lightbox-img data-action="lightboxNoop" src="${esc(item.url)}" style="max-width:88vw;max-height:80vh;object-fit:contain;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.6)">`;
  return `
  <div data-lightbox data-action="closeLightbox" style="position:fixed;inset:0;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;z-index:30">
    ${mediaEl}
    <button data-action="closeLightbox" title="Close" style="position:absolute;top:20px;right:24px;background:transparent;border:none;color:rgba(255,255,255,0.7);font-size:20px;cursor:pointer;line-height:1;padding:6px">&#10005;</button>
    ${items.length > 1 ? `<button data-action="lightboxPrev" title="Previous" style="position:absolute;left:20px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:rgba(255,255,255,0.7);font-size:28px;cursor:pointer;padding:10px">&#8249;</button>` : ""}
    ${items.length > 1 ? `<button data-action="lightboxNext" title="Next" style="position:absolute;right:20px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:rgba(255,255,255,0.7);font-size:28px;cursor:pointer;padding:10px">&#8250;</button>` : ""}
    ${!isVideo ? `<div data-lightbox-caption data-action="lightboxNoop" style="position:absolute;bottom:22px;left:50%;transform:translateX(-50%);font-size:12px;color:rgba(255,255,255,0.55)">${esc(item.name)}</div>` : ""}
  </div>`;
}

// Swaps the lightbox's <img> src/caption in place instead of going through
// the usual full setState()/render() — that tears down and rebuilds the
// entire tool, including the lightbox's own <img>, which visibly flashes to
// black between photos while the new element decodes. Returns false (so the
// caller can fall back to a normal render) if the lightbox isn't currently
// in the DOM to patch, or the current item is a video — a playing <video>
// needs a fresh element (new src, restart playback) rather than an in-place
// swap, so that case just re-renders normally.
// Mirrors the disabled/style logic in renderNoteDetailPane's Save button —
// kept in sync manually since this exists specifically to update that
// button without going through render() (see the `input` listener).
function patchNoteSaveButton() {
  const btn = document.querySelector('[data-action="saveNote"]');
  if (!btn || !state.noteDetail) return false;
  const disabled = state.noteDetail.noteType === "audio" || state.noteSaving || !noteIsDirty();
  btn.disabled = disabled;
  btn.style.background = disabled ? "rgba(255,255,255,0.1)" : "#fff";
  btn.style.color = disabled ? "rgba(255,255,255,0.4)" : "#000";
  btn.style.cursor = disabled ? "default" : "pointer";
  return true;
}

function patchLightboxImage() {
  if (currentMediaType().kind === "video") return false;
  const overlay = document.querySelector("[data-lightbox]");
  if (!overlay) return false;
  const photo = currentMediaItems()[state.lightboxIndex];
  if (!photo) return false;
  const img = overlay.querySelector("[data-lightbox-img]");
  const caption = overlay.querySelector("[data-lightbox-caption]");
  if (img) img.src = photo.url;
  if (caption) caption.textContent = photo.name;
  return true;
}

// loadedmetadata doesn't bubble, so delegated click/input listeners can't
// catch it — wire each video tile directly after every render instead.
function wireVideoDurations() {
  document.querySelectorAll("[data-video-tile]").forEach((video) => {
    video.addEventListener(
      "loadedmetadata",
      () => {
        const label = video.parentElement && video.parentElement.querySelector("[data-duration-label]");
        if (label) label.textContent = formatDuration(video.duration);
      },
      { once: true }
    );
  });
}

const DROPZONE_IDLE = { borderColor: "rgba(255,255,255,0.15)", background: "transparent" };
const DROPZONE_OVER = { borderColor: "rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.04)" };

function setDropzoneStyle(zone, styles) {
  zone.style.borderColor = styles.borderColor;
  zone.style.background = styles.background;
}

// Drag-and-drop listeners for the Install screen's own drop zone. Attached
// fresh after every render (the element itself is torn down and recreated
// each time, same as everything else in this tool) rather than delegated,
// since dragenter/dragover/drop need to be scoped to just this one element —
// this used to be wired to the whole window, which meant dragging anything
// (e.g. a photo on the Media screen) anywhere in the tool was treated as a
// potential APK install.
//
// The hover style is applied directly to the element (not via
// setState()/render()) — going through a full re-render mid-drag replaces
// the drop zone with a new DOM node while the browser's drag session is
// still tracking the old one, which makes it drop the drag entirely and the
// final "drop" event never fires.
function wireInstallDropZone() {
  const zone = document.querySelector("[data-install-dropzone]");
  if (!zone) return;
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    setDropzoneStyle(zone, DROPZONE_OVER);
  });
  zone.addEventListener("dragleave", (e) => {
    if (e.target === zone || !zone.contains(e.relatedTarget)) {
      setDropzoneStyle(zone, DROPZONE_IDLE);
    }
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    setDropzoneStyle(zone, DROPZONE_IDLE);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.apk$/i.test(file.name)) {
      showToast("Drop an .apk file");
      return;
    }
    const filePath = window.api.getPathForFile(file);
    await inspectAndShowDrop(filePath);
  });
}

// Drag-and-drop here is scoped to this screen's own drop zone (wired up in
// wireInstallDropZone, after each render) — not the whole window. Dragging
// a file anywhere else in the tool (e.g. an image over the Media grids)
// doesn't trigger anything.
function renderInstallView() {
  return `
  <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column">
    <div style="padding:22px 24px 16px;flex-shrink:0">
      <div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">Install APK</div>
    </div>
    <div style="flex:1;padding:0 24px 24px">
      <div data-install-dropzone style="height:100%;border:2px dashed ${DROPZONE_IDLE.borderColor};background:${DROPZONE_IDLE.background};border-radius:16px;display:flex;align-items:center;justify-content:center;transition:border-color 0.15s,background 0.15s">
        <div style="text-align:center;max-width:360px">
          <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px">Drop an APK here</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;margin-bottom:18px">Or browse for a file on this PC. If it matches a tracked repo it'll update that tool; otherwise it's added as a sideloaded tool.</div>
          <button data-action="pickApkFile" style="background:#fff;color:#000;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer">Browse…</button>
        </div>
      </div>
    </div>
  </div>`;
}

// LightOS's own toggle style: a small circle joined to a line — hollow with
// the circle on the left when off, filled with the circle slid to the right
// end when on. `checked === null` means "unknown" (no device connected yet)
// — shown off-but-disabled rather than guessing a state.
function renderToggleSwitch({ checked, disabled, busy }) {
  const on = !!checked;
  // The knob's own fill is white when on, so its spinner needs to be dark to
  // stay visible against it — and the reverse when off (transparent knob).
  const spinner = on
    ? `<div style="width:9px;height:9px;border-radius:50%;border:2px solid rgba(0,0,0,0.25);border-top-color:#000;animation:lp-spin 0.6s linear infinite"></div>`
    : `<div style="width:9px;height:9px;border-radius:50%;border:2px solid rgba(255,255,255,0.25);border-top-color:#fff;animation:lp-spin 0.6s linear infinite"></div>`;
  const circle = `<div style="width:14px;height:14px;border-radius:50%;flex-shrink:0;box-sizing:border-box;border:2px solid #fff;background:${on ? "#fff" : "transparent"};display:flex;align-items:center;justify-content:center">${busy ? spinner : ""}</div>`;
  const line = `<div style="flex:1;height:2px;background:#fff;opacity:${on ? 1 : 0.5}"></div>`;
  return `
  <div style="position:relative;flex-shrink:0;width:34px;height:16px;display:flex;align-items:center">
    ${on ? `${line}${circle}` : `${circle}${line}`}
  </div>`;
}

function renderToggleRow({ title, description, checked, action, disabled, busy }) {
  return `
  <div ${disabled ? "" : `data-action="${action}"`} style="display:flex;align-items:center;gap:16px;padding:20px 0;border-bottom:1px solid rgba(255,255,255,0.08);cursor:${disabled ? "default" : "pointer"};opacity:${disabled ? 0.4 : 1}">
    ${renderToggleSwitch({ checked, disabled, busy })}
    <div style="min-width:0">
      <div style="font-size:17px;font-weight:700;color:#fff">${esc(title)}</div>
      ${description ? `<div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.5;margin-top:4px">${esc(description)}</div>` : ""}
    </div>
  </div>`;
}

function renderSettingsView() {
  const notConnected = state.device.status !== "connected";
  const os = state.osSettings;
  const busy = state.osSettingsBusy;
  // LightOS keeps running with whatever Show External Tools was set to at
  // last boot — a settings put takes effect immediately in the settings
  // database, but not in the already-running process — so only point at a
  // reboot when the current value has actually drifted from that baseline.
  const baseline = state.osSettingsBaseline;
  const needsReboot = baseline != null && os.showExternalTools !== baseline.showExternalTools;
  return `
  <div style="flex:1;overflow-y:auto">
    <div style="padding:22px 24px 8px">
      <div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">Settings</div>
    </div>
    <div style="padding:8px 24px 60px;max-width:640px">
      ${notConnected ? `<div style="font-size:12px;color:#f5a623;margin-bottom:8px">Connect your Light Phone 3 to view and change these settings.</div>` : ""}
      ${renderToggleRow({
        title: "OS Animations",
        description: "Turns system animations on or off.",
        checked: os.animationsOn,
        action: "toggleAnimations",
        disabled: notConnected || busy.animations,
        busy: busy.animations,
      })}
      ${renderToggleRow({
        title: "Show External Tools in LightOS",
        description: "Allows viewing sideloaded tools inside LightOS.",
        checked: os.showExternalTools,
        action: "toggleShowExternalTools",
        disabled: notConnected || busy.showExternalTools,
        busy: busy.showExternalTools,
      })}
      ${
        !notConnected && os.chromiumAvailable === false
          ? ""
          : renderToggleRow({
              title: "Hide Chromium Browser",
              description: "Completely removes the Chromium browser app from the Light Phone's app list. Its data isn't lost — turn this off to restore it.",
              checked: os.chromiumHidden,
              action: "toggleChromiumHidden",
              disabled: notConnected || busy.chromium || os.chromiumAvailable === false,
              busy: busy.chromium,
            })
      }
      ${
        needsReboot
          ? `<div style="padding-top:22px">
              <button data-action="rebootDevice" ${state.deviceRebooting ? "disabled" : ""} style="background:transparent;border:1px solid rgba(255,255,255,0.3);color:#fff;font-size:14px;font-weight:600;padding:9px 18px;border-radius:8px;cursor:${state.deviceRebooting ? "default" : "pointer"}">${state.deviceRebooting ? "Rebooting…" : "Reboot Light Phone"}</button>
              <div style="font-size:12px;color:rgba(255,255,255,0.45);margin-top:10px">Some setting changes require a device reboot to take effect.</div>
            </div>`
          : ""
      }
      ${renderLightAccountSection()}
    </div>
  </div>`;
}

function renderLightAccountSection() {
  const light = state.light;
  let body;

  if (light.installed === false) {
    body = `<div style="font-size:13px;color:#f5a623;line-height:1.6">The bundled Light CLI is missing or broken. Try reinstalling Light Phone Manager.</div>`;
  } else if (light.loggedIn === null) {
    body = `<div style="font-size:13px;color:rgba(255,255,255,0.4)">Checking…</div>`;
  } else if (!light.loggedIn) {
    // autocomplete hints tell the OS/password manager these are real login
    // fields (so it can offer to fill/save them the same as any other app);
    // the password value itself never leaves this form except in the single
    // ipcRenderer.invoke call submitLightLogin makes, and is cleared from
    // state right after.
    body = `
    <div style="max-width:360px">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:6px">Email</div>
      <input data-bind="lightEmail" data-action="submitOnEnter" type="email" autocomplete="username" value="${esc(state.lightEmail)}" ${state.lightLoginBusy ? "disabled" : ""} style="width:100%;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);color:#fff;font-size:15px;padding:6px 0;outline:none;margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:6px">Password</div>
      <input data-bind="lightPassword" data-action="submitOnEnter" type="password" autocomplete="current-password" value="${esc(state.lightPassword)}" ${state.lightLoginBusy ? "disabled" : ""} style="width:100%;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);color:#fff;font-size:15px;padding:6px 0;outline:none;margin-bottom:18px">
      ${state.lightLoginError ? `<div style="font-size:12px;color:#f5a623;margin-bottom:12px">${esc(state.lightLoginError)}</div>` : ""}
      <button data-action="submitLightLogin" ${state.lightLoginBusy ? "disabled" : ""} style="background:#fff;color:#000;border:none;border-radius:8px;padding:9px 18px;font-size:14px;font-weight:600;cursor:${state.lightLoginBusy ? "default" : "pointer"}">${state.lightLoginBusy ? "Signing in…" : "Sign In"}</button>
      <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:12px;line-height:1.5">Your password is sent straight to the Light CLI to sign in and is never stored by this tool. The CLI keeps you signed in on its own for about 30 days.</div>
    </div>`;
  } else {
    // light.devices is already filtered to TLP301 (Light Phone 3) and
    // auto-selected when there's only one — see onlyTlp301/autoSelectDeviceId
    // in main.js. This only needs to render a picker at all once that still
    // leaves more than one candidate.
    const multiDevice = light.devices.length > 1;
    const selected = light.devices.find((d) => d.deviceId === light.selectedDeviceId);
    body = `
    <div style="max-width:420px">
      <div style="font-size:14px;color:#fff;margin-bottom:4px">Signed in${selected ? ` · ${esc(selected.phoneNumber || selected.serialNumber || "")}` : ""}</div>
      ${
        multiDevice
          ? `<div style="margin:14px 0">
              <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:6px">Device</div>
              <select data-action="selectLightDevice" ${state.lightDeviceSelectBusy ? "disabled" : ""} style="width:100%;background:#111;border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:14px;padding:8px 10px;border-radius:8px;outline:none">
                <option value="" ${!light.selectedDeviceId ? "selected" : ""} disabled>Choose a device…</option>
                ${light.devices
                  .map(
                    (d) =>
                      `<option value="${esc(d.deviceId)}" ${d.deviceId === light.selectedDeviceId ? "selected" : ""}>${esc(d.phoneNumber || d.serialNumber || d.deviceId)}${d.sku ? ` · ${esc(d.sku)}` : ""}</option>`
                  )
                  .join("")}
              </select>
            </div>`
          : ""
      }
      <button data-action="lightLogout" ${state.lightLogoutBusy ? "disabled" : ""} style="background:transparent;border:1px solid rgba(255,255,255,0.3);color:#fff;font-size:14px;font-weight:600;padding:9px 18px;border-radius:8px;cursor:${state.lightLogoutBusy ? "default" : "pointer"};margin-top:6px">${state.lightLogoutBusy ? "Signing out…" : "Log Out"}</button>
    </div>`;
  }

  return `
  <div style="margin-top:36px;padding-top:28px;border-top:1px solid rgba(255,255,255,0.08)">
    <div style="font-size:20px;font-weight:700;color:#fff;margin-bottom:16px">Light Account</div>
    ${body}
  </div>`;
}

function attributionRow({ name, note, url }) {
  return `
  <div style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08)">
    <div style="font-size:15px;font-weight:700;color:#fff">${esc(name)}</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.5;margin-top:4px">${note}</div>
    ${
      url
        ? `<div style="font-size:13px;margin-top:4px"><span data-action="openRepoUrl" data-url="${esc(url)}" style="color:rgba(255,255,255,0.6);cursor:pointer;text-decoration:underline">${esc(url)}</span></div>`
        : ""
    }
  </div>`;
}

function renderAboutView() {
  const attributions = [
    {
      name: "@ffmpeg-installer/ffmpeg",
      note: "Bundles FFmpeg, used to convert uploaded audio files into the .m4a format Light Phone ringtones/alerts expect.",
      url: "https://github.com/kribblo/node-ffmpeg-installer",
    },
    {
      name: "app-info-parser",
      note: "Reads app name, package id, version, and icon out of an .apk file when tracking or installing a tool.",
      url: "https://github.com/rufengsuixing/app-info-parser",
    },
    {
      name: "Android Platform Tools (adb)",
      note: "Bundled to talk to your Light Phone 3 over USB — installing tools, backing up media, and everything else that goes over adb.",
      url: "https://developer.android.com/tools/releases/platform-tools",
    },
    {
      name: "Electron",
      note: "The application shell this tool is built on.",
      url: "https://www.electronjs.org",
    },
    {
      name: "Inter",
      note: "The typeface used throughout this tool, by The Inter Project Authors. Licensed under the SIL Open Font License.",
      url: "https://github.com/rsms/inter",
    },
    {
      name: "Apple Search API",
      note: "Podcast search results on the Add Podcast screen are provided courtesy of iTunes, via Apple's Search API.",
      url: "https://performance-partners.apple.com/search-api",
    },
  ];

  return `
  <div style="flex:1;overflow-y:auto">
    <div style="padding:22px 24px 8px">
      <div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">About</div>
    </div>
    <div style="padding:8px 24px 60px;max-width:640px">
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:20px 22px;margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:8px">Special thanks</div>
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px">Alexis Garado</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.55);line-height:1.6;margin-bottom:8px">Author of the Light API/CLI/TUI, the unofficial toolkit this tool relies on for all Podcast, Music, Note, and official Light tool management on your Light Account.</div>
        <div style="font-size:13px"><span data-action="openRepoUrl" data-url="https://github.com/garado/light" style="color:#fff;cursor:pointer;text-decoration:underline">github.com/garado/light</span></div>
      </div>

      <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin:28px 0 4px">Also built with</div>
      <div>${attributions.map(attributionRow).join("")}</div>
    </div>
  </div>`;
}

function playIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`;
}

function stopIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1"></rect></svg>`;
}

function uploadIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
}

function restoreIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 .49-9.36L1 10"></path></svg>`;
}

// Fixed 30x30 box for every slot in the icon-button row — a <button>, or (in
// the loading/busy case) a spinner sized and aligned identically — so all
// three buttons stay on the same vertical line regardless of state or which
// icon (they aren't all the same intrinsic size) is showing.
function iconSlot({ icon, title, action, dataset, disabled, spinner }) {
  const dataAttrs = Object.entries(dataset || {})
    .map(([k, v]) => `data-${k}="${esc(v)}"`)
    .join(" ");
  if (spinner) {
    return `<div style="display:inline-flex;width:30px;height:30px;align-items:center;justify-content:center;vertical-align:middle;margin-left:6px"><div style="width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,0.2);border-top-color:#fff;animation:lp-spin 0.8s linear infinite"></div></div>`;
  }
  return `
  <button title="${esc(title)}" ${disabled ? "disabled" : `data-action="${action}" ${dataAttrs}`} style="background:transparent;border:1px solid rgba(255,255,255,0.2);color:${disabled ? "rgba(255,255,255,0.25)" : "#fff"};border-radius:6px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;cursor:${disabled ? "default" : "pointer"};margin-left:6px">${icon}</button>`;
}

function renderRingtoneRow(entry) {
  const busy = state.ringtoneBusy[entry.remoteFilename];
  const playLoading = state.ringtonePlayLoading[entry.remoteFilename];
  const isPlaying = state.playingRingtone === entry.remoteFilename;
  const playLabel = entry.overrideName || entry.deviceName;
  return `
  <tr style="border-bottom:1px solid rgba(255,255,255,0.06)">
    <td style="padding:10px 14px 10px 0;font-size:14px;font-weight:600;color:#fff;white-space:nowrap">${esc(entry.deviceName)}</td>
    <td style="padding:10px 14px;font-size:13px;color:rgba(255,255,255,0.5)">${entry.overrideName ? esc(entry.overrideName) : "—"}</td>
    <td style="padding:10px 0;text-align:right;white-space:nowrap">
      ${
        busy
          ? iconSlot({ spinner: true })
          : `${
              playLoading
                ? iconSlot({ spinner: true })
                : iconSlot({
                    icon: isPlaying ? stopIcon() : playIcon(),
                    title: isPlaying ? `Stop playing ${playLabel}` : `Play ${playLabel}`,
                    action: "toggleRingtonePlayback",
                    dataset: { remote: entry.remoteFilename },
                  })
            }${iconSlot({
              icon: uploadIcon(),
              title: `Replace ${entry.deviceName} with a file from this PC`,
              action: "uploadRingtone",
              dataset: { remote: entry.remoteFilename, backup: entry.backupFilename },
            })}${iconSlot({
              icon: restoreIcon(),
              title: entry.hasBackup ? `Restore the original ${entry.deviceName} sound` : "No custom sound set",
              action: "restoreRingtone",
              dataset: { remote: entry.remoteFilename, backup: entry.backupFilename },
              disabled: !entry.hasBackup,
            })}`
      }
    </td>
  </tr>`;
}

function renderRingtoneTable(title, entries) {
  return `
  <div style="margin-bottom:36px">
    ${title ? `<div style="font-size:20px;font-weight:700;color:#fff;margin-bottom:12px">${esc(title)}</div>` : ""}
    ${
      entries.length === 0
        ? `<div style="font-size:13px;color:rgba(255,255,255,0.35);padding:8px 0">None found on the device.</div>`
        : `<table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid rgba(255,255,255,0.15)">
                <th style="text-align:left;padding:0 14px 8px 0;font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase">Device Ringtone Name</th>
                <th style="text-align:left;padding:0 14px 8px;font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase">Override Ringtone Name</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${entries.map(renderRingtoneRow).join("")}</tbody>
          </table>`
    }
  </div>`;
}

function renderRingtonesView() {
  const notConnected = state.device.status !== "connected";
  const { ringtones, alerts } = state.ringtones;
  return `
  <div data-scroll-key="ringtones" style="flex:1;overflow-y:auto">
    <div style="padding:22px 24px 8px">
      <div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">Ringtones &amp; Alerts</div>
    </div>
    <div style="padding:8px 24px 60px;max-width:760px">
      ${
        notConnected
          ? `<div style="font-size:12px;color:#f5a623;margin-bottom:8px">Connect your Light Phone 3 to view and change these sounds.</div>`
          : state.ringtonesLoading
          ? `<div style="font-size:13px;color:rgba(255,255,255,0.4);padding:8px 0">Loading…</div>`
          : `${renderRingtoneTable(null, ringtones)}${renderRingtoneTable("Messages", alerts)}`
      }
    </div>
  </div>`;
}

function deleteIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;
}

function renderPodcastRow(p) {
  const busy = state.podcastBusy[p.title];
  return `
  <tr style="border-bottom:1px solid rgba(255,255,255,0.06)">
    <td style="padding:10px 14px 10px 0;font-size:14px;font-weight:600;color:#fff">${esc(p.title)}</td>
    <td style="padding:10px 14px;font-size:13px;color:rgba(255,255,255,0.5)">${p.publisher ? esc(p.publisher) : "—"}</td>
    <td style="padding:10px 0;text-align:right;white-space:nowrap">
      ${
        busy
          ? iconSlot({ spinner: true })
          : iconSlot({ icon: deleteIcon(), title: `Remove ${p.title}`, action: "deletePodcast", dataset: { title: p.title } })
      }
    </td>
  </tr>`;
}

function renderPodcastsView() {
  const light = state.light;
  const addBtn = `<button data-action="openAddPodcast" title="Add podcast" style="background:#fff;color:#000;border:none;border-radius:8px;width:28px;height:28px;font-size:18px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">+</button>`;

  let body;
  if (light.installed === false) {
    body = `<div style="font-size:13px;color:#f5a623;padding:8px 0;line-height:1.6">The bundled Light CLI is missing or broken. Try reinstalling Light Phone Manager.</div>`;
  } else if (light.loggedIn === null) {
    body = `<div style="font-size:13px;color:rgba(255,255,255,0.4);padding:8px 0">Checking your Light Account…</div>`;
  } else if (!light.loggedIn) {
    body = `<div style="font-size:13px;color:rgba(255,255,255,0.45);padding:8px 0;line-height:1.6">Sign in to your Light Account in <span data-action="openSettings" style="color:#fff;cursor:pointer;text-decoration:underline">Settings</span> to manage podcasts.</div>`;
  } else if (light.devices.length > 1 && !light.selectedDeviceId) {
    body = `<div style="font-size:13px;color:#f5a623;padding:8px 0;line-height:1.6">Multiple Light devices found on this account — choose one in <span data-action="openSettings" style="color:#fff;cursor:pointer;text-decoration:underline">Settings</span> before managing podcasts.</div>`;
  } else if (state.podcastsLoading) {
    body = `<div style="font-size:13px;color:rgba(255,255,255,0.4);padding:8px 0">Loading…</div>`;
  } else if (state.podcasts.length === 0) {
    body = `<div style="font-size:13px;color:rgba(255,255,255,0.35);padding:8px 0">No podcasts followed yet.</div>`;
  } else {
    body = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="border-bottom:1px solid rgba(255,255,255,0.15)">
          <th style="text-align:left;padding:0 14px 8px 0;font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase">Title</th>
          <th style="text-align:left;padding:0 14px 8px;font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase">Publisher</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${state.podcasts.map(renderPodcastRow).join("")}</tbody>
    </table>`;
  }

  return `
  <div style="flex:1;overflow-y:auto">
    <div style="padding:22px 24px 8px;display:flex;align-items:center;gap:14px">
      <div style="font-size:32px;font-weight:500;color:#fff;letter-spacing:-0.01em">Podcasts</div>
      ${light.loggedIn && (light.devices.length <= 1 || light.selectedDeviceId) ? addBtn : ""}
    </div>
    <div style="padding:8px 24px 60px;max-width:760px">${body}</div>
  </div>`;
}

function addPodcastTabButton(mode, label) {
  const active = state.addPodcastMode === mode;
  return `<button data-action="setAddPodcastMode" data-mode="${mode}" style="flex:1;background:${active ? "#fff" : "transparent"};color:${active ? "#000" : "rgba(255,255,255,0.55)"};border:1px solid ${active ? "#fff" : "rgba(255,255,255,0.2)"};border-radius:7px;padding:8px 0;font-size:13px;font-weight:700;cursor:pointer">${label}</button>`;
}

function renderPodcastSearchResultRow(r) {
  const busy = state.podcastSearchAddBusy[r.feedUrl];
  const alreadyAdded = state.podcasts.some((p) => p.title.toLowerCase() === r.title.toLowerCase());
  const addLabel = busy ? "Adding…" : alreadyAdded ? "Added" : "Add";
  return `
  <div style="display:flex;align-items:center;gap:12px;padding:8px 4px">
    ${
      r.artwork
        ? `<img src="${esc(r.artwork)}" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;border:1px solid rgba(255,255,255,0.1)">`
        : `<div style="width:44px;height:44px;border-radius:8px;background:rgba(255,255,255,0.06);flex-shrink:0"></div>`
    }
    <div style="min-width:0;flex:1">
      <div style="font-size:14px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.title)}</div>
      ${r.author ? `<div style="font-size:12px;color:rgba(255,255,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.author)}</div>` : ""}
    </div>
    <button data-action="addSearchedPodcast" data-feed-url="${esc(r.feedUrl)}" data-title="${esc(r.title)}" ${busy || alreadyAdded ? "disabled" : ""} style="flex-shrink:0;background:${alreadyAdded ? "transparent" : "#fff"};color:${alreadyAdded ? "rgba(255,255,255,0.35)" : "#000"};border:${alreadyAdded ? "1px solid rgba(255,255,255,0.2)" : "none"};border-radius:7px;padding:6px 14px;font-size:12px;font-weight:700;cursor:${busy || alreadyAdded ? "default" : "pointer"}">${addLabel}</button>
  </div>`;
}

function renderPodcastSearchTab() {
  if (state.podcastSearchAvailable === false) {
    return `<div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;padding:4px 0 2px">Podcast search isn't set up for this build. Use the RSS Feed tab to add a podcast by its feed URL instead.</div>`;
  }
  let resultsBody;
  if (state.podcastSearchError) {
    resultsBody = `<div style="font-size:13px;color:#f5a623;padding:10px 4px">${esc(state.podcastSearchError)}</div>`;
  } else if (state.podcastSearchLoading) {
    resultsBody = `<div style="font-size:13px;color:rgba(255,255,255,0.4);padding:10px 4px">Searching…</div>`;
  } else if (state.podcastSearchResults.length > 0) {
    resultsBody = state.podcastSearchResults.map(renderPodcastSearchResultRow).join("");
  } else if (state.podcastSearchQuery.trim()) {
    resultsBody = `<div style="font-size:13px;color:rgba(255,255,255,0.35);padding:10px 4px">No podcasts found.</div>`;
  } else {
    resultsBody = "";
  }
  return `
  <div style="display:flex;gap:8px;margin-bottom:4px">
    <input data-bind="podcastSearchQuery" data-action="submitOnEnter" value="${esc(state.podcastSearchQuery)}" placeholder="Search podcasts…" autofocus style="flex:1;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);color:#fff;font-size:15px;padding:6px 0;outline:none">
    <button data-action="searchPodcasts" ${state.podcastSearchLoading ? "disabled" : ""} style="flex-shrink:0;background:#fff;color:#000;border:none;border-radius:7px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer">Search</button>
  </div>
  <div style="max-height:340px;overflow-y:auto">${resultsBody}</div>`;
}

function renderPodcastRssTab() {
  return `
  <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:6px">Podcast RSS feed URL</div>
  <input data-bind="addPodcastUrl" data-action="submitOnEnter" value="${esc(state.addPodcastUrl)}" placeholder="https://feeds.example.com/podcast.rss" ${state.addPodcastBusy ? "disabled" : ""} style="width:100%;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);color:#fff;font-size:15px;padding:6px 0;outline:none">
  <div style="display:flex;justify-content:flex-end;margin-top:16px">
    <button data-action="submitAddPodcast" ${state.addPodcastBusy ? "disabled" : ""} style="background:#fff;color:#000;border:none;border-radius:7px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer">${state.addPodcastBusy ? "Adding…" : "Add"}</button>
  </div>`;
}

function renderAddPodcastModal() {
  if (!state.showAddPodcast) return "";
  return `
  <div style="position:absolute;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10">
    <div style="width:460px;background:#0a0a0a;border-radius:18px;padding:26px;box-shadow:0 30px 80px rgba(0,0,0,0.6)">
      <div style="font-size:20px;font-weight:500;color:#fff;margin-bottom:18px">Add Podcast</div>
      <div style="display:flex;gap:8px;margin-bottom:20px">${addPodcastTabButton("search", "Search")}${addPodcastTabButton("rss", "RSS Feed")}</div>
      ${state.addPodcastMode === "search" ? renderPodcastSearchTab() : renderPodcastRssTab()}
      <div style="display:flex;justify-content:flex-end;margin-top:18px">
        <button data-action="closeAddPodcast" style="background:transparent;border:none;color:rgba(255,255,255,0.5);font-size:13px;font-weight:600;padding:8px 14px;cursor:pointer">Close</button>
      </div>
    </div>
  </div>`;
}

function renderAddRepoModal() {
  if (!state.showAddRepo) return "";
  return `
  <div style="position:absolute;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10">
    <div style="width:420px;background:#0a0a0a;border-radius:18px;padding:26px;box-shadow:0 30px 80px rgba(0,0,0,0.6)">
      <div style="font-size:20px;font-weight:500;color:#fff;margin-bottom:18px">Add Repo</div>
      <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:6px">GitHub repository URL</div>
      <input data-bind="addRepoUrl" data-action="submitOnEnter" value="${esc(state.addRepoUrl)}" placeholder="github.com/author/tool" ${state.addRepoBusy ? "disabled" : ""} style="width:100%;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);color:#fff;font-size:15px;padding:6px 0;outline:none;margin-bottom:22px">
      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button data-action="closeAddRepo" style="background:transparent;border:none;color:rgba(255,255,255,0.5);font-size:13px;font-weight:600;padding:8px 14px;cursor:pointer">Cancel</button>
        <button data-action="submitAddRepo" ${state.addRepoBusy ? "disabled" : ""} style="background:#fff;color:#000;border:none;border-radius:7px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer">${state.addRepoBusy ? "Fetching…" : "Add"}</button>
      </div>
    </div>
  </div>`;
}

function renderDropModal() {
  const d = state.drop;
  if (!d) return "";
  const parsed = d.parsed;
  const name = parsed.appName || parsed.packageId || "Unknown Tool";
  const notConnected = state.device.status !== "connected";
  let message;
  if (d.matchId) {
    const repo = state.repos.find((r) => r.id === d.matchId);
    const sameVersion = repo && versionsEqual(repo.installedVersion, parsed.versionName);
    message = sameVersion
      ? `This matches your tracked repo. ${esc(name)} ${esc(parsed.versionName)} is already installed — reinstall it?`
      : `This matches your tracked repo. Install ${esc(name)} ${esc(parsed.versionName)}?`;
  } else {
    message = "This tool isn't tracked from a repo. Install it as a sideloaded tool?";
  }
  const matchedRepoForLabel = d.matchId && state.repos.find((r) => r.id === d.matchId);
  const actionLabel = matchedRepoForLabel && versionsEqual(matchedRepoForLabel.installedVersion, parsed.versionName) ? "Reinstall" : "Install";

  return `
  <div style="position:absolute;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10">
    <div style="width:440px;background:#0a0a0a;border-radius:18px;padding:26px;box-shadow:0 30px 80px rgba(0,0,0,0.6)">
      <div style="font-size:20px;font-weight:500;color:#fff;margin-bottom:18px">Install APK</div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        ${avatar({ name, icon: parsed.icon }, 44)}
        <div>
          <div style="font-size:15px;font-weight:600;color:#fff">${esc(name)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4);font-family:'SF Mono',ui-monospace,Menlo,monospace">${esc(parsed.packageId || "unknown")} · ${esc(parsed.versionName || "?")}</div>
        </div>
      </div>
      <div style="font-size:13px;color:rgba(255,255,255,0.6);line-height:1.5;margin-bottom:12px">${message}</div>
      ${notConnected ? `<div style="font-size:12px;color:#f5a623;margin-bottom:10px">Connect your Light Phone 3 to install.</div>` : ""}
      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button data-action="cancelDrop" style="background:transparent;border:none;color:rgba(255,255,255,0.5);font-size:13px;font-weight:600;padding:8px 14px;cursor:pointer">Cancel</button>
        <button data-action="confirmDrop" ${notConnected || state.dropBusy ? "disabled" : ""} style="background:#fff;color:#000;border:none;border-radius:7px;padding:8px 18px;font-size:13px;font-weight:600;cursor:${notConnected || state.dropBusy ? "default" : "pointer"}">${state.dropBusy ? "Installing…" : actionLabel}</button>
      </div>
    </div>
  </div>`;
}

function renderConfirmModal() {
  const c = state.confirmDialog;
  if (!c) return "";
  return `
  <div style="position:absolute;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:40">
    <div style="width:380px;background:#0a0a0a;border-radius:18px;padding:26px;box-shadow:0 30px 80px rgba(0,0,0,0.6)">
      <div style="font-size:14px;color:rgba(255,255,255,0.8);line-height:1.55;margin-bottom:22px">${esc(c.message)}</div>
      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button data-action="cancelConfirm" style="background:transparent;border:none;color:rgba(255,255,255,0.5);font-size:13px;font-weight:600;padding:8px 14px;cursor:pointer">Cancel</button>
        <button data-action="confirmConfirm" style="background:${c.danger ? "#e5484d" : "#fff"};color:${c.danger ? "#fff" : "#000"};border:none;border-radius:7px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer">${esc(c.confirmLabel)}</button>
      </div>
    </div>
  </div>`;
}

function renderContextMenu() {
  const m = state.contextMenu;
  if (!m) return "";
  const repo = state.repos.find((r) => r.id === m.repoId);
  if (!repo) return "";
  const disabled = !repo.packageId || state.device.status !== "connected";
  const title = state.device.status !== "connected" ? "Connect your Light Phone 3 to launch apps" : !repo.packageId ? "No package to launch" : "";
  const itemStyle = (dis) =>
    `padding:9px 12px;border-radius:7px;font-size:13px;font-weight:600;color:${dis ? "rgba(255,255,255,0.3)" : "#fff"};cursor:${dis ? "default" : "pointer"}`;
  const hoverAttrs = `onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='transparent'"`;
  return `
  <div data-action="closeContextMenu" style="position:fixed;inset:0;z-index:50"></div>
  <div style="position:fixed;left:${m.x}px;top:${m.y}px;z-index:51;min-width:170px;background:#181818;border:1px solid rgba(255,255,255,0.1);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,0.55);padding:6px;">
    <div data-action="launchApp" data-id="${esc(repo.id)}" title="${esc(title)}" style="${itemStyle(disabled)}" ${disabled ? "" : hoverAttrs}>Launch App</div>
    <div data-action="viewAppLogs" data-id="${esc(repo.id)}" title="${esc(title)}" style="${itemStyle(disabled)}" ${disabled ? "" : hoverAttrs}>View Logs</div>
  </div>`;
}

function renderAppLogsModal() {
  const a = state.appLogs;
  if (!a) return "";
  const repo = state.repos.find((r) => r.id === a.repoId);
  return `
  <div style="position:absolute;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:40">
    <div style="width:640px;max-width:90%;height:70%;background:#0a0a0a;border-radius:18px;padding:22px;box-shadow:0 30px 80px rgba(0,0,0,0.6);display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-shrink:0">
        <div style="font-size:16px;font-weight:700;color:#fff">${esc(repo ? repo.name : "App")} logs</div>
        <div data-action="closeAppLogs" style="font-size:12px;font-weight:600;color:rgba(255,255,255,0.5);cursor:pointer">CLOSE</div>
      </div>
      ${
        a.error
          ? `<div style="font-size:13px;color:#f5a623">${esc(a.error)}</div>`
          : `<div data-role="appLogsBox" style="flex:1;overflow-y:auto;background:#000;border-radius:10px;padding:12px 14px;font-family:'SF Mono',ui-monospace,Menlo,monospace;font-size:12px;color:#8fd19e">
              ${a.lines.map((l) => `<div style="white-space:pre-wrap;line-height:1.6">${esc(l)}</div>`).join("")}
              ${a.lines.length === 0 ? `<div style="color:rgba(255,255,255,0.3)">${a.loading ? "Waiting for output…" : "No output yet."}</div>` : ""}
            </div>`
      }
    </div>
  </div>`;
}

function renderToast() {
  if (!state.toast) return "";
  return `<div style="position:absolute;bottom:24px;left:50%;transform:translateX(-50%);background:#0a0a0a;color:#fff;font-size:13px;font-weight:600;padding:10px 18px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.55);z-index:20">${esc(state.toast)}</div>`;
}

// Scroll positions of elements tagged with [data-scroll-key], keyed by that
// attribute's value. render() replaces app.innerHTML wholesale on every
// setState, which would otherwise snap any scrolled view (e.g. the ringtones
// list) back to the top whenever something unrelated changes (like starting
// a sound preview). Saved before the DOM is torn down, restored after.
const scrollPositions = {};

function render() {
  const app = document.getElementById("app");
  app.querySelectorAll("[data-scroll-key]").forEach((el) => {
    scrollPositions[el.getAttribute("data-scroll-key")] = el.scrollTop;
  });
  app.innerHTML = `
    ${renderTopBar()}
    <div style="flex:1;display:flex;min-height:0;position:relative">
      ${renderSidebar()}
      ${
        state.section === "media"
          ? renderMediaView()
          : state.section === "install"
          ? renderInstallView()
          : state.section === "settings"
          ? renderSettingsView()
          : state.section === "ringtones"
          ? renderRingtonesView()
          : state.section === "podcasts"
          ? renderPodcastsView()
          : state.section === "notes"
          ? renderNotesView()
          : state.section === "about"
          ? renderAboutView()
          : `${renderList()}${renderDetail()}`
      }
      ${renderAddRepoModal()}
      ${renderAddPodcastModal()}
      ${renderDropModal()}
      ${renderConfirmModal()}
      ${renderContextMenu()}
      ${renderNoteContextMenu()}
      ${renderAppLogsModal()}
      ${renderToast()}
    </div>
  `;
  wireVideoDurations();
  wireInstallDropZone();
  app.querySelectorAll("[data-scroll-key]").forEach((el) => {
    const key = el.getAttribute("data-scroll-key");
    if (key in scrollPositions) el.scrollTop = scrollPositions[key];
  });
  const logsBox = app.querySelector('[data-role="appLogsBox"]');
  if (logsBox) logsBox.scrollTop = logsBox.scrollHeight;
}

/* ---------- actions ---------- */

const actions = {
  cancelConfirm() {
    pendingConfirm = null;
    setState({ confirmDialog: null });
  },
  confirmConfirm() {
    const run = pendingConfirm;
    pendingConfirm = null;
    setState({ confirmDialog: null });
    if (run) run();
  },
  selectMedia(ds) {
    setState({ section: "media", mediaKey: ds.key, lightboxIndex: null });
  },
  openInstallView() {
    setState({ section: "install" });
  },
  openSettings() {
    setState({ section: "settings" });
    // state.osSettings may still hold whatever was cached at boot/connect
    // time — see the os-settings:refresh handler in main.js for why that can
    // be stale on the very first visit — so pull a current read each time
    // this screen is opened rather than trusting it's still accurate.
    if (state.device.status === "connected") {
      window.api.osSettingsRefresh().then(applyOsSettings).catch(() => {});
    }
  },
  openAbout() {
    setState({ section: "about" });
  },
  openRingtones() {
    setState({ section: "ringtones" });
    refreshRingtones();
  },
  openPodcasts() {
    setState({ section: "podcasts" });
    refreshPodcasts();
  },
  openAddPodcast() {
    setState({
      showAddPodcast: true,
      addPodcastMode: state.podcastSearchAvailable === false ? "rss" : "search",
      addPodcastUrl: "",
      podcastSearchQuery: "",
      podcastSearchResults: [],
      podcastSearchError: null,
    });
  },
  closeAddPodcast() {
    setState({ showAddPodcast: false });
  },
  setAddPodcastMode(ds) {
    if (state.addPodcastMode === ds.mode) return;
    setState({ addPodcastMode: ds.mode });
  },
  async searchPodcasts() {
    const term = state.podcastSearchQuery.trim();
    if (!term || state.podcastSearchLoading) return;
    setState({ podcastSearchLoading: true, podcastSearchError: null });
    try {
      const results = await window.api.podcastsSearch(term);
      setState({ podcastSearchResults: results, podcastSearchLoading: false });
    } catch (err) {
      setState({ podcastSearchLoading: false, podcastSearchError: err.message || "Search failed" });
    }
  },
  async addSearchedPodcast(ds) {
    if (state.podcastSearchAddBusy[ds.feedUrl]) return;
    setState({ podcastSearchAddBusy: { ...state.podcastSearchAddBusy, [ds.feedUrl]: true } });
    try {
      const podcasts = await window.api.podcastsAdd(ds.feedUrl);
      setState({ podcasts, podcastSearchAddBusy: { ...state.podcastSearchAddBusy, [ds.feedUrl]: false } });
    } catch (err) {
      setState({ podcastSearchAddBusy: { ...state.podcastSearchAddBusy, [ds.feedUrl]: false } });
      showToast(err.message || "Couldn't add that podcast");
    }
  },
  async submitAddPodcast() {
    const url = state.addPodcastUrl.trim();
    if (!url || state.addPodcastBusy) return;
    setState({ addPodcastBusy: true });
    try {
      const podcasts = await window.api.podcastsAdd(url);
      // main.js already sends the "Podcast added" toast once the CLI call
      // resolves — no need to show a second one here.
      setState({ showAddPodcast: false, addPodcastBusy: false, podcasts });
    } catch (err) {
      setState({ addPodcastBusy: false });
      showToast(err.message || "Couldn't add that podcast");
    }
  },
  deletePodcast(ds) {
    openConfirm({
      message: `Remove "${ds.title}" from your podcasts?`,
      confirmLabel: "Remove",
      danger: true,
      run: () => actions.performDeletePodcast(ds),
    });
  },
  async performDeletePodcast(ds) {
    setState({ podcastBusy: { ...state.podcastBusy, [ds.title]: true } });
    try {
      await window.api.podcastsRemove(ds.title);
      // Removed locally right away rather than waiting on a second `light`
      // round trip (its own Python process + a call to Light's API) just to
      // refetch a list we can already produce ourselves — that second call
      // was most of what made this feel slow. A silent background refresh
      // still follows to reconcile, in case the delete didn't actually
      // match what's on the account (e.g. a stale title).
      setState({
        podcasts: state.podcasts.filter((p) => p.title !== ds.title),
        podcastBusy: { ...state.podcastBusy, [ds.title]: false },
      });
      refreshPodcasts({ silent: true });
    } catch (err) {
      showToast(err.message || "Couldn't remove that podcast");
      setState({ podcastBusy: { ...state.podcastBusy, [ds.title]: false } });
    }
  },
  openNotes() {
    setState({ section: "notes" });
    refreshNotes();
  },
  // Opens a draft that only exists in the renderer — nothing is created on
  // the account until Save is clicked (see NEW_NOTE_ID). Silently discards
  // whatever draft was already open if this is clicked again or another
  // note is selected before saving; there's nothing server-side to clean up
  // since it was never created.
  addNote() {
    setState({
      selectedNoteId: NEW_NOTE_ID,
      noteDetail: { id: NEW_NOTE_ID, title: "", noteType: "text", updatedAt: null, content: "" },
      noteDetailLoading: false,
      noteEditTitle: "",
      noteEditContent: "",
    });
  },
  async selectNote(ds) {
    if (state.selectedNoteId === ds.id) return;
    setState({ selectedNoteId: ds.id, noteDetail: null, noteDetailLoading: true, noteEditTitle: "", noteEditContent: "" });
    try {
      const note = await window.api.notesGet(ds.id);
      // The user may have clicked another note (or navigated away) while
      // this was in flight — don't clobber whatever's selected now with a
      // response for a note that's no longer the one on screen.
      if (state.selectedNoteId !== ds.id) return;
      setState({ noteDetail: note, noteDetailLoading: false, noteEditTitle: note.title, noteEditContent: note.content || "" });
    } catch (err) {
      if (state.selectedNoteId !== ds.id) return;
      setState({ noteDetailLoading: false });
      showToast(err.message || "Couldn't load that note");
    }
  },
  // Only runs on an explicit click of the Save button — each save is its
  // own `light` invocation (a fresh Python process round-tripping to
  // Light's API), so saving on every keystroke or field blur made normal
  // typing/tabbing feel laggy. A new note (NEW_NOTE_ID) is created here for
  // the first time; after that, saves are ordinary updates.
  async saveNote() {
    const n = state.noteDetail;
    if (!n || n.noteType === "audio" || state.noteSaving || !noteIsDirty()) return;
    const title = state.noteEditTitle.trim() || "Untitled";
    const content = state.noteEditContent;
    setState({ noteSaving: true });
    try {
      const saved = n.id === NEW_NOTE_ID ? await window.api.notesCreate(title, content) : await window.api.notesUpdate(n.id, { title, content });
      const merged = { ...saved, content };
      const stillSelected = state.selectedNoteId === n.id;
      setState({
        // The save itself always went through — only the fields that reflect
        // what's on screen right now are conditional on not having navigated
        // away to a different note in the meantime.
        ...(stillSelected ? { selectedNoteId: merged.id, noteDetail: merged, noteEditTitle: merged.title } : {}),
        noteSaving: false,
        notes:
          n.id === NEW_NOTE_ID
            ? [merged, ...state.notes].sort(sortNotesByUpdated)
            : state.notes.map((x) => (x.id === n.id ? { ...x, title: merged.title, updatedAt: merged.updatedAt, preview: content.split("\n")[0] || "" } : x)).sort(sortNotesByUpdated),
      });
    } catch (err) {
      setState({ noteSaving: false });
      showToast(err.message || "Couldn't save that note");
    }
  },
  deleteNote(ds) {
    const note = state.notes.find((n) => n.id === ds.id) || state.noteDetail;
    setState({ noteContextMenu: null });
    openConfirm({
      message: `Delete "${(note && note.title) || "this note"}"? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      run: () => actions.performDeleteNote(ds),
    });
  },
  async performDeleteNote(ds) {
    setState({ noteBusy: { ...state.noteBusy, [ds.id]: true } });
    try {
      await window.api.notesRemove(ds.id);
      const wasSelected = state.selectedNoteId === ds.id;
      setState({
        notes: state.notes.filter((n) => n.id !== ds.id),
        noteBusy: { ...state.noteBusy, [ds.id]: false },
        ...(wasSelected ? { selectedNoteId: null, noteDetail: null, noteEditTitle: "", noteEditContent: "" } : {}),
      });
    } catch (err) {
      showToast(err.message || "Couldn't delete that note");
      setState({ noteBusy: { ...state.noteBusy, [ds.id]: false } });
    }
  },
  closeNoteContextMenu() {
    setState({ noteContextMenu: null });
  },
  async submitLightLogin() {
    const email = state.lightEmail.trim();
    const password = state.lightPassword;
    if (!email || !password || state.lightLoginBusy) return;
    setState({ lightLoginBusy: true, lightLoginError: null });
    try {
      const light = await window.api.lightLogin(email, password);
      // Clear the password out of renderer state the instant it's no longer
      // needed, win or lose — it has nowhere else to live once this returns.
      setState({ light, lightPassword: "", lightLoginBusy: false });
      if (light.loggedIn) {
        showToast("Signed in to Light Account");
        refreshPodcasts();
        refreshNotes();
      }
    } catch (err) {
      setState({ lightPassword: "", lightLoginBusy: false, lightLoginError: err.message || "Sign in failed" });
    }
  },
  async selectLightDevice(ds) {
    if (!ds.value || state.lightDeviceSelectBusy) return;
    setState({ lightDeviceSelectBusy: true });
    try {
      const light = await window.api.lightSelectDevice(ds.value);
      setState({ light, lightDeviceSelectBusy: false });
      showToast("Device selected");
      refreshPodcasts();
      refreshNotes();
    } catch (err) {
      setState({ lightDeviceSelectBusy: false });
      showToast(err.message || "Couldn't select that device");
    }
  },
  async lightLogout() {
    if (state.lightLogoutBusy) return;
    setState({ lightLogoutBusy: true });
    try {
      const light = await window.api.lightLogout();
      setState({ light, lightLogoutBusy: false, podcasts: [], notes: [], selectedNoteId: null, noteDetail: null });
      showToast("Signed out of Light Account");
    } catch (err) {
      setState({ lightLogoutBusy: false });
      showToast(err.message || "Sign out failed");
    }
  },
  async toggleRingtonePlayback(ds) {
    if (state.playingRingtone === ds.remote) {
      stopRingtonePlayback();
      return;
    }
    if (state.device.status !== "connected" || state.ringtonePlayLoading[ds.remote]) return;
    stopRingtonePlayback();
    setState({ ringtonePlayLoading: { ...state.ringtonePlayLoading, [ds.remote]: true } });
    try {
      const url = await window.api.ringtonesGetPlayUrl(ds.remote);
      ringtoneAudio.src = url;
      await ringtoneAudio.play();
      setState({ playingRingtone: ds.remote });
    } catch (err) {
      showToast(err.message || "Couldn't play that sound");
    } finally {
      setState({ ringtonePlayLoading: { ...state.ringtonePlayLoading, [ds.remote]: false } });
    }
  },
  async uploadRingtone(ds) {
    if (state.device.status !== "connected" || state.ringtoneBusy[ds.remote]) return;
    stopRingtonePlayback();
    setState({ ringtoneBusy: { ...state.ringtoneBusy, [ds.remote]: true } });
    try {
      const result = await window.api.ringtonesUpload(ds.remote, ds.backup);
      if (result) setState({ ringtones: result });
    } catch (err) {
      showToast(err.message || "Couldn't replace that sound");
    } finally {
      setState({ ringtoneBusy: { ...state.ringtoneBusy, [ds.remote]: false } });
    }
  },
  async restoreRingtone(ds) {
    if (state.device.status !== "connected" || state.ringtoneBusy[ds.remote]) return;
    stopRingtonePlayback();
    setState({ ringtoneBusy: { ...state.ringtoneBusy, [ds.remote]: true } });
    try {
      const result = await window.api.ringtonesRestore(ds.remote, ds.backup);
      if (result) setState({ ringtones: result });
    } catch (err) {
      showToast(err.message || "Couldn't restore that sound");
    } finally {
      setState({ ringtoneBusy: { ...state.ringtoneBusy, [ds.remote]: false } });
    }
  },
  async toggleAnimations() {
    if (state.device.status !== "connected" || state.osSettingsBusy.animations) return;
    const next = !state.osSettings.animationsOn;
    setState({ osSettingsBusy: { ...state.osSettingsBusy, animations: true } });
    try {
      const os = await window.api.osSettingsSetAnimations(next);
      setState({ osSettings: os });
    } catch (err) {
      showToast(err.message || "Couldn't change OS animations");
    } finally {
      setState({ osSettingsBusy: { ...state.osSettingsBusy, animations: false } });
    }
  },
  async toggleShowExternalTools() {
    if (state.device.status !== "connected" || state.osSettingsBusy.showExternalTools) return;
    const next = !state.osSettings.showExternalTools;
    setState({ osSettingsBusy: { ...state.osSettingsBusy, showExternalTools: true } });
    try {
      const os = await window.api.osSettingsSetShowExternalTools(next);
      setState({ osSettings: os });
    } catch (err) {
      showToast(err.message || "Couldn't change that setting");
    } finally {
      setState({ osSettingsBusy: { ...state.osSettingsBusy, showExternalTools: false } });
    }
  },
  async toggleChromiumHidden() {
    if (state.device.status !== "connected" || state.osSettingsBusy.chromium || state.osSettings.chromiumAvailable === false) return;
    const next = !state.osSettings.chromiumHidden;
    setState({ osSettingsBusy: { ...state.osSettingsBusy, chromium: true } });
    try {
      const os = await window.api.osSettingsSetChromiumHidden(next);
      setState({ osSettings: os });
    } catch (err) {
      showToast(err.message || "Couldn't change that setting");
    } finally {
      setState({ osSettingsBusy: { ...state.osSettingsBusy, chromium: false } });
    }
  },
  selectNav(ds) {
    setState({ section: "tools", nav: ds.nav, category: "all" });
  },
  selectCategory(ds) {
    setState({ section: "tools", category: ds.cat });
  },
  selectRepo(ds) {
    setState({ section: "tools", selectedId: ds.id });
  },
  openAddRepo() {
    setState({ showAddRepo: true, addRepoUrl: "" });
  },
  closeAddRepo() {
    setState({ showAddRepo: false });
  },
  async submitAddRepo() {
    const url = state.addRepoUrl.trim();
    if (!url || state.addRepoBusy) return;
    setState({ addRepoBusy: true });
    try {
      const repo = await window.api.reposAdd(url);
      setState({
        showAddRepo: false,
        addRepoBusy: false,
        nav: "repos",
        category: "all",
        selectedId: repo.id,
      });
      showToast(`${repo.name} added`);
    } catch (err) {
      setState({ addRepoBusy: false });
      showToast(err.message || "Couldn't add that repo");
    }
  },
  toggleLog(ds) {
    setState({ logOpen: { ...state.logOpen, [ds.id]: !state.logOpen[ds.id] } });
  },
  async installLatest(ds) {
    const repo = state.repos.find((r) => r.id === ds.id);
    if (!repo) return;
    const label = repo.installedVersion ? "Updating" : "Installing";
    setState({ activeRepoId: ds.id, activeLabel: label, logs: { ...state.logs, [ds.id]: [] }, logOpen: { ...state.logOpen, [ds.id]: true } });
    try {
      await window.api.installLatest(ds.id);
    } catch (err) {
      showToast(err.message || "Install failed");
    } finally {
      if (state.activeRepoId === ds.id) setState({ activeRepoId: null });
    }
  },
  async installVersion(ds) {
    const repo = state.repos.find((r) => r.id === ds.id);
    if (!repo) return;
    const label = repo.installedVersion ? "Updating" : "Installing";
    setState({ activeRepoId: ds.id, activeLabel: label, logs: { ...state.logs, [ds.id]: [] }, logOpen: { ...state.logOpen, [ds.id]: true } });
    try {
      await window.api.installStart(ds.id, ds.version);
    } catch (err) {
      showToast(err.message || "Install failed");
    } finally {
      if (state.activeRepoId === ds.id) setState({ activeRepoId: null });
    }
  },
  uninstall(ds) {
    const repo = state.repos.find((r) => r.id === ds.id);
    if (!repo) return;
    openConfirm({
      message: `Uninstall ${repo.name} from your Light Phone 3? This can't be undone.`,
      confirmLabel: "Uninstall",
      danger: true,
      run: () => actions.performUninstall(ds),
    });
  },
  async performUninstall(ds) {
    const listBefore = deriveList();
    const removedIndex = listBefore.findIndex((r) => r.id === ds.id);
    setState({ activeRepoId: ds.id, activeLabel: "Removing", logs: { ...state.logs, [ds.id]: [] }, logOpen: { ...state.logOpen, [ds.id]: true } });
    try {
      await window.api.uninstallStart(ds.id);
      // Uninstalling can drop the app out of the current view entirely (e.g.
      // it no longer belongs in "Installed") — if that's what was selected,
      // move the selection to whatever now sits at that spot in the list
      // rather than leaving detail view pointed at a row that's gone.
      if (state.selectedId === ds.id && removedIndex !== -1) {
        const listAfter = deriveList();
        if (!listAfter.some((r) => r.id === ds.id)) {
          const next = listAfter[removedIndex] || listAfter[removedIndex - 1] || null;
          setState({ selectedId: next ? next.id : null });
        }
      }
    } catch (err) {
      showToast(err.message || "Uninstall failed");
    } finally {
      if (state.activeRepoId === ds.id) setState({ activeRepoId: null });
    }
  },
  closeContextMenu() {
    setState({ contextMenu: null });
  },
  async launchApp(ds) {
    const repo = state.repos.find((r) => r.id === ds.id);
    setState({ contextMenu: null });
    if (!repo || !repo.packageId || state.device.status !== "connected") return;
    try {
      await window.api.appLaunch(ds.id);
    } catch (err) {
      showToast(err.message || "Launch failed");
    }
  },
  async viewAppLogs(ds) {
    const repo = state.repos.find((r) => r.id === ds.id);
    setState({ contextMenu: null });
    if (!repo || !repo.packageId || state.device.status !== "connected") return;
    setState({ appLogs: { repoId: ds.id, lines: [], loading: true, error: null } });
    try {
      await window.api.appLogsStart(ds.id);
    } catch (err) {
      setState({ appLogs: { repoId: ds.id, lines: [], loading: false, error: err.message || "Couldn't read logs" } });
    }
  },
  closeAppLogs() {
    window.api.appLogsStop();
    setState({ appLogs: null });
  },
  stopTracking(ds) {
    const repo = state.repos.find((r) => r.id === ds.id);
    window.api.reposRemove(ds.id);
    // If it's still installed, the entry sticks around (now untracked) so
    // there's no reason to boot the user out of the detail view for it.
    if (state.selectedId === ds.id && !(repo && repo.installedVersion)) {
      setState({ selectedId: null });
    }
    showToast(
      repo && repo.installedVersion
        ? `Stopped tracking ${repo.name} — still installed`
        : `Stopped tracking ${repo ? repo.name : "repo"}`
    );
  },
  async updateAll() {
    setState({ updateAllRunning: true });
    try {
      await window.api.installUpdateAll();
    } finally {
      setState({ updateAllRunning: false, activeRepoId: null });
    }
  },
  async refreshDevice() {
    if (state.deviceRefreshing) return;
    setState({ deviceRefreshing: true });
    try {
      await window.api.deviceRefresh();
      showToast("Refreshed");
    } finally {
      setState({ deviceRefreshing: false });
    }
  },
  rebootDevice() {
    if (state.deviceRebooting) return;
    openConfirm({
      message: "Reboot your Light Phone 3?",
      confirmLabel: "Reboot",
      danger: false,
      run: () => actions.performReboot(),
    });
  },
  async performReboot() {
    setState({ deviceRebooting: true });
    try {
      await window.api.deviceReboot();
      showToast("Rebooting…");
    } catch (err) {
      showToast(err.message || "Reboot failed");
    } finally {
      setState({ deviceRebooting: false });
    }
  },
  winMinimize() {
    window.api.windowMinimize();
  },
  async winMaximize() {
    await window.api.windowToggleMaximize();
  },
  winClose() {
    window.api.windowClose();
  },
  openRepoUrl(ds) {
    window.api.openExternal(ds.url);
  },
  async pickApkFile() {
    const filePath = await window.api.apkPickFile();
    if (!filePath) return;
    await inspectAndShowDrop(filePath);
  },
  cancelDrop() {
    setState({ drop: null, dropBusy: false });
  },
  async confirmDrop() {
    if (!state.drop || state.dropBusy) return;
    const { filePath, parsed, matchId } = state.drop;
    setState({ dropBusy: true });
    const newRepoId = matchId ? null : `sideload-${Date.now()}`;
    if (newRepoId) {
      setState({ section: "tools", nav: "installed", selectedId: newRepoId, activeRepoId: newRepoId, activeLabel: "Installing" });
    } else {
      const matchedRepo = state.repos.find((r) => r.id === matchId);
      const label = matchedRepo && matchedRepo.installedVersion ? "Updating" : "Installing";
      setState({ section: "tools", nav: "repos", selectedId: matchId, activeRepoId: matchId, activeLabel: label });
    }
    try {
      await window.api.apkInstallDropped(filePath, parsed, matchId, newRepoId);
      setState({ drop: null, dropBusy: false });
    } catch (err) {
      setState({ drop: null, dropBusy: false });
      showToast(err.message || "Install failed");
    } finally {
      setState({ activeRepoId: null });
    }
  },

  async chooseMediaBackupDir() {
    const dir = await window.api.mediaChooseBackupDir();
    if (!dir) return;
    const keys = Object.keys(state.media);
    const lists = await Promise.all(keys.map((k) => window.api.mediaList(k)));
    const media = { ...state.media };
    keys.forEach((k, i) => (media[k] = lists[i]));
    setState({ mediaBackupDir: dir, media });
  },
  openMediaBackupFolder() {
    if (!state.mediaBackupDir) return;
    window.api.mediaOpenFolder(state.mediaKey);
  },
  async backupMediaNow() {
    if (state.backupRunning) return;
    setState({ backupRunning: true });
    try {
      await window.api.mediaBackupNow();
    } catch (err) {
      showToast(err.message || "Backup failed");
    } finally {
      setState({ backupRunning: false });
    }
  },
  openLightbox(ds) {
    setState({ lightboxIndex: Number(ds.index) });
  },
  closeLightbox() {
    setState({ lightboxIndex: null });
  },
  lightboxNoop() {},
  lightboxPrev() {
    const count = currentMediaItems().length;
    if (state.lightboxIndex == null || count === 0) return;
    state.lightboxIndex = (state.lightboxIndex - 1 + count) % count;
    if (!patchLightboxImage()) render();
  },
  lightboxNext() {
    const count = currentMediaItems().length;
    if (state.lightboxIndex == null || count === 0) return;
    state.lightboxIndex = (state.lightboxIndex + 1) % count;
    if (!patchLightboxImage()) render();
  },
};

// Records osSettings and, the first time a real (non-null) value is seen
// for this device connection, freezes it as the baseline LightOS is
// actually running with — later toggles change state.osSettings but leave
// the baseline alone, so the Settings screen can tell "written to the
// settings db" apart from "in effect until a reboot". Cleared back to
// null on disconnect so the next connection captures its own baseline.
function applyOsSettings(osSettings) {
  if (osSettings.showExternalTools === null && osSettings.animationsOn === null) {
    state.osSettingsBaseline = null;
  } else if (state.osSettingsBaseline == null) {
    state.osSettingsBaseline = { ...osSettings };
  }
  setState({ osSettings });
}

function stopRingtonePlayback() {
  if (state.playingRingtone == null) return;
  ringtoneAudio.pause();
  ringtoneAudio.currentTime = 0;
  setState({ playingRingtone: null });
}

async function refreshRingtones() {
  if (state.device.status !== "connected") return;
  setState({ ringtonesLoading: true });
  try {
    const data = await window.api.ringtonesList();
    setState({ ringtones: data });
  } finally {
    setState({ ringtonesLoading: false });
  }
}

// `silent: true` is for reconciling in the background after an optimistic
// local update (see performDeletePodcast) — it fetches the same way, but
// skips the loading flag (no re-flashing "Loading…" over a list already on
// screen) and skips the error toast (a background reconcile failing isn't
// worth interrupting the user over; the next normal refresh will retry).
async function refreshPodcasts({ silent = false } = {}) {
  const light = state.light;
  const canManage = light.loggedIn && (light.devices.length <= 1 || light.selectedDeviceId);
  if (!canManage) return;
  if (!silent) setState({ podcastsLoading: true });
  try {
    const podcasts = await window.api.podcastsList();
    setState({ podcasts });
  } catch (err) {
    if (!silent) showToast(err.message || "Couldn't load podcasts");
  } finally {
    if (!silent) setState({ podcastsLoading: false });
  }
}

async function refreshNotes({ silent = false } = {}) {
  const light = state.light;
  const canManage = light.loggedIn && (light.devices.length <= 1 || light.selectedDeviceId);
  if (!canManage) return;
  if (!silent) setState({ notesLoading: true });
  try {
    const notes = await window.api.notesList();
    setState({ notes });
    // Previews are a lot slower (one extra API round trip per note — see
    // notes:listPreviews) — fetch them separately and merge in whenever
    // they land, instead of making the list wait on them to appear at all.
    // Not awaited: this runs in the background regardless of `silent`.
    enrichNotePreviews();
  } catch (err) {
    if (!silent) showToast(err.message || "Couldn't load notes");
  } finally {
    if (!silent) setState({ notesLoading: false });
  }
}

// See refreshNotes — fire-and-forget by design. `notesGeneration` guards
// against a slow previews fetch clobbering a list that's since moved on
// (e.g. the account/device was switched, or notes were added/removed)
// while it was still in flight.
let notesGeneration = 0;
async function enrichNotePreviews() {
  const generation = ++notesGeneration;
  try {
    const withPreviews = await window.api.notesListPreviews();
    if (generation !== notesGeneration) return;
    const previewById = new Map(withPreviews.map((n) => [n.id, n.preview]));
    setState({ notes: state.notes.map((n) => (previewById.has(n.id) ? { ...n, preview: previewById.get(n.id) } : n)) });
  } catch {
    // Best-effort — the list is already fully usable without previews.
  }
}

async function inspectAndShowDrop(filePath) {
  try {
    const parsed = await window.api.apkInspect(filePath);
    setState({ drop: { filePath, parsed, matchId: parsed.matchId }, dropBusy: false });
  } catch (err) {
    showToast(err.message || "Couldn't read that APK");
  }
}

/* ---------- event wiring ---------- */

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "submitOnEnter") return; // handled by keydown, not click
  const fn = actions[action];
  if (fn) fn(el.dataset, e);
});

document.addEventListener("contextmenu", (e) => {
  const noteEl = e.target.closest("[data-context-note]");
  if (noteEl) {
    e.preventDefault();
    setState({ noteContextMenu: { x: e.clientX, y: e.clientY, noteId: noteEl.dataset.contextNote } });
    return;
  }
  const el = e.target.closest("[data-context-repo]");
  if (!el) return;
  e.preventDefault();
  setState({ contextMenu: { x: e.clientX, y: e.clientY, repoId: el.dataset.contextRepo } });
});

document.addEventListener("input", (e) => {
  const bind = e.target.dataset && e.target.dataset.bind;
  if (bind) {
    state[bind] = e.target.value;
    // Deliberately not a setState() — this is exactly what keeps typing
    // from re-rendering (and losing cursor position/focus) on every
    // keystroke. But that means the Save button's disabled state, which
    // depends on noteEditTitle/noteEditContent, would otherwise only catch
    // up whenever some unrelated event happens to trigger a full render —
    // patch just that one button imperatively instead.
    if (bind === "noteEditTitle" || bind === "noteEditContent") patchNoteSaveButton();
  }
});

// Scoped to <select> specifically — the shared click listener above already
// handles every button/div with data-action, and a <select> needs "change"
// instead since choosing an option isn't a click on the element itself.
document.addEventListener("change", (e) => {
  const el = e.target.closest("select[data-action]");
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) fn({ ...el.dataset, value: el.value });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.dataset && e.target.dataset.bind) {
    if (e.target.dataset.bind === "addRepoUrl") actions.submitAddRepo();
    else if (e.target.dataset.bind === "addPodcastUrl") actions.submitAddPodcast();
    else if (e.target.dataset.bind === "podcastSearchQuery") actions.searchPodcasts();
    else if (e.target.dataset.bind === "lightEmail" || e.target.dataset.bind === "lightPassword") actions.submitLightLogin();
    // The note title is a single-line <input> — Enter saves the note
    // (same as clicking Save) rather than doing nothing, which is all a
    // plain text input does with Enter by default. The content <textarea>
    // is deliberately not handled here — Enter there needs to insert a
    // newline like normal, not trigger a save.
    else if (e.target.dataset.noteField === "title") actions.saveNote();
  }
  if (state.lightboxIndex != null) {
    if (e.key === "Escape") actions.closeLightbox();
    // Left/right are also the native seek shortcuts for a focused <video>'s
    // controls — don't fight them for videos; the on-screen ‹ › buttons
    // still work to move between clips.
    else if (currentMediaType().kind !== "video") {
      if (e.key === "ArrowLeft") actions.lightboxPrev();
      else if (e.key === "ArrowRight") actions.lightboxNext();
    }
  }
  if (state.confirmDialog && e.key === "Escape") {
    actions.cancelConfirm();
  }
});


/* ---------- IPC subscriptions ---------- */

// boot() below fetches an initial device snapshot via deviceGet() in
// parallel with several much slower calls (repo list, media folder
// listings, lightStatus() shelling out to a Python CLI) inside one
// Promise.all, then applies all of them together once every one of them
// resolves. The main process, meanwhile, starts polling and pushes its
// first device:update immediately on launch — usually well before that
// Promise.all finishes. Without this flag, boot()'s stale deviceGet()
// snapshot (captured back when it was first called, often still "none")
// would overwrite the live "connected" this listener already applied,
// which is exactly what showed up as the phone connecting and then
// immediately disconnecting again on every launch. Once a live update has
// landed, it's always newer than whatever boot() is holding, so boot()
// defers to it instead of clobbering it.
let receivedLiveDeviceUpdate = false;

window.api.onDeviceUpdate((device) => {
  receivedLiveDeviceUpdate = true;
  const justConnected = device.status === "connected" && state.device.status !== "connected";
  setState({ device });
  if (justConnected && state.section === "ringtones") refreshRingtones();
});
window.api.onOsSettingsUpdate((osSettings) => applyOsSettings(osSettings));
window.api.onReposChanged((repos) => setState({ repos }));
window.api.onInstallLog(({ repoId, line }) => {
  const existing = state.logs[repoId] || [];
  setState({ logs: { ...state.logs, [repoId]: [...existing, line] } });
});
window.api.onAppLogsLine(({ repoId, line }) => {
  if (!state.appLogs || state.appLogs.repoId !== repoId) return;
  setState({ appLogs: { ...state.appLogs, lines: [...state.appLogs.lines, line], loading: false } });
});
window.api.onToast(({ message }) => showToast(message));
window.api.onWindowMaximizedChange((maximized) => setState({ windowMaximized: maximized }));
window.api.onMediaChanged(({ key, items }) => setState({ media: { ...state.media, [key]: items } }));

document.addEventListener("dblclick", (e) => {
  if (e.target.closest("[data-titlebar]")) actions.winMaximize();
});

/* ---------- boot ---------- */

(async function boot() {
  const mediaKeys = ["photos", "screenshots", "zero", "videos"];
  const [device, repos, windowMaximized, mediaSettings, osSettings, light, podcastSearchAvailable, ...mediaLists] = await Promise.all([
    window.api.deviceGet(),
    window.api.reposList(),
    window.api.windowIsMaximized(),
    window.api.mediaGetSettings(),
    window.api.osSettingsGet(),
    window.api.lightStatus(),
    window.api.podcastsSearchAvailable(),
    ...mediaKeys.map((k) => window.api.mediaList(k)),
  ]);
  const media = {};
  mediaKeys.forEach((k, i) => (media[k] = mediaLists[i]));
  setState({
    // Only apply this — see the comment by receivedLiveDeviceUpdate above —
    // if a live device:update hasn't already superseded it.
    ...(receivedLiveDeviceUpdate ? {} : { device }),
    repos,
    windowMaximized,
    mediaBackupDir: mediaSettings.backupDir,
    mediaTypes: mediaSettings.types,
    media,
    light,
    podcastSearchAvailable,
  });
  applyOsSettings(osSettings);

  // Podcasts/notes only ever got fetched when their own sidebar item was
  // clicked, which left the sidebar's counts next to them reading 0 (their
  // initial state values) until that first visit. Load both silently in the
  // background right away instead, same as the repo refresh below, so the
  // counts are right from the moment the app opens.
  refreshPodcasts({ silent: true });
  refreshNotes({ silent: true });

  // repos:list only returns whatever releases were cached from the last
  // add/refresh — it never hits GitHub itself. Kick off a silent
  // background refresh per tracked repo on boot so "update available"
  // reflects reality without the user having to remove/re-add the repo.
  repos
    .filter((r) => !r.sideloaded)
    .forEach((r) => {
      window.api.reposRefresh(r.id).catch(() => {});
    });
})();

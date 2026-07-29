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
  section: "tools", // "tools" | "media" | "install"
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
};

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
  const updateAvailable = !!r.installedVersion && latest && !versionsEqual(releaseVersion(latest), r.installedVersion);
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
        const label = type ? type.label : key;
        const active = state.section === "media" && state.mediaKey === key;
        return `
      <div data-action="selectMedia" data-key="${esc(key)}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 22px;cursor:pointer">
        <span style="font-size:15px;font-weight:700;color:${active ? "#fff" : "rgba(255,255,255,0.55)"};text-decoration:${active ? "underline" : "none"}">${esc(label)}</span>
        <span style="font-size:12px;color:rgba(255,255,255,0.3)">${(state.media[key] || []).length}</span>
      </div>`;
      })
      .join("")}

    <div style="flex:1"></div>
    <div style="padding:0 22px">
      <div data-action="openInstallView" style="font-size:12px;color:rgba(255,255,255,0.4);cursor:pointer;text-decoration:underline">Install APK file…</div>
    </div>
  </div>`;
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
      <div data-action="selectRepo" data-id="${esc(r.id)}" style="display:flex;align-items:center;gap:12px;padding:11px 14px;margin:0 10px 2px;border-radius:12px;cursor:pointer;background:${rowBg}">
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

function renderToast() {
  if (!state.toast) return "";
  return `<div style="position:absolute;bottom:24px;left:50%;transform:translateX(-50%);background:#0a0a0a;color:#fff;font-size:13px;font-weight:600;padding:10px 18px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.55);z-index:20">${esc(state.toast)}</div>`;
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML = `
    ${renderTopBar()}
    <div style="flex:1;display:flex;min-height:0;position:relative">
      ${renderSidebar()}
      ${
        state.section === "media"
          ? renderMediaView()
          : state.section === "install"
          ? renderInstallView()
          : `${renderList()}${renderDetail()}`
      }
      ${renderAddRepoModal()}
      ${renderDropModal()}
      ${renderConfirmModal()}
      ${renderToast()}
    </div>
  `;
  wireVideoDurations();
  wireInstallDropZone();
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
    setState({ activeRepoId: ds.id, activeLabel: "Removing", logs: { ...state.logs, [ds.id]: [] }, logOpen: { ...state.logOpen, [ds.id]: true } });
    try {
      await window.api.uninstallStart(ds.id);
    } catch (err) {
      showToast(err.message || "Uninstall failed");
    } finally {
      if (state.activeRepoId === ds.id) setState({ activeRepoId: null });
    }
  },
  stopTracking(ds) {
    const repo = state.repos.find((r) => r.id === ds.id);
    window.api.reposRemove(ds.id);
    if (state.selectedId === ds.id) setState({ selectedId: null });
    showToast(`Stopped tracking ${repo ? repo.name : "repo"}`);
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

document.addEventListener("input", (e) => {
  const bind = e.target.dataset && e.target.dataset.bind;
  if (bind) {
    state[bind] = e.target.value;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.dataset && e.target.dataset.bind === "addRepoUrl") {
    actions.submitAddRepo();
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

window.api.onDeviceUpdate((device) => setState({ device }));
window.api.onReposChanged((repos) => setState({ repos }));
window.api.onInstallLog(({ repoId, line }) => {
  const existing = state.logs[repoId] || [];
  setState({ logs: { ...state.logs, [repoId]: [...existing, line] } });
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
  const [device, repos, windowMaximized, mediaSettings, ...mediaLists] = await Promise.all([
    window.api.deviceGet(),
    window.api.reposList(),
    window.api.windowIsMaximized(),
    window.api.mediaGetSettings(),
    ...mediaKeys.map((k) => window.api.mediaList(k)),
  ]);
  const media = {};
  mediaKeys.forEach((k, i) => (media[k] = mediaLists[i]));
  setState({
    device,
    repos,
    windowMaximized,
    mediaBackupDir: mediaSettings.backupDir,
    mediaTypes: mediaSettings.types,
    media,
  });
})();

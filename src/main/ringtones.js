"use strict";

const RINGTONE_DIR = "/sdcard/Ringtones";

// /sdcard is a symlink to /storage/emulated/0 — reads/writes/mv/rm all work
// fine through it, but the media scanner broadcast needs the real path to
// reliably match what it has indexed.
const RINGTONE_DIR_CANONICAL = "/storage/emulated/0/Ringtones";

function titleCase(key) {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Splits a filename from `ls /sdcard/Ringtones` into what this feature cares
// about: which "kind" it is (the live file, or the backup of one we've
// overridden) and its key (whatever comes after the prefix — "bubbles" out
// of "ringtone_bubbles.m4a"). Returns null for anything else in that folder.
function parseFilename(filename) {
  const backupMatch = filename.match(/^backup_(ringtone|alerttone)_(.+)\.m4a$/i);
  if (backupMatch) return { kind: "backup", prefix: backupMatch[1].toLowerCase(), key: backupMatch[2] };
  const match = filename.match(/^(ringtone|alerttone)_(.+)\.m4a$/i);
  if (match) return { kind: "active", prefix: match[1].toLowerCase(), key: match[2] };
  return null;
}

// Builds the { ringtones, alerts } table rows for the Ringtones & Alerts
// screen from a raw directory listing plus the locally-persisted override
// name map (device filename -> the original uploaded filename). The device
// itself only ever holds the standardized "ringtone_<key>.m4a" name once a
// custom sound is pushed, so the human-friendly original name has to be
// remembered locally (see store.js's ringtoneOverrides).
function buildEntries(filenames, overrides) {
  const active = new Map(); // "prefix:key" -> { prefix, key, filename }
  const backups = new Set(); // "prefix:key"

  for (const filename of filenames) {
    const parsed = parseFilename(filename);
    if (!parsed) continue;
    const id = `${parsed.prefix}:${parsed.key}`;
    if (parsed.kind === "backup") backups.add(id);
    else active.set(id, { prefix: parsed.prefix, key: parsed.key, filename });
  }

  const ringtones = [];
  const alerts = [];
  for (const [id, entry] of active) {
    const row = {
      id,
      prefix: entry.prefix,
      key: entry.key,
      remoteFilename: entry.filename,
      backupFilename: `backup_${entry.prefix}_${entry.key}.m4a`,
      deviceName: titleCase(entry.key),
      overrideName: overrides[entry.filename] || null,
      hasBackup: backups.has(id),
    };
    (entry.prefix === "ringtone" ? ringtones : alerts).push(row);
  }
  ringtones.sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  alerts.sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  return { ringtones, alerts };
}

module.exports = { RINGTONE_DIR, RINGTONE_DIR_CANONICAL, buildEntries };

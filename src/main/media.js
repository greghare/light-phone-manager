"use strict";

const fs = require("fs");
const path = require("path");
const { nativeImage } = require("electron");
const adb = require("./adb");

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|3gp)$/i;

// Each of these is an adb-visible path — the same "Internal shared storage"
// root Windows shows (with the phone's USB preference set to "Media
// transfer") under This PC\<device>\..., just read straight off the device
// over the same adb connection used for everything else, since MTP-mounted
// storage isn't a real filesystem path Node can read (and is Windows-only
// besides). Override any of these with the matching env var if a path is
// wrong for your phone.
const MEDIA_TYPES = {
  photos: {
    key: "photos",
    label: "Photos",
    kind: "image",
    localDirName: "Photos",
    devicePath: process.env.LTM_PHOTOS_PATH || "/sdcard/Pictures/Light",
  },
  screenshots: {
    key: "screenshots",
    label: "Screenshots",
    kind: "image",
    localDirName: "Screenshots",
    devicePath: process.env.LTM_SCREENSHOTS_PATH || "/sdcard/Pictures/Screenshots",
  },
  zero: {
    key: "zero",
    label: "Zero",
    kind: "image",
    localDirName: "Zero",
    devicePath: process.env.LTM_ZERO_PATH || "/sdcard/Pictures/Zero",
  },
  videos: {
    key: "videos",
    label: "Videos",
    kind: "video",
    localDirName: "Videos",
    devicePath: process.env.LTM_VIDEOS_PATH || "/sdcard/Movies",
  },
};

const THUMBS_DIRNAME = ".thumbnails";
const THUMB_MAX_DIMENSION = 480;
const THUMB_JPEG_QUALITY = 78;

function extFor(mediaType) {
  return mediaType.kind === "video" ? VIDEO_EXT : IMAGE_EXT;
}

function localDirFor(backupDir, mediaType) {
  return path.join(backupDir, mediaType.localDirName);
}

async function listDeviceMedia(serial, mediaType) {
  const files = await adb.listFiles(serial, mediaType.devicePath);
  const ext = extFor(mediaType);
  return files.filter((f) => ext.test(f));
}

// Copies any device file for this media type not already present locally
// (by filename) into its subfolder under backupDir. Returns how many new
// files were copied.
async function backupMedia(serial, backupDir, mediaType) {
  if (!backupDir) return 0;
  const dir = localDirFor(backupDir, mediaType);
  fs.mkdirSync(dir, { recursive: true });

  // Clean up partial downloads left behind by a previous crashed/interrupted run.
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".part")) fs.rmSync(path.join(dir, f), { force: true });
  }

  const remoteFiles = await listDeviceMedia(serial, mediaType);
  const existing = new Set(fs.readdirSync(dir));
  const missing = remoteFiles.filter((f) => !existing.has(f));

  let copied = 0;
  for (const name of missing) {
    const remotePath = `${mediaType.devicePath}/${name}`;
    const tmpPath = path.join(dir, `.${name}.part`);
    const finalPath = path.join(dir, name);
    try {
      await adb.pullFile(serial, remotePath, tmpPath);
      fs.renameSync(tmpPath, finalPath);
      copied++;
    } catch (err) {
      fs.rm(tmpPath, { force: true }, () => {});
      console.error(`Failed to back up ${mediaType.label} file ${name}:`, err.message);
    }
  }
  return copied;
}

function thumbPathFor(backupDir, mediaType, name) {
  return path.join(localDirFor(backupDir, mediaType), THUMBS_DIRNAME, `${name}.jpg`);
}

function listBackedUpMedia(backupDir, mediaType) {
  const dir = localDirFor(backupDir, mediaType);
  if (!backupDir || !fs.existsSync(dir)) return [];
  const ext = extFor(mediaType);
  return fs
    .readdirSync(dir)
    .filter((f) => ext.test(f) && !f.startsWith("."))
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      return { name, path: filePath, thumbPath: thumbPathFor(backupDir, mediaType, name), mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Builds a small cached JPEG thumbnail for any image that doesn't have an
// up-to-date one yet, using Electron's built-in image decoder (no extra
// native dependency to bundle). This is what the gallery grid should show —
// loading full-resolution originals into <img> tags is what makes a big
// gallery slow to scroll. Yields to the event loop between each image so a
// big backlog (e.g. the first run against an existing folder of 100+ files)
// doesn't block adb polling / IPC while it works. Videos don't go through
// here — nativeImage can't decode them, so the renderer reads a frame
// straight off the backed-up video file instead.
async function ensureThumbnails(backupDir, mediaType, items) {
  if (mediaType.kind !== "image") return 0;
  const thumbDir = path.join(localDirFor(backupDir, mediaType), THUMBS_DIRNAME);
  fs.mkdirSync(thumbDir, { recursive: true });

  let built = 0;
  for (const p of items) {
    try {
      const needsBuild = !fs.existsSync(p.thumbPath) || fs.statSync(p.thumbPath).mtimeMs < p.mtimeMs;
      if (needsBuild) {
        const img = nativeImage.createFromPath(p.path);
        if (!img.isEmpty()) {
          const { width, height } = img.getSize();
          const scale = Math.min(1, THUMB_MAX_DIMENSION / Math.max(width, height || 1));
          const resized =
            scale < 1
              ? img.resize({
                  width: Math.max(1, Math.round(width * scale)),
                  height: Math.max(1, Math.round(height * scale)),
                  quality: "good",
                })
              : img;
          fs.writeFileSync(p.thumbPath, resized.toJPEG(THUMB_JPEG_QUALITY));
          built++;
        }
      }
    } catch (err) {
      console.error(`Failed to build thumbnail for ${p.name}:`, err.message);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return built;
}

module.exports = {
  MEDIA_TYPES,
  localDirFor,
  listDeviceMedia,
  backupMedia,
  listBackedUpMedia,
  ensureThumbnails,
};

"use strict";

// Demand-load just the APK parser (avoids pulling in the .ipa/plist code path).
const ApkParser = require("app-info-parser/src/apk");

// app-info-parser always labels the icon it extracts as "image/png" and
// doesn't check what it actually picked — for APKs whose manifest icon
// resolves to an adaptive-icon XML descriptor (res/mipmap-anydpi-v26/*.xml,
// common on modern Android) rather than a raster file, or to a real image
// in a different format (e.g. WEBP), the resulting data URI either isn't an
// image at all or is mislabeled, and browsers show a broken-image icon
// instead of sniffing the real content. Detect the real format from the
// file's magic bytes and relabel it, or drop it (falling back to the
// letter-avatar placeholder) if it isn't a raster image at all.
function sniffImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

function fixIconDataUri(dataUri) {
  if (!dataUri) return null;
  const match = /^data:[^;]+;base64,(.+)$/s.exec(dataUri);
  if (!match) return null;
  const buf = Buffer.from(match[1], "base64");
  const mime = sniffImageMime(buf);
  if (!mime) return null;
  return `data:${mime};base64,${match[1]}`;
}

// Parses an .apk file's AndroidManifest.xml (and resources.arsc, if present)
// entirely in JS — no aapt/build-tools binary required.
async function parseApk(filePath) {
  const parser = new ApkParser(filePath);
  const info = await parser.parse();
  const label = info.application && info.application.label;
  return {
    packageId: info.package || null,
    versionName: info.versionName != null ? String(info.versionName) : null,
    versionCode: info.versionCode != null ? String(info.versionCode) : null,
    appName: typeof label === "string" && label.trim() ? label.trim() : null,
    icon: fixIconDataUri(info.icon), // "data:image/<real format>;base64,..." or null
  };
}

module.exports = { parseApk, fixIconDataUri };

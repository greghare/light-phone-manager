"use strict";

// One-off: rasterizes Lightphone-3.svg into build/icon.png (the source
// electron-builder auto-generates .icns/.ico/Linux icon sets from). Uses a
// hidden BrowserWindow + capturePage() instead of a native SVG rasterizer
// (e.g. sharp/resvg) since Electron itself is already a project dependency
// and Chromium renders SVG natively — no extra npm packages needed. Not
// part of the app itself; run manually with `npx electron scripts/generate-icon.js`
// whenever the source SVG changes.

const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SIZE = 1024;
const svgPath = path.join(__dirname, "..", "Lightphone-3.svg");
const outPath = path.join(__dirname, "..", "build", "icon.png");

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, "utf8");
  // Leave headroom around the phone (icon.png is used full-bleed on
  // Windows/Linux but macOS additionally insets it into a rounded-square
  // mask, so content flush with the edges gets clipped there).
  const html = `<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; }
  svg { height: 84%; width: auto; display: block; }
</style></head>
<body>${svg}</body></html>`;
  const tmpHtml = path.join(os.tmpdir(), "ltm-icon-src.html");
  fs.writeFileSync(tmpHtml, html);

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
    webPreferences: { offscreen: false },
  });

  await win.loadFile(tmpHtml);
  // Let the (large, gradient-heavy) SVG finish painting before capturing.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, image.toPNG());
  console.log(`Wrote ${outPath} at ${JSON.stringify(image.getSize())}`);

  fs.rmSync(tmpHtml, { force: true });
  app.quit();
});

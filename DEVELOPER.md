# Developer README

This covers building and running Light Phone Manager from source. For
end-user installation, see the [main README](README.md).

## Requirements

- Node.js 18+ and npm.
- A Light Phone 3 (or any Android device) with **USB debugging** enabled
  under Settings → Developer options, connected via USB, with the "Allow USB
  debugging" prompt accepted on the device.

## Media backup

The sidebar's "Media" section has four galleries: Photos, Screenshots, Zero
(that tool's own saved images), and Videos. Choose a backup folder from any of
them and it works like a simple Windows Photos/Google Backup equivalent:
every time the phone is connected, any file not already backed up gets
copied over automatically (safe to leave the tool running — nothing is ever
deleted or re-copied), organized into a matching subfolder (`Photos/`,
`Screenshots/`, `Zero/`, `Videos/`) inside the one backup folder you picked.
Each gallery shows its local, backed-up copies.

This doesn't use Windows' `This PC\<device>\Internal shared storage\...`
MTP path directly — MTP-mounted storage isn't a real filesystem path Node
can read, and it's Windows-only anyway. Instead the tool reads these paths on
the device over the same `adb` connection used for everything else ("Internal
shared storage" is `/sdcard` internally, on any platform):

| Gallery     | Device path                    | Override env var        |
| ----------- | ------------------------------- | ------------------------ |
| Photos      | `/sdcard/Pictures/Light`        | `LTM_PHOTOS_PATH`         |
| Screenshots | `/sdcard/Pictures/Screenshots`  | `LTM_SCREENSHOTS_PATH`    |
| Zero        | `/sdcard/Pictures/Zero`         | `LTM_ZERO_PATH`           |
| Videos      | `/sdcard/Pictures/Movies`       | `LTM_VIDEOS_PATH`         |

If any of these are wrong for your phone, set the matching environment
variable before launching.

The Photos/Screenshots/Zero grids only ever load small cached thumbnails
(built with Electron's built-in image decoder, resized to a max of 480px),
never the full-resolution originals — those are only decoded full-size when
you open one in the lightbox. Thumbnails are generated in the background and
cached in a `.thumbnails` subfolder inside each gallery's backup folder, so a
tile may briefly appear empty right after a big first-time backup (or the
first run after pointing the tool at an existing folder of photos) while its
thumbnail is still being built; it fills in on its own within a few seconds,
and every run after that is instant. The Videos grid shows each clip's own
first frame directly (no separate thumbnail file) with its duration
overlaid, and clicking one plays it right in the tool (with the same
prev/next controls as the photo lightbox).

## Getting started

```sh
npm install
npm run fetch-platform-tools   # downloads adb for win/mac/linux into resources/
npm start
```

`fetch-platform-tools` only needs to run once (or after clearing
`resources/platform-tools/`); it pulls the official Google Android SDK
Platform Tools zip for each OS and keeps just the `adb` binary (see
`scripts/fetch-platform-tools.js`). If it's skipped or fails for your
platform, the tool falls back to an `adb` found on your system `PATH`, or a
path you set via the `LTM_ADB_PATH` environment variable.

## Building installers

```sh
npm run dist:win     # NSIS installer for Windows
npm run dist:mac     # dmg for macOS
npm run dist:linux   # AppImage for Linux
npm run dist         # build for the current host platform
```

`predist` automatically runs `fetch-platform-tools` first so the right `adb`
binary gets bundled into `resources/platform-tools/<platform>` before
packaging. Each installer only bundles the `adb` for its own OS/arch.

Note: like most Electron tooling, cross-compiling (e.g. building the macOS
dmg from Windows) isn't supported by electron-builder — build each target on
its own OS, or use a CI matrix.

## How data is stored

Tracked repos and cached downloaded APKs live in your OS's app data folder
(Electron's `userData` — e.g. `%APPDATA%/Light Phone Manager` on
Windows, `~/Library/Application Support/Light Phone Manager` on macOS,
`~/.config/Light Phone Manager` on Linux). Nothing is sent anywhere
except direct requests to `api.github.com` and `github.com` (release
downloads) for the repos you add.

## GitHub API rate limits

Unauthenticated requests to the GitHub API are limited to 60/hour per IP,
which is normally plenty for a personal set of tracked repos. If you hit the
limit, set a `GITHUB_TOKEN` environment variable (a plain
[personal access token](https://github.com/settings/tokens), no scopes
needed for public repos) before launching the tool to raise it to 5,000/hour.

## Project layout

```
src/main/       Electron main process — adb wrapper, GitHub client, APK
                manifest parser, local JSON store, IPC handlers
src/main/preload.js   Narrow contextBridge API exposed to the renderer
src/renderer/   UI (vanilla HTML/CSS/JS, no framework/bundler)
scripts/        Build-time platform-tools fetcher
resources/      Bundled adb binaries land here (gitignored, fetched on demand)
```

## Known limitations

- Only one connected Android device is supported at a time; if multiple are
  plugged in, unplug the extras.
- A release's APK asset is picked automatically (the first non-"debug" named
  `.apk` in that GitHub release) — if a repo publishes multiple APKs per
  release (e.g. per-ABI splits) with no clearer naming, the wrong one might
  be picked.
- Reinstalling a sideloaded (drag-and-dropped) tool after uninstalling it
  requires dragging the `.apk` file in again — its file isn't kept around
  after install.

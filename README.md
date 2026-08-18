# Light Phone Manager

A cross-platform desktop tool (Electron) for managing sideloaded tools on your
[Light Phone 3](https://www.thelightphone.com/) and providing automatic media backups. 
Track community tool repos on GitHub, install and update them over USB with one click, or drag-and-drop an
`.apk` file directly onto the tool. `adb` (Android Debug Bridge) is bundled in
— no separate Android SDK install required.

<img width="1586" height="1025" alt="Screenshot 2026-07-29 003741" src="https://github.com/user-attachments/assets/b43b6671-34c3-4b28-93cc-5ddcab61a522" />

<img width="1512" height="973" alt="Screenshot 2026-07-29 004101" src="https://github.com/user-attachments/assets/5a82db65-c9e7-4b36-88bf-333f5e3d7c0e" />

## Features

- **Track GitHub repos** — paste a `github.com/author/tool` URL and the tool
  reads its GitHub Releases, figures out the Android package name/version by
  parsing the APK itself (no `aapt`/Android SDK needed), and shows install
  status.
- **Install / update / uninstall** over USB via bundled `adb`, with live
  command output. Uninstalling asks for confirmation first, since it can't be
  undone.
- **Update all** installed tools that have a newer release in one click.
- **Drag-and-drop** an `.apk` anywhere on the window (or use "Install APK
  file…") to sideload it — automatically matched against a tracked repo if
  the package ID matches, otherwise added as a standalone sideloaded tool.
- Live device status (connected/unauthorized/model/Android version/free
  storage), polled automatically — no manual "connect" step.
- Tools already on the phone (sideloaded before you started using this tool)
  are auto-discovered and listed under the "On Device" category.
- **Media** — Photos, Screenshots, Zero, and Videos galleries, with automatic
  backup to a folder you choose on your PC every time the phone is connected.
  See [Media backup](DEVELOPER.md#media-backup) in the developer README.
- **Notes** — browse, create, edit, and delete notes on your Light Account,
  synced the same way the official Light tools do. Audio notes are listed but
  can't yet be played or edited from here.
- **Podcasts** — browse the podcasts you follow on your Light Account, search
  for new ones (via Apple's Search API) or add one directly by its RSS feed
  URL, and remove ones you no longer want.

## Requirements

- A Light Phone 3 (or any Android device) with **USB debugging** enabled
  under Settings → Developer options, connected via USB, with the "Allow USB
  debugging" prompt accepted on the device.

## Installation

Download the latest build for your platform from the
[GitHub Releases page](https://github.com/greghare/light-phone-manager/releases/latest).

- **Windows** — download the `.exe` installer and run it.
- **macOS** — download the `.dmg`, open it, and drag Light Phone Manager into
  Applications. Since the app isn't notarized/signed, macOS will refuse to
  open it until you clear the quarantine flag — run this once from Terminal
  after installing:
  ```sh
  xattr -cr "/Applications/Light Phone Manager.app"
  ```
- **Linux** — download either the `.AppImage` (make it executable with
  `chmod +x`, then run it directly) or the `.deb` (install with
  `sudo dpkg -i <file>.deb` or your distro's package installer).

## Developer guide

For building/running from source, the project layout, media backup details,
GitHub API rate limits, and known limitations, see the
[Developer README](DEVELOPER.md).

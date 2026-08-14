#!/usr/bin/env node
// Vendors the Light CLI (`light-phone-cli-tui` on PyPI, github.com/garado/light)
// into resources/light-cli/<platform>/ so it ships inside the app instead of
// requiring the user to `pip install` it themselves — see lightPath.js for
// how light.js finds and runs the result, and resources/README-light-cli.txt
// for what's actually in there and its (GPL-3.0, separate from this app's
// MIT license) licensing.
//
// It's a pure-Python package with one compiled dependency (rapidfuzz), and
// every one of them publishes prebuilt wheels for every platform this app
// targets — so rather than needing a build machine per OS, this fetches:
//   1. A portable CPython build for each OS from python-build-standalone.
//   2. The full dependency wheel closure for that OS's wheel tags, via the
//      *host* machine's own pip (`pip download --platform ...` fetches
//      wheels for a foreign platform without executing any of their code,
//      so a single machine can assemble all three OS bundles).
// ...then unpacks those wheels straight into that Python's site-packages.
// No target-platform execution ever happens here — see the "PLATFORM
// MARKER CAVEAT" note below for the one accuracy tradeoff that comes with
// not executing on the target platform.
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const { execFileSync } = require("child_process");

const RESOURCES_DIR = path.join(__dirname, "..", "resources", "light-cli");

// Bump these together when a newer light-phone-cli-tui is out, or when
// python-build-standalone cuts a new release — check
// https://github.com/astral-sh/python-build-standalone/releases for a tag
// whose assets include an "install_only" build for this PY_VERSION.
const PBS_TAG = "20260804";
const PY_VERSION = "3.11.15";
const PY_MINOR = "3.11"; // site-packages dir on posix is lib/python<PY_MINOR>/site-packages
const LIGHT_CLI_SPEC = "light-phone-cli-tui==0.3.0";

// electron-builder platform key -> where to get a CPython for it, and which
// wheel platform tag matches it on PyPI. One x86_64 build per OS, same as
// fetch-platform-tools.js does for adb — an arm64 host runs it through the
// OS's own x86_64 emulation (Rosetta on mac, Prism on Windows-on-ARM; on
// Linux there's no such fallback, so arm64 Linux isn't supported here yet).
const TARGETS = {
  win32: {
    pbsTriple: "x86_64-pc-windows-msvc",
    wheelPlatform: "win_amd64",
    pythonBin: path.join("python", "python.exe"),
    sitePackages: path.join("python", "Lib", "site-packages"),
  },
  darwin: {
    pbsTriple: "x86_64-apple-darwin",
    wheelPlatform: "macosx_11_0_x86_64",
    pythonBin: path.join("python", "bin", "python3"),
    sitePackages: path.join("python", "lib", `python${PY_MINOR}`, "site-packages"),
  },
  linux: {
    pbsTriple: "x86_64-unknown-linux-gnu",
    // manylinux_2_28 = glibc 2.28+ (Ubuntu 20.04+, Debian 11+, RHEL 8+,
    // Fedora 29+) — rapidfuzz 3.14+ no longer publishes manylinux2014 wheels.
    wheelPlatform: "manylinux_2_28_x86_64",
    pythonBin: path.join("python", "bin", "python3"),
    sitePackages: path.join("python", "lib", `python${PY_MINOR}`, "site-packages"),
  },
};

function download(url, destFile, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects: " + url));
    const file = fs.createWriteStream(destFile);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destFile);
          return resolve(download(res.headers.location, destFile, redirects + 1));
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destFile);
          return reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        file.close();
        fs.rm(destFile, { force: true }, () => {});
        reject(err);
      });
  });
}

// Finds a Python interpreter on this (the *build*) machine — only used at
// build time to run pip; the app itself never needs Python installed, since
// it ships its own (see resolveLightCommand in lightPath.js).
function findHostPython() {
  for (const candidate of ["python3", "python"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "No Python interpreter found on PATH. fetch-light-cli.js needs one (any recent Python 3) at build time to run pip; the packaged app itself does not."
  );
}

async function fetchOne(platformKey, hostPython) {
  const target = TARGETS[platformKey];
  const destDir = path.join(RESOURCES_DIR, platformKey);
  const marker = path.join(destDir, ".version");
  const expectedMarker = `${PBS_TAG}|${PY_VERSION}|${LIGHT_CLI_SPEC}`;

  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === expectedMarker) {
    console.log(`[light-cli] ${platformKey}: already present, skipping (delete ${destDir} to refetch)`);
    return;
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "light-cli-"));
  try {
    // 1. Portable CPython.
    const pyUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PY_VERSION}+${PBS_TAG}-${target.pbsTriple}-install_only.tar.gz`;
    const pyTar = path.join(tmpDir, "python.tar.gz");
    console.log(`[light-cli] ${platformKey}: downloading Python from ${pyUrl}`);
    await download(pyUrl, pyTar);
    console.log(`[light-cli] ${platformKey}: extracting Python`);
    execFileSync("tar", ["-xzf", pyTar, "-C", destDir]);
    if (platformKey !== "win32") {
      execFileSync("chmod", ["+x", path.join(destDir, target.pythonBin)]);
    }

    // 2. The light-phone-cli-tui wheel closure for this platform's tags.
    // NB: pip resolves PEP 508 environment markers (e.g. `sys_platform ==
    // "win32"`) against the *host* running pip, not the --platform target,
    // since pip has no way to fully impersonate a foreign OS. In practice
    // this only pulls in one harmless extra (pywin32-ctypes, a Windows-only
    // keyring shim, ending up in the mac/linux bundles too) rather than
    // dropping anything this app's read-only `devices`/`podcasts` commands
    // need — but it's worth knowing about if a future dependency bump ever
    // needs something OS-specific here.
    const wheelsDir = path.join(tmpDir, "wheels");
    fs.mkdirSync(wheelsDir);
    console.log(`[light-cli] ${platformKey}: downloading ${LIGHT_CLI_SPEC} + deps for ${target.wheelPlatform}`);
    execFileSync(hostPython, [
      "-m", "pip", "download", LIGHT_CLI_SPEC,
      "-d", wheelsDir,
      "--python-version", PY_MINOR,
      "--platform", target.wheelPlatform,
      "--implementation", "cp",
      "--abi", `cp${PY_MINOR.replace(".", "")}`,
      "--only-binary", ":all:",
    ], { stdio: "inherit" });

    // 3. Unpack every wheel into the bundled interpreter's site-packages,
    // all in one pip invocation — installing them one at a time makes pip
    // refuse to merge shared namespace-package directories (e.g. jaraco.*)
    // across separate --target calls.
    const sitePackages = path.join(destDir, target.sitePackages);
    fs.mkdirSync(sitePackages, { recursive: true });
    const wheels = fs.readdirSync(wheelsDir).filter((f) => f.endsWith(".whl")).map((f) => path.join(wheelsDir, f));
    console.log(`[light-cli] ${platformKey}: installing ${wheels.length} wheels into ${sitePackages}`);
    execFileSync(hostPython, [
      "-m", "pip", "install",
      "--no-deps", "--no-user",
      "--target", sitePackages,
      ...wheels,
    ], { stdio: "inherit" });

    fs.writeFileSync(marker, expectedMarker);
    console.log(`[light-cli] ${platformKey}: done -> ${destDir}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const arg = process.argv[2] || "all";
  const keys = arg === "all" ? Object.keys(TARGETS) : [arg];
  for (const k of keys) {
    if (!TARGETS[k]) {
      console.error(`Unknown platform "${k}". Expected one of: all, ${Object.keys(TARGETS).join(", ")}`);
      process.exit(1);
    }
  }
  const hostPython = findHostPython();
  for (const k of keys) {
    await fetchOne(k, hostPython);
  }
}

main().catch((err) => {
  console.error(`[light-cli] FAILED — ${err.message}`);
  console.error(`[light-cli] The app will fall back to a "light" found on PATH (or LTM_LIGHT_PATH) at runtime, but packaged builds are meant to ship it bundled.`);
  process.exit(1);
});

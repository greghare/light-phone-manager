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
// keyring (a light-phone-api dependency, used to cache the CLI's login
// token between runs) pulls in jaraco.context, which on Python < 3.12
// unconditionally imports the `backports.tarfile` backport package. keyring
// itself also has a `compat/py312.py` shim that unconditionally imports
// `importlib_metadata` on Python < 3.12. Both requirements are declared with
// a `python_version < "3.12"` marker in the respective package's own
// metadata, but pip evaluates markers like that against the *host*
// interpreter running pip, not the --python-version override below (same
// "PLATFORM MARKER CAVEAT" as sys_platform, noted where that override is
// used) — so on a host whose own Python doesn't happen to match (e.g. it has
// Python 3.12+ on PATH), pip silently drops both from the resolved set and
// they're missing at runtime (ModuleNotFoundError: No module named
// 'backports' / 'importlib_metadata'). Listed explicitly here so they're
// always included regardless of what's resolving it.
const LIGHT_CLI_SPEC = ["light-phone-cli-tui==0.3.0", "backports.tarfile", "importlib_metadata"];

// electron-builder platform key -> where to get a CPython for it, and which
// wheel platform tag(s) match it on PyPI. One x86_64 build per OS, same as
// fetch-platform-tools.js does for adb — an arm64 host runs it through the
// OS's own x86_64 emulation (Rosetta on mac, Prism on Windows-on-ARM; on
// Linux there's no such fallback, so arm64 Linux isn't supported here yet).
//
// wheelPlatforms is a list, not a single tag, because pip's --platform
// filter is an exact match with no awareness that manylinux tags nest
// (a manylinux_2_17 wheel installs fine on a manylinux_2_28 system, being
// the older/broader ABI) — asking for only the newest tag makes pip treat
// any package that hasn't republished under it as having no compatible
// wheel at all. That's exactly what happened with cffi (a transitive dep of
// keyring's optional Linux SecretStorage backend, via cryptography): it had
// no manylinux_2_28 wheel, so pip kept downgrading cryptography looking for
// one that would let it avoid needing cffi at all, ran out of versions, and
// failed the whole resolution. Listing progressively older/broader tags as
// fallbacks lets pip pick whichever one each individual package actually
// published — newest first so rapidfuzz (which dropped anything older than
// manylinux_2_28) still gets it.
const TARGETS = {
  win32: {
    pbsTriple: "x86_64-pc-windows-msvc",
    wheelPlatforms: ["win_amd64"],
    pythonBin: path.join("python", "python.exe"),
    sitePackages: path.join("python", "Lib", "site-packages"),
  },
  darwin: {
    pbsTriple: "x86_64-apple-darwin",
    wheelPlatforms: ["macosx_11_0_x86_64", "macosx_10_9_x86_64"],
    pythonBin: path.join("python", "bin", "python3"),
    sitePackages: path.join("python", "lib", `python${PY_MINOR}`, "site-packages"),
  },
  linux: {
    pbsTriple: "x86_64-unknown-linux-gnu",
    wheelPlatforms: ["manylinux_2_28_x86_64", "manylinux_2_17_x86_64", "manylinux2014_x86_64"],
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
  const expectedMarker = `${PBS_TAG}|${PY_VERSION}|${LIGHT_CLI_SPEC.join(",")}`;

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
    const platformArgs = target.wheelPlatforms.flatMap((p) => ["--platform", p]);
    console.log(`[light-cli] ${platformKey}: downloading ${LIGHT_CLI_SPEC.join(", ")} + deps for ${target.wheelPlatforms.join("/")}`);
    execFileSync(hostPython, [
      "-m", "pip", "download", ...LIGHT_CLI_SPEC,
      "-d", wheelsDir,
      "--python-version", PY_MINOR,
      ...platformArgs,
      "--implementation", "cp",
      "--abi", `cp${PY_MINOR.replace(".", "")}`,
      "--only-binary", ":all:",
    ], { stdio: "inherit" });

    // 3. Unpack every wheel into the bundled interpreter's site-packages,
    // all in one pip invocation — installing them one at a time makes pip
    // refuse to merge shared namespace-package directories (e.g. jaraco.*)
    // across separate --target calls.
    //
    // Needs the same --platform/--python-version/--implementation/--abi
    // overrides as the download step above, and for the same reason: pip
    // install (just like pip download) otherwise checks wheel compatibility
    // against the *host* interpreter running pip, not the target platform.
    // Every dependency here is a pure-Python "py3-none-any" wheel except
    // rapidfuzz, which is compiled and tagged cp311-<target> — that's the
    // one pip actually rejects when the host interpreter's own tags (e.g. a
    // different Python version, or 32-bit on a 64-bit target) don't match.
    const sitePackages = path.join(destDir, target.sitePackages);
    fs.mkdirSync(sitePackages, { recursive: true });
    const wheels = fs.readdirSync(wheelsDir).filter((f) => f.endsWith(".whl")).map((f) => path.join(wheelsDir, f));
    console.log(`[light-cli] ${platformKey}: installing ${wheels.length} wheels into ${sitePackages}`);
    execFileSync(hostPython, [
      "-m", "pip", "install",
      "--no-deps", "--no-user",
      "--target", sitePackages,
      "--python-version", PY_MINOR,
      ...platformArgs,
      "--implementation", "cp",
      "--abi", `cp${PY_MINOR.replace(".", "")}`,
      "--only-binary", ":all:",
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

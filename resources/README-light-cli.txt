This app bundles a portable Python interpreter plus the "light-phone-cli-tui"
and "light-phone-api" packages (github.com/garado/light), fetched at build
time by scripts/fetch-light-cli.js from:

  - Python:      https://github.com/astral-sh/python-build-standalone
  - Light CLI:   https://pypi.org/project/light-phone-cli-tui/

It's run as a separate process (see run_light.py and ../../src/main/light.js
and lightPath.js) — nothing from it is imported into or linked with this
app's own code.

As of the 0.3.0+ version this app requires, garado/light is licensed under
GPL-3.0 (github.com/garado/light/blob/main/LICENSE) — a change from the MIT
license its earlier versions used. This app itself remains MIT licensed;
bundling garado/light as a standalone executable invoked over its CLI, the
way this README's own directory structure keeps it a separate process
rather than a library this app links against, does not require relicensing
this app, but the GPL-3.0 terms still apply to garado/light itself.

If the bundled copy for your platform is missing (a broken install, or a
checkout that hasn't run `npm run fetch-light-cli` yet), set the
LTM_LIGHT_PATH environment variable to point at a `light` binary on your
system (`pip install "light-phone-cli-tui>=0.3.0"` gets you one), or install
one yourself and make sure "light" is on your PATH.

# Entry point for the vendored Light CLI (github.com/garado/light,
# `light-phone-cli-tui` on PyPI), run as:
#
#   <bundled python> -I run_light.py <args...>
#
# scripts/fetch-light-cli.js vendors the package as plain wheels unpacked
# into the bundled interpreter's site-packages, not via a real `pip install`
# of the target platform's package -- that's what makes it possible to
# assemble the win32/darwin/linux bundles all from one build machine, but it
# also means pip never got a chance to generate the `light` console-script
# wrapper (entry_points.txt: `light = light_cli_tui.cli:cli`) it normally
# would on a same-platform install. This does the same thing that generated
# wrapper would: import the click group and hand it argv the same way.
import sys

from light_cli_tui.cli import cli

sys.exit(cli())

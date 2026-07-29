This app bundles Google's "adb" (Android Debug Bridge) from the official
Android SDK Platform Tools, fetched at build time from:

  https://developer.android.com/tools/releases/platform-tools

Platform Tools are distributed by Google under the Android Software
Development Kit License Agreement. See:

  https://developer.android.com/studio/terms

If the bundled adb is missing for your platform, set the LTM_ADB_PATH
environment variable to point at an adb binary on your system, or install
platform-tools yourself and make sure "adb" is on your PATH.

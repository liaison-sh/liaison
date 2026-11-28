// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host bridge versions this build of apps/web runs against, per platform,
// as semver ranges over the integer bridge version each host implements
// (DESKTOP_BRIDGE_VERSION in desktop-shell-contract.ts for the desktop). A
// signed shell statement carries them (scripts/shell-signing/build-manifest.ts),
// so a host that implements a version outside its range keeps its bundled
// shell instead of running this one. Widen or move a range in the same change
// that changes what the shell needs from a host.
//
// No imports: the build manifest script reads this file outside the web build.

export const SHELL_BRIDGE_RANGE = {
  desktop: "^1",
  ios: "^1",
  android: "^1",
} as const satisfies Record<"desktop" | "ios" | "android", string>

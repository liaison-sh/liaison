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

const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?(0|[1-9]\d{0,8})$/

/**
 * Whether the integer bridge `version` satisfies `range`. The grammar is the
 * one the desktop host reads too (apps/desktop/src-tauri/src/served_shell.rs
 * `bridge_range_allows`; both sides test the same cases): sets joined by
 * `||`, each a space-separated list of comparators that must all hold, a
 * comparator `^N`, `~N`, `=N` or `N` (exactly N, N being a major version),
 * `>=N`, `>N`, `<=N` or `<N`. Anything else allows nothing.
 */
export function bridgeRangeAllows(range: string, version: number): boolean {
  if (!Number.isSafeInteger(version) || version < 0) return false
  const sets: Array<Array<[string, number]>> = []
  for (const set of range.split("||")) {
    const comparators: Array<[string, number]> = []
    for (const part of set.split(/\s+/).filter((p) => p !== "")) {
      const match = COMPARATOR.exec(part)
      if (!match) return false
      comparators.push([match[1] ?? "", Number(match[2])])
    }
    if (comparators.length === 0) return false
    sets.push(comparators)
  }
  return sets.some((set) =>
    set.every(([op, n]) => {
      switch (op) {
        case ">=":
          return version >= n
        case ">":
          return version > n
        case "<=":
          return version <= n
        case "<":
          return version < n
        default:
          return version === n
      }
    }),
  )
}

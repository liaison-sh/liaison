// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A PERSON TYPES AS A LIAISON SERVER ADDRESS, and whether it is one.
//
// One rule for every place a phone owner names a server: the mobile shell's
// first launch (apps/mobile onboarding/server-address.ts) and the "Add a
// server" form of the phone's settings (apps/web NativeServersSection). Two
// copies drifted once already: the first launch took "liaison.example.com"
// while the settings form refused it (simulator walk, 2026-09-28).
//
// Kept free of imports so the mobile boot bundle can take it without the rest
// of this package.

/**
 * A bare host ("liaison.example.com", what anyone types on a phone) gets
 * https://, and a trailing slash goes. Empty input stays empty.
 */
export function normalizeServerAddress(value: string): string {
  let out = value.trim()
  if (out !== "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(out)) out = `https://${out}`
  return trimTrailingSlashes(out)
}

/** `s` without its trailing slashes, in one pass (a `/\/+$/` replace rescans each run of slashes). */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--
  return s.slice(0, end)
}

/** An http(s) URL, the only thing that is ever stored as a server address. */
export function isValidServerAddress(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  // A real server has a dotted name, an IP address or is localhost; a single
  // word ("not-an-address") is a typo, now that a bare host gets https://.
  const host = parsed.hostname
  return host.includes(".") || host.includes(":") || host === "localhost"
}

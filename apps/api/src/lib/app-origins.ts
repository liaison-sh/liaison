// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which browser origins may call this API with credentials.
//
// `ALLOWED_ORIGINS` answers that for the web app, whose origin an operator
// knows. The wrapped shells are different: apps/web inside Capacitor is served
// from `capacitor://localhost` and inside Tauri from `tauri://localhost`,
// fixed strings that belong to the shell rather than to the deployment, and
// the same strings for every fork (S15: one build, the server address is the
// only thing that varies). They are a CROSS ORIGIN caller of whatever server
// the user named, and the session rides on `credentials: "include"`, so
// without them here the browser discards every response before the app sees
// it.
//
// They are still an EXPLICIT allowlist, `LIAISON_APP_ORIGINS`, not a special
// case compiled into the middleware: an operator who does not ship the apps
// can empty it, and one who runs a shell in development can add the dev server
// with an entry of their own.

/**
 * The shell origins. `capacitor://localhost` is the mobile shell,
 * `tauri://localhost` is the desktop shell on macOS and Linux, and
 * `http://tauri.localhost` is the SAME desktop shell on Windows, where WebView2
 * has no custom scheme and Tauri serves the bundle from that host instead
 * (the first real Windows install could not sign in: every request was cross
 * origin from a host this list did not name, and the browser dropped the
 * answer before the app saw it). None of the three is a host an attacker can
 * register: `.localhost` is reserved and resolves to the machine itself.
 */
export const DEFAULT_APP_ORIGINS = "capacitor://localhost,tauri://localhost,http://tauri.localhost"

export function parseOriginAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
}

/**
 * An entry matches an origin exactly, EXCEPT for a trailing `:*`, which
 * matches any port on that scheme and host and nothing else. A Tauri dev build
 * loads `http://localhost:<vite port>`, and pinning the port in the
 * environment of every developer is the kind of setting that gets replaced
 * with `*`. Anything else is a literal comparison, so `capacitor://localhost`
 * never matches `capacitor://localhost.evil.com`.
 */
function matchesEntry(origin: string, entry: string): boolean {
  if (!entry.endsWith(":*")) return origin === entry
  const prefix = entry.slice(0, -2)
  if (origin === prefix) return true
  if (!origin.startsWith(`${prefix}:`)) return false
  return /^[0-9]+$/.test(origin.slice(prefix.length + 1))
}

/** The value for `Access-Control-Allow-Origin`, or null to send none. */
export function resolveCorsOrigin(origin: string, allowed: string[]): string | null {
  if (origin === "") return null
  return allowed.some((entry) => matchesEntry(origin, entry)) ? origin : null
}

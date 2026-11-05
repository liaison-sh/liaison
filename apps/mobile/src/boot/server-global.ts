// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hand-off from the shell to the wrapped app.
//
// One build runs against every deployment (S15), so apps/web's bundle knows no
// server address: in a browser it talks to its own origin, and inside this app
// its own origin is `capacitor://localhost`, which serves the bundle and no
// API at all. The address the user entered at first launch lives here, in the
// boot script, and this is how the app is told about it: a single global that
// apps/web reads when it builds an API or websocket URL
// (apps/web/src/lib/env.ts).
//
// A global, rather than a build flag or a query string, because the boot
// bundle is injected into the SYNCED index.html ahead of the app's own module
// entry: it is the one place that runs before the app and can leave something
// behind for it. apps/web validates what it finds here rather than trusting
// it; this side validates too, so a bad address never reaches the page.

/** The name apps/web reads. Changing it changes both sides or neither. */
export const SERVER_ADDRESS_GLOBAL = "__LIAISON_SERVER_ADDRESS__"

/**
 * The ORIGIN of an address, or null when it is not an absolute http(s) URL.
 * One parser for everything that decides where a credential may go.
 */
export function serverAddressOrigin(serverAddress: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(serverAddress.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  return parsed.origin
}

/**
 * Publishes the ORIGIN of `serverAddress` for the wrapped app. Returns whether
 * anything was published: an address that is not an absolute http(s) URL is
 * ignored, never published as-is, because it decides where the session's
 * bearer token is sent.
 */
export function publishServerAddress(target: object, serverAddress: string): boolean {
  const origin = serverAddressOrigin(serverAddress)
  if (origin === null) return false
  ;(target as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = origin
  return true
}

/**
 * WHERE THE ADDRESS IS MIRRORED, and why there are two copies of it.
 *
 * Capacitor Preferences is the store of record, and it is ASYNCHRONOUS: the
 * address comes back a microtask or two after boot, while the wrapped app's
 * module entry runs as soon as this script yields. The app therefore built its
 * first URLs before the global existed, against `capacitor://localhost`, where
 * there is no API at all.
 *
 * localStorage is synchronous, so a mirror there can be read and published in
 * the same tick as the boot script's first line, before any await. It is a
 * HINT, never the record: anything that can run script in the page can write
 * it, and a mirror pointing at an attacker's host would otherwise decide where
 * the session's bearer token goes for as long as Preferences take to answer.
 * So Preferences decide: on a disagreement the confirmed address is published
 * over the hint, the mirror is dropped and rewritten from Preferences, and the
 * page is reloaded so nothing the hint reached survives (main.ts). The refresh
 * token's header is bound to the CONFIRMED origin alone, so it never travels
 * on a hint at all (auth/refresh-bridge.ts).
 */
export const SERVER_ADDRESS_MIRROR_KEY = "liaison.serverAddress.mirror"

/** Just enough of localStorage, so the mirror is testable without a webview. */
export interface SyncStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem?: (key: string) => void
}

function defaultSyncStorage(): SyncStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    // A webview with storage disabled has no mirror, and that is survivable.
    return null
  }
}

/** Writes the mirror. Failures are silent: the record is elsewhere. */
export function mirrorServerAddress(
  serverAddress: string,
  storage: SyncStorage | null = defaultSyncStorage(),
): void {
  try {
    storage?.setItem(SERVER_ADDRESS_MIRROR_KEY, serverAddress)
  } catch {
    // A full or refused store costs a fast boot, never the address.
  }
}

/** Drops the mirror. Used when it disagreed with Preferences, which decide. */
export function clearMirroredServerAddress(
  storage: SyncStorage | null = defaultSyncStorage(),
): void {
  try {
    storage?.removeItem?.(SERVER_ADDRESS_MIRROR_KEY)
  } catch {
    // The record is elsewhere, and the next settle overwrites this anyway.
  }
}

/**
 * Publishes the mirrored address SYNCHRONOUSLY. Called as the boot bundle's
 * first act, before any await, so the wrapped app's very first request already
 * has a server to send itself to. Returns whether anything was published; the
 * validation is `publishServerAddress`'s, so a tampered mirror publishes
 * nothing rather than redirecting the session's bearer token.
 */
export function publishMirroredServerAddress(
  target: object,
  storage: SyncStorage | null = defaultSyncStorage(),
): boolean {
  let mirrored: string | null = null
  try {
    mirrored = storage?.getItem(SERVER_ADDRESS_MIRROR_KEY) ?? null
  } catch {
    return false
  }
  if (mirrored === null || mirrored === "") return false
  return publishServerAddress(target, mirrored)
}

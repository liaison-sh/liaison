// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hand-off from the shell to the wrapped app, and the reason the page has
// to be started again once.
//
// apps/web is built ONCE for every deployment (S15), so its bundle names no
// server. In a browser that is right: it is served by its own API's origin and
// a relative "/api" lands there. In this shell the page is served from
// `tauri://localhost`, where the same path resolves inside the bundle, which
// holds no API at all, so the address the user bound at first launch is handed
// over in a global apps/web reads per request (apps/web/src/lib/env.ts). The
// mobile shell publishes the same global from its boot bundle
// (apps/mobile/src/boot/server-global.ts).
//
// TWO COPIES, and which one decides. The SHELL's 0600 file is the record and
// it is read asynchronously (`get_server_address`), while the wrapped app's
// own modules run as soon as the injected bundle yields: on the first tick
// after a launch the page had no address and built its first requests against
// `tauri://localhost`, where nothing answers, which is exactly the login that
// says it cannot reach the server. localStorage is synchronous, so a mirror
// there is published in the injection script's first line, before any await.
// It is a HINT, never the record: anything that can run script in the page can
// write it, so it is only ever published through the same validation, and the
// address the shell confirms is published over it.
//
// And when the page started with no address at all (a first launch, a cleared
// webview store), publishing the global later is not enough: the app has
// already resolved its session against nothing. It is reloaded, ONCE, marked
// so a shell that keeps answering the same address can never loop.

/** The name apps/web reads. Changing it changes both sides or neither. */
export const SERVER_ADDRESS_GLOBAL = "__LIAISON_SERVER_ADDRESS__"

/** The synchronous hint, written from the address the shell confirmed. */
export const SERVER_ADDRESS_MIRROR_KEY = "liaison-desktop:server-address"

/** The origin the page was last restarted for, so it is restarted once. */
export const ADDRESS_RELOAD_MARKER_KEY = "liaison-desktop:address-reload"

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
    // A webview with storage refused has no mirror, and that is survivable:
    // the shell still answers, one tick later, and the page is reloaded.
    return null
  }
}

/**
 * Publishes the ORIGIN of `address`, and only an absolute http(s) one: the
 * value decides where the session's bearer and refresh tokens are sent, so a
 * path, a query or a `javascript:` scheme never rides along with them.
 * Returns whether anything was published.
 */
export function publishServerAddress(target: object, address: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(address.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  ;(target as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = parsed.origin
  return true
}

/** What the page is currently using, read from the global rather than a copy. */
export function publishedServerAddress(target: object): string | null {
  const raw = (target as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
  return typeof raw === "string" && raw !== "" ? raw : null
}

/** Writes the hint. Failures are silent: the record is the shell's file. */
export function mirrorServerAddress(
  address: string,
  storage: SyncStorage | null = defaultSyncStorage(),
): void {
  try {
    storage?.setItem(SERVER_ADDRESS_MIRROR_KEY, address)
  } catch {
    // A full or refused store costs a fast boot, never the address.
  }
}

/**
 * Publishes the hint SYNCHRONOUSLY, as the injected bundle's first act, so the
 * wrapped app's very first request already has a server to send itself to.
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

/** What settling an address did, so a caller can say why nothing happened. */
export type AddressSettlement = "ignored" | "unchanged" | "reloaded"

export interface SettleDeps {
  target?: object
  storage?: SyncStorage | null
  /** Starts the page again. Injected so a test never reloads the runner. */
  reload?: () => void
}

function defaultReload(): void {
  try {
    globalThis.location?.reload()
  } catch {
    // A host with no navigable location (a test, a plain module import) keeps
    // the global that was just published, which is the rest of the fix.
  }
}

/**
 * Publishes a bound address for the wrapped app and, when the page did not
 * already have it, starts the page again so apps/web's own modules resolve
 * against the right server from their first line.
 */
export function settleServerAddress(address: string, deps: SettleDeps = {}): AddressSettlement {
  const target = deps.target ?? globalThis
  const storage = deps.storage === undefined ? defaultSyncStorage() : deps.storage
  const hinted = publishedServerAddress(target)
  if (!publishServerAddress(target, address)) return "ignored"
  const origin = publishedServerAddress(target)
  if (origin === null) return "ignored"
  mirrorServerAddress(origin, storage)
  const forget = () => {
    try {
      storage?.removeItem?.(ADDRESS_RELOAD_MARKER_KEY)
    } catch {
      // The marker only ever suppresses a reload; a stale one costs a slow
      // first paint, never a wrong server.
    }
  }
  // The page already had this exact origin: its modules resolved against it.
  if (hinted === origin) {
    forget()
    return "unchanged"
  }
  let marked: string | null = null
  try {
    marked = storage?.getItem(ADDRESS_RELOAD_MARKER_KEY) ?? null
  } catch {
    marked = null
  }
  // Already restarted for this origin and the page still came up without the
  // hint (a storage the webview refuses): reloading again would be a loop.
  if (marked === origin) return "unchanged"
  try {
    storage?.setItem(ADDRESS_RELOAD_MARKER_KEY, origin)
  } catch {
    // Without a marker a reload cannot be proven to happen once, so it is not
    // attempted at all: a page on the right global beats a reload loop.
    return "unchanged"
  }
  ;(deps.reload ?? defaultReload)()
  return "reloaded"
}

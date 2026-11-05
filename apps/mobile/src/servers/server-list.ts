// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVERS THIS PHONE KNOWS, and everything filed under each one.
//
// The mobile twin of the desktop shell's saved list (apps/desktop/src-tauri/
// src/servers.rs), on this app's own storage: Capacitor Preferences, where the
// bound address already lived, with the refresh tokens routed to the OS secret
// store (auth/secret-store.ts).
//
//   liaison.serverAddress           the CURRENT server, the key first launch has
//                                   always written and read (unchanged)
//   liaison.servers                 the saved list, as JSON
//   liaison.refreshToken@<origin>   one refresh token per server
//   liaison.pageStorage@<origin>    the page's own storage, parked while
//                                   another server is current
//
// THE RULE: nothing that belongs to one server reaches another. The refresh
// token is read under the origin the bridge is about to present it to; the
// page's storage (apps/web's tabs, drafts, per conversation choices) is swapped
// on every switch.
//
// NOTIFICATIONS COME FROM EVERY SERVER the phone is signed in to, not only the
// current one: a switch leaves the push registration of the server being left
// in place (it is that server's row, filed under its own session), so its
// pushes keep arriving, each one naming the server it came from (`server` and
// `serverLabel` in the payload). A tap on one opens that server first
// (`openOn`), never another organisation's app. The registration goes only
// when the session goes: a sign out, or removing the server (whose logout
// names this phone's device, so the server drops its push row too).
//
// Everything is injected (storage, fetch, the page's storage, the reload), so
// the whole rule runs in a bun test with no native runtime under it.

import type { RefreshTokenStore } from "../auth/refresh-bridge"
import { REFRESH_TOKEN_KEY } from "../auth/refresh-bridge"
import {
  SERVER_ADDRESS_GLOBAL,
  SERVER_ADDRESS_MIRROR_KEY,
  serverAddressOrigin,
} from "../boot/server-global"
import { parseDeepLink } from "../deep-link"
import {
  BRANDING_PATH,
  BRANDING_TIMEOUT_MS,
  isBranding,
  isValidServerAddress,
  normalizeServerAddress,
  SERVER_ADDRESS_KEY,
} from "../onboarding/server-address"

export const SERVER_LIST_KEY = "liaison.servers"

export function refreshTokenKey(origin: string): string {
  return `${REFRESH_TOKEN_KEY}@${origin}`
}

export function pageStorageKey(origin: string): string {
  return `liaison.pageStorage@${origin}`
}

/** The refusals a new address answers with, as codes the page turns into words. */
export const NOT_A_LIAISON_SERVER = "NotALiaisonServer"
export const SERVER_UNREACHABLE = "ServerUnreachable"
export const INVALID_ADDRESS = "InvalidAddress"
export const UNKNOWN_SERVER = "UnknownServer"

export interface SavedServer {
  address: string
  /** The organisation's own name, or null until the server has said it. */
  label: string | null
}

export interface ServerListSnapshot {
  current: string | null
  servers: SavedServer[]
}

/** Preferences, behind the three calls this module needs. */
export interface KeyValueStore {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
  remove: (key: string) => Promise<void>
}

/** Just enough of the page's Storage for the swap. */
export interface PageStorage {
  readonly length: number
  key: (index: number) => string | null
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The page's storage keys that belong to the PHONE rather than to a server:
 * the address mirror, which says which server the page starts on.
 */
export const MACHINE_KEYS: ReadonlySet<string> = new Set([
  SERVER_ADDRESS_MIRROR_KEY,
  "liaison.pageStorage.owner",
])

/** Which server the page's storage belongs to, as an origin. */
export const STORAGE_OWNER_KEY = "liaison.pageStorage.owner"

function sameOrigin(left: string, right: string): boolean {
  const a = serverAddressOrigin(left)
  return a !== null && a === serverAddressOrigin(right)
}

function parseList(raw: string | null): SavedServer[] | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return []
      const { address, label } = entry as { address?: unknown; label?: unknown }
      if (typeof address !== "string" || !isValidServerAddress(address)) return []
      return [{ address, label: typeof label === "string" && label.trim() ? label : null }]
    })
  } catch {
    return []
  }
}

/**
 * Asks an address whether it is a Liaison, and for its organisation's name.
 * The same public route and shape first launch checks (onboarding/
 * server-address.ts), with the two ways to fail told apart: nothing answered,
 * or something that is not a Liaison did.
 */
export async function probeServer(
  address: string,
  fetchImpl: FetchLike,
  timeoutMs: number = BRANDING_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let response: Response
  try {
    response = await Promise.race([
      fetchImpl(`${address.replace(/\/+$/, "")}${BRANDING_PATH}`, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(SERVER_UNREACHABLE))
        }, timeoutMs)
      }),
    ])
  } catch {
    throw new Error(SERVER_UNREACHABLE)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (!response.ok) throw new Error(NOT_A_LIAISON_SERVER)
  let body: { data?: unknown }
  try {
    body = (await response.json()) as { data?: unknown }
  } catch {
    throw new Error(NOT_A_LIAISON_SERVER)
  }
  if (!isBranding(body?.data)) throw new Error(NOT_A_LIAISON_SERVER)
  return body.data.orgName.trim()
}

export interface ServerListDependencies {
  store: KeyValueStore
  fetchImpl: FetchLike
  /**
   * This phone's notification device on a server (the push row id its
   * receipt credential names), by origin, or null. A removal's logout names
   * it, so the server drops the push row with the session: removing a server
   * the phone is not on has no bearer for the push DELETE.
   */
  deviceIdFor?: (origin: string) => Promise<string | null>
  /** Forgets what this phone keeps for a server's notifications (its receipt credential). */
  forgetDevice?: (origin: string) => Promise<void>
}

export interface ServerList {
  /**
   * Files the one address and one refresh token a build before the list kept
   * under the address, once. Runs before anything reads a token.
   */
  migrate: () => Promise<void>
  /** The saved servers and the current one. The current one is always saved. */
  snapshot: () => Promise<ServerListSnapshot>
  /** Adds a server that answered as a Liaison, and answers its address. */
  add: (url: string) => Promise<string>
  /** The refresh token store for whichever origin the bridge is bound to. */
  refreshStoreFor: (origin: () => string | null) => RefreshTokenStore
  /**
   * Makes a saved server current. The page storage handed over is parked for
   * the server being left, and the one parked for the target comes back.
   */
  switchTo: (address: string, leaving: Record<string, string>) => Promise<Record<string, string>>
  /**
   * Forgets a server: its session is revoked on the server and dropped here,
   * its parked storage goes, and when it was current the next saved server
   * (or none) takes its place. Answers the server now current.
   */
  remove: (address: string) => Promise<{ current: string | null; storage: Record<string, string> }>
  /** Parks page storage for a server by origin, whoever is current. */
  park: (origin: string, storage: Record<string, string>) => Promise<void>
  /** Takes back the page storage parked for a server. */
  take: (address: string) => Promise<Record<string, string>>
}

export function createServerList(deps: ServerListDependencies): ServerList {
  const { store } = deps

  async function readServers(): Promise<SavedServer[]> {
    return parseList(await store.get(SERVER_LIST_KEY)) ?? []
  }

  async function writeServers(servers: SavedServer[]): Promise<void> {
    await store.set(SERVER_LIST_KEY, JSON.stringify(servers))
  }

  async function currentAddress(): Promise<string | null> {
    const stored = await store.get(SERVER_ADDRESS_KEY)
    return stored && isValidServerAddress(stored) ? stored : null
  }

  async function takeParked(address: string): Promise<Record<string, string>> {
    const origin = serverAddressOrigin(address)
    if (origin === null) return {}
    const raw = await store.get(pageStorageKey(origin))
    await store.remove(pageStorageKey(origin))
    if (raw === null) return {}
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    } catch {
      return {}
    }
  }

  const list: ServerList = {
    async migrate() {
      const current = await currentAddress()
      const legacyToken = await store.get(REFRESH_TOKEN_KEY)
      if (legacyToken !== null) {
        const origin = current ? serverAddressOrigin(current) : null
        // The single token belonged to the single server; with none it
        // belonged to nobody, and is dropped rather than guessed at.
        if (origin && (await store.get(refreshTokenKey(origin))) === null) {
          await store.set(refreshTokenKey(origin), legacyToken)
        }
        await store.remove(REFRESH_TOKEN_KEY)
      }
      await list.snapshot()
    },

    async snapshot() {
      const servers = await readServers()
      const current = await currentAddress()
      // FIRST LAUNCH WRITES THE FIRST ENTRY: the address it bound is the
      // current one, and a current server is always a saved one.
      if (current && !servers.some((server) => sameOrigin(server.address, current))) {
        servers.push({ address: current, label: null })
        await writeServers(servers)
      }
      const match = current ? servers.find((server) => sameOrigin(server.address, current)) : null
      return { current: match?.address ?? null, servers }
    },

    async add(url) {
      const candidate = normalizeServerAddress(url).replace(/\/+$/, "")
      if (!isValidServerAddress(candidate)) throw new Error(INVALID_ADDRESS)
      const label = await probeServer(candidate, deps.fetchImpl)
      // The current server first, so the list reads in the order servers
      // were added even for one first launch filed before the list existed.
      await list.snapshot()
      const servers = await readServers()
      const existing = servers.find((server) => sameOrigin(server.address, candidate))
      if (existing) {
        existing.label = label || existing.label
      } else {
        servers.push({ address: candidate, label: label || null })
      }
      await writeServers(servers)
      return existing?.address ?? candidate
    },

    refreshStoreFor(origin) {
      const key = () => {
        const bound = origin()
        const normalized = bound ? serverAddressOrigin(bound) : null
        return normalized ? refreshTokenKey(normalized) : null
      }
      return {
        load: async () => {
          const at = key()
          return at ? store.get(at) : null
        },
        save: async (token: string) => {
          const at = key()
          if (at) await store.set(at, token)
        },
        clear: async () => {
          const at = key()
          if (at) await store.remove(at)
        },
      }
    },

    async switchTo(address, leaving) {
      const servers = await readServers()
      const target = servers.find((server) => sameOrigin(server.address, address))
      if (!target) throw new Error(UNKNOWN_SERVER)
      const current = await currentAddress()
      const leavingOrigin = current ? serverAddressOrigin(current) : null
      if (leavingOrigin) await store.set(pageStorageKey(leavingOrigin), JSON.stringify(leaving))
      await store.set(SERVER_ADDRESS_KEY, target.address)
      return takeParked(target.address)
    },

    async park(origin, storage) {
      const normalized = serverAddressOrigin(origin)
      if (normalized) await store.set(pageStorageKey(normalized), JSON.stringify(storage))
    },

    take: (address) => takeParked(address),

    async remove(address) {
      const servers = await readServers()
      const target = servers.find((server) => sameOrigin(server.address, address))
      if (!target) throw new Error(UNKNOWN_SERVER)
      const origin = serverAddressOrigin(target.address)
      const remaining = servers.filter((server) => server !== target)
      await writeServers(remaining)
      if (origin) {
        const token = await store.get(refreshTokenKey(origin))
        await store.remove(refreshTokenKey(origin))
        await store.remove(pageStorageKey(origin))
        const deviceId = (await deps.deviceIdFor?.(origin).catch(() => null)) ?? null
        if (token) await revokeSession(target.address, token, deps.fetchImpl, deviceId)
        await deps.forgetDevice?.(origin).catch(() => undefined)
      }
      const current = await currentAddress()
      if (current && !sameOrigin(current, target.address)) {
        return { current, storage: {} }
      }
      const next = remaining[0]?.address ?? null
      if (next) {
        await store.set(SERVER_ADDRESS_KEY, next)
        return { current: next, storage: await takeParked(next) }
      }
      await store.remove(SERVER_ADDRESS_KEY)
      return { current: null, storage: {} }
    },
  }
  return list
}

/**
 * Tells a server a session is over, the way the page's own sign out does
 * (`X-Liaison-Refresh` on /api/auth/logout). Best effort: the token is gone
 * from this phone whatever the server says. Naming the device makes the
 * server drop its push row and receipt credential with the session.
 */
export async function revokeSession(
  address: string,
  refreshToken: string,
  fetchImpl: FetchLike,
  deviceId: string | null = null,
): Promise<void> {
  try {
    await fetchImpl(`${address.replace(/\/+$/, "")}/api/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Liaison-Refresh": refreshToken },
      body: JSON.stringify(deviceId ? { deviceId } : {}),
    })
  } catch {
    // Unreachable: its session row runs out on its own.
  }
}

function keysOf(storage: PageStorage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key !== null) keys.push(key)
  }
  return keys
}

/**
 * What belongs to a SESSION in the page's storage: the "liaison:" keys, the
 * same rule apps/web's own sign out applies (lib/storage.ts). The machine keys
 * (which server the storage belongs to) use "liaison." and stay.
 */
export function forgetSessionStorage(storage: PageStorage): void {
  for (const key of keysOf(storage)) {
    if (key.startsWith("liaison:") && !MACHINE_KEYS.has(key)) storage.removeItem(key)
  }
}

/** Everything in the page's storage that belongs to the current server. */
export function snapshotServerStorage(storage: PageStorage): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const key of keysOf(storage)) {
    if (MACHINE_KEYS.has(key)) continue
    const value = storage.getItem(key)
    if (value !== null) snapshot[key] = value
  }
  return snapshot
}

/** Replaces what belongs to one server with another server's keys. */
export function replaceServerStorage(storage: PageStorage, incoming: Record<string, string>): void {
  for (const key of keysOf(storage)) {
    if (!MACHINE_KEYS.has(key)) storage.removeItem(key)
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (MACHINE_KEYS.has(key)) continue
    try {
      storage.setItem(key, value)
    } catch {
      // A full store drops what does not fit; the page rebuilds it.
    }
  }
}

/** What the settings screen reaches through the native bridge. */
export interface NativeServers {
  list: () => Promise<ServerListSnapshot>
  add: (url: string) => Promise<void>
  switchTo: (address: string) => Promise<void>
  /**
   * A notification from a saved server the phone is not on was tapped: the
   * phone moves to that server and the page starts at the item's route.
   * Answers false (and moves nothing) for a server that is not saved or a
   * link this app does not route.
   */
  openOn: (address: string, link: string) => Promise<boolean>
  remove: (address: string) => Promise<void>
  signOut: () => Promise<void>
}

export interface NativeServersDependencies {
  list: ServerList
  /** The page's localStorage. */
  pageStorage: PageStorage | null
  /** The page's sessionStorage: a sign in in flight belongs to one server. */
  sessionStorage?: PageStorage | null
  /**
   * What the shell undoes when a session ends (the push registration), while
   * the bearer still authenticates it. Run when the CURRENT server is removed,
   * never on a switch: the server being left keeps notifying this phone.
   */
  endSession: () => Promise<void>
  /** The page's own sign out (the bridge presents the token and forgets it). */
  signOut: () => Promise<void>
  /**
   * The saved list changed: the push registration of the server the phone is
   * on is posted again (it says whether the phone knows several servers). Run
   * while that server's bearer still authenticates it: after an add, before
   * the phone moves; after removing another server, in place.
   */
  serversChanged?: () => Promise<void>
  /**
   * Starts the page again: on the route it is on, or, given one, at `path`.
   * A server change always passes APP_ROOT (see `enter`).
   */
  reload: (path?: string) => void
  target?: object
}

/** Where the page starts again after the phone changes server. */
export const APP_ROOT = "/"

/**
 * THE SETTINGS SCREEN'S HALF, published on the native bridge. Every change of
 * server ends with the page starting again on the new server, which is the
 * only way apps/web's modules resolve against a new origin.
 */
export function createNativeServers(deps: NativeServersDependencies): NativeServers {
  const target = deps.target ?? globalThis

  function enter(
    address: string | null,
    storage: Record<string, string>,
    path: string = APP_ROOT,
  ): void {
    const page = deps.pageStorage
    if (page) {
      replaceServerStorage(page, storage)
      try {
        const origin = address ? serverAddressOrigin(address) : null
        if (origin) {
          page.setItem(SERVER_ADDRESS_MIRROR_KEY, origin)
          page.setItem(STORAGE_OWNER_KEY, origin)
        } else {
          page.removeItem(SERVER_ADDRESS_MIRROR_KEY)
          page.removeItem(STORAGE_OWNER_KEY)
        }
      } catch {
        // Preferences decide at the next start.
      }
    }
    const session = deps.sessionStorage
    if (session) for (const key of keysOf(session)) session.removeItem(key)
    ;(target as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = address
      ? (serverAddressOrigin(address) ?? undefined)
      : undefined
    // AT THE APP'S ROOT, NEVER ON THE ROUTE BEING LEFT. A route belongs to the
    // server it was opened on: B's /threads/<id> means nothing on A, and B's
    // /login is worse. The sign-in screen under a shell leaves a restored
    // session where it is (apps/web Login.tsx), so reloading B's /login after
    // "Use A instead" restored A's session behind A's sign-in card. The root
    // sends a restored session into the app and a missing one to the sign-in.
    // A tapped notification passes its own item's route, on the server it
    // came from (`openOn`), never a route of the server being left.
    deps.reload(path)
  }

  async function moveTo(address: string, path?: string): Promise<void> {
    const leaving = deps.pageStorage ? snapshotServerStorage(deps.pageStorage) : {}
    // Refused before anything is undone: an address that is not saved moves
    // nothing.
    const known = await deps.list.snapshot()
    if (!known.servers.some((server) => sameOrigin(server.address, address))) {
      throw new Error(UNKNOWN_SERVER)
    }
    // The push registration of the server being left STAYS: it is that
    // server's own row, and its notifications keep reaching this phone.
    const storage = await deps.list.switchTo(address, leaving)
    enter(address, storage, path)
  }

  return {
    list: () => deps.list.snapshot(),
    async add(url) {
      const address = await deps.list.add(url)
      await deps.serversChanged?.().catch(() => undefined)
      await moveTo(address)
    },
    async switchTo(address) {
      const { current } = await deps.list.snapshot()
      if (current && sameOrigin(current, address)) return
      await moveTo(address)
    },
    async openOn(address, link) {
      const path = parseDeepLink(link)
      if (path === null) return false
      const { current, servers } = await deps.list.snapshot()
      const saved = servers.find((server) => sameOrigin(server.address, address))
      if (!saved) return false
      if (current && sameOrigin(current, saved.address)) return false
      await moveTo(saved.address, path)
      return true
    },
    async remove(address) {
      const { current } = await deps.list.snapshot()
      const wasCurrent = current !== null && sameOrigin(current, address)
      if (wasCurrent) await deps.endSession().catch(() => undefined)
      const next = await deps.list.remove(address)
      if (wasCurrent) enter(next.current, next.storage)
      else await deps.serversChanged?.().catch(() => undefined)
    },
    async signOut() {
      await deps.signOut()
      // What the page kept for the account that left (its open tabs, drafts,
      // preferences) goes with it, as the browser's own sign out does: the
      // next person to sign in here is not that person, and a Mail tab left
      // mounted behind Home made mail calls for a member without mail.
      if (deps.pageStorage) forgetSessionStorage(deps.pageStorage)
      deps.reload()
    },
  }
}

/**
 * PUTS THE PAGE'S STORAGE RIGHT for the server the phone starts on. The
 * storage says which server it belongs to; when that is not the bound server
 * (first launch's prompt re-bound the phone, or the app died half way through
 * a switch), it is parked for its owner, the bound server's is taken back and
 * the page starts again. Storage that predates the marker is the bound
 * server's. Answers whether the page is being started again.
 */
export async function reconcilePageStorage(
  address: string,
  list: ServerList,
  page: PageStorage | null,
  reload: () => void,
): Promise<boolean> {
  const origin = serverAddressOrigin(address)
  if (!page || origin === null) return false
  const owner = page.getItem(STORAGE_OWNER_KEY)
  if (owner === origin) return false
  if (owner === null) {
    page.setItem(STORAGE_OWNER_KEY, origin)
    return false
  }
  await list.park(owner, snapshotServerStorage(page))
  replaceServerStorage(page, await list.take(address))
  page.setItem(STORAGE_OWNER_KEY, origin)
  reload()
  return true
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MOVING THE WINDOW FROM ONE SAVED SERVER TO ANOTHER, the page's half.
//
// The page is served from `tauri://localhost` whichever server it talks to, so
// its own storage (apps/web's open tabs, drafts, the local model each
// conversation runs on, this overlay's per conversation folder memory, the
// resume ids, the remembered permission modes, the runtime the user picked) is
// ONE storage for every server. Left as it is, the tabs of one organisation
// would open against the next one's API and a conversation id from one would
// be looked up on the other.
//
// So each server has its OWN page storage. When the window leaves a server,
// everything in localStorage except the few keys that belong to the machine
// rather than to a server is handed to the shell, which parks it under the
// server being left and gives back what it parked for the server being
// entered (`src-tauri/src/account.rs`). The page's storage then holds exactly
// that server's keys, and a marker says which server they belong to, so a
// window that died half way through a switch is put right at its next start.
//
// ORDER, which is the whole point:
//
//   0. the node's runner is FROZEN (B2-1, D52): from here it claims and starts
//      nothing, so no job of the server being left can start once the shell
//      answers for the next one (a refused switch thaws it).
//   1. the shell's command runs next: it checks the target (a new address is
//      asked whether it is a Liaison), stops the local session's sidecar, drops
//      the MCP config and moves the current entry. A refusal changes nothing,
//      not even a running session.
//   2. the node's FOLLOWS and RUNS, which the shell's command ended
//      (`host_exit`, a stop), post their end to the server being left, with
//      its bearer (D49 F9, D50; at most NODE_SETTLE_MS, best effort: the lease
//      sweep is the backstop). The next server's page never re-adopts a run
//      of this one (node_live_sessions).
//      Then the local session's CLAIM is released on the server being left,
//      with that server's own bearer, which the window still holds in memory.
//   3. the in-memory bearer is forgotten, the storage is swapped, the address
//      mirror is rewritten, and the page starts again on the new server.

import { deleteSessionCachesOf } from "@liaison/web/modules/sessions/session-cache-db"
import {
  endBridgeSession,
  freezeNodeJobs,
  releaseRuntimeLocation,
  settleNodeJobs,
  thawNodeJobs,
} from "../bridge"
import { noteSessionToken } from "./desktop-store"
import {
  ADDRESS_RELOAD_MARKER_KEY,
  publishServerAddress,
  SERVER_ADDRESS_GLOBAL,
  SERVER_ADDRESS_MIRROR_KEY,
} from "./server-global"
import type { OutgoingPageStorage, SwitchedServer } from "./sidecar-client"

/** D49 F9, D50: how long a switch waits for the node's follows and runs to post their end. */
export const NODE_SETTLE_MS = 3_000

/** Which server the page's storage currently belongs to. */
export const STORAGE_OWNER_KEY = "liaison-desktop:storage-owner"

/**
 * THE KEYS THAT BELONG TO THE MACHINE, not to a server: the address mirror and
 * its reload marker (they say which server the page starts on), the owner
 * marker itself, and the one notice about this machine's shell. Everything else
 * in the page's storage belongs to the server it was written for.
 */
export const MACHINE_KEYS: ReadonlySet<string> = new Set([
  SERVER_ADDRESS_MIRROR_KEY,
  ADDRESS_RELOAD_MARKER_KEY,
  STORAGE_OWNER_KEY,
  "liaison-desktop:windows-shell-notice",
])

/** The session storage key that records the launch link this window handled. */
const LAUNCH_LINK_SEEN_KEY = "liaison-desktop:launch-link-seen"

/** Just enough of Storage, so the swap is testable on a plain object. */
export interface PageStorage {
  readonly length: number
  key: (index: number) => string | null
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function keysOf(storage: PageStorage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key !== null) keys.push(key)
  }
  return keys
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

/**
 * Replaces everything that belongs to a server with another server's keys.
 * The machine's own keys are kept, and an incoming key that claims to be one
 * of them is ignored: the shell parked what the page gave it, and a machine
 * key is never part of that.
 */
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

/** The server the page's storage belongs to, or null when unrecorded. */
export function storageOwner(storage: PageStorage | null): string | null {
  try {
    return storage?.getItem(STORAGE_OWNER_KEY) ?? null
  } catch {
    return null
  }
}

function pageStorage(): PageStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function sessionStore(): PageStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage
  } catch {
    return null
  }
}

let reloadPage: () => void = () => {
  try {
    globalThis.location?.reload()
  } catch {
    // A host with no navigable location (a test) stays where it is.
  }
}

/** Test seam: what "start the page again" does. */
export function setPageReloader(reload: () => void): void {
  reloadPage = reload
}

/** The shell's half of a switch, handed what the page is leaving behind. */
export type SwitchCommand = (outgoing: OutgoingPageStorage) => Promise<SwitchedServer>

/** Where the switch reads and writes, injected so a test owns every piece. */
export interface SwitchDependencies {
  storage?: PageStorage | null
  session?: PageStorage | null
  /** Releases the local session's claim on the server being left. */
  endLocalSession?: () => Promise<void>
  /** D49 F9, D50: waits, at most `ms`, for the node's ended follows and runs to post their end. */
  settleNodeJobs?: (ms: number) => Promise<void>
  /** B2-1 (D52): the node claims and starts nothing from before the shell's command. */
  freezeNodeJobs?: () => void
  /** B2-1: the shell refused: the node claims again. */
  thawNodeJobs?: () => void
  reload?: () => void
  target?: object
}

/**
 * Applies what the shell answered: the new server's storage, its address in
 * the mirror and on the page, and nothing of the server that was left.
 */
export function enterServer(result: SwitchedServer, deps: SwitchDependencies = {}): void {
  const storage = deps.storage === undefined ? pageStorage() : deps.storage
  const session = deps.session === undefined ? sessionStore() : deps.session
  const target = deps.target ?? globalThis
  // The bearer the page held was the previous server's.
  noteSessionToken(null)
  if (storage) {
    replaceServerStorage(storage, result.storage)
    try {
      storage.removeItem(ADDRESS_RELOAD_MARKER_KEY)
      if (result.address) {
        storage.setItem(STORAGE_OWNER_KEY, result.address)
      } else {
        storage.removeItem(STORAGE_OWNER_KEY)
      }
    } catch {
      // The owner marker is repaired at the next start.
    }
  }
  // The sign-in in flight (a PKCE verifier, an OAuth state, a return path) was
  // started against the server that was left.
  if (session) {
    for (const key of keysOf(session)) {
      if (key !== LAUNCH_LINK_SEEN_KEY) session.removeItem(key)
    }
  }
  if (result.address && publishServerAddress(target, result.address)) {
    const origin = (target as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
    try {
      if (typeof origin === "string") storage?.setItem(SERVER_ADDRESS_MIRROR_KEY, origin)
    } catch {
      // The shell's own record decides at the next start.
    }
  } else {
    ;(target as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = undefined
    try {
      storage?.removeItem(SERVER_ADDRESS_MIRROR_KEY)
    } catch {
      // Same.
    }
  }
}

/** Only one switch at a time: a second click while one runs is ignored. */
let switching = false

/**
 * LEAVES THE CURRENT SERVER FOR ANOTHER, in the order at the top of this file.
 * Resolves with what the shell answered; rejects, with nothing changed on the
 * page, when the shell refused.
 */
export async function switchServerWith(
  command: SwitchCommand,
  deps: SwitchDependencies = {},
): Promise<SwitchedServer> {
  if (switching) throw new Error("SwitchInProgress")
  switching = true
  try {
    const storage = deps.storage === undefined ? pageStorage() : deps.storage
    const outgoing: OutgoingPageStorage = {
      owner: storageOwner(storage),
      storage: storage ? snapshotServerStorage(storage) : {},
    }
    // B2-1 (D52): nothing of this server starts once the shell has moved on.
    ;(deps.freezeNodeJobs ?? freezeNodeJobs)()
    let result: SwitchedServer
    try {
      result = await command(outgoing)
    } catch (error) {
      ;(deps.thawNodeJobs ?? thawNodeJobs)()
      throw error
    }
    // D49 F9, D50: the shell ended the node's follows and runs; their end
    // reaches the server being left while the window still holds its bearer.
    await (deps.settleNodeJobs ?? settleNodeJobs)(NODE_SETTLE_MS).catch(() => undefined)
    // The claim is the previous server's, released with its own bearer before
    // that bearer is forgotten. Best effort: the lease's TTL is the backstop.
    await (deps.endLocalSession ?? endBridgeSession)().catch(() => undefined)
    // "This machine" was a choice made for the previous server's conversation.
    releaseRuntimeLocation()
    enterServer(result, deps)
    ;(deps.reload ?? reloadPage)()
    return result
  } finally {
    switching = false
  }
}

/** Test seam. */
export function resetServerSwitch(): void {
  switching = false
}

/**
 * PUTS A HALF FINISHED SWITCH RIGHT, at the window's start.
 *
 * The page's storage says which server it belongs to. When that is not the
 * server the shell says is current (the window died between the shell's
 * switch and the page's swap), the storage is handed to the shell for its
 * owner and the current server's is taken back, and the page starts again.
 * A window that predates the marker simply adopts the current server: its
 * storage was that server's all along.
 */
export async function reconcileStorageOwner(
  current: string | null,
  switchTo: (address: string, outgoing: OutgoingPageStorage) => Promise<SwitchedServer>,
  deps: SwitchDependencies = {},
): Promise<"adopted" | "unchanged" | "repaired" | "cleared"> {
  const storage = deps.storage === undefined ? pageStorage() : deps.storage
  if (!storage) return "unchanged"
  const owner = storageOwner(storage)
  if (owner === current) return "unchanged"
  if (owner === null) {
    if (current !== null) storage.setItem(STORAGE_OWNER_KEY, current)
    return "adopted"
  }
  if (current === null) {
    // The server this storage belonged to is gone from the list, and so are
    // its cached session transcripts (S58, batch-5 F3).
    await deleteSessionCachesOf(owner)
    replaceServerStorage(storage, {})
    storage.removeItem(STORAGE_OWNER_KEY)
    ;(deps.reload ?? reloadPage)()
    return "cleared"
  }
  try {
    const result = await switchTo(current, {
      owner,
      storage: snapshotServerStorage(storage),
    })
    enterServer(result, deps)
  } catch {
    // The current server is not one the list knows (an address from the
    // environment): the storage is left to it rather than lost.
    storage.setItem(STORAGE_OWNER_KEY, current)
    return "adopted"
  }
  ;(deps.reload ?? reloadPage)()
  return "repaired"
}

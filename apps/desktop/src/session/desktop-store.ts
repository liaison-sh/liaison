// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the overlay knows about itself, in one place.
//
// It is deliberately small: which server this install is bound to, which
// session the user signed in with, which agent is on screen and where that
// agent's turns run. Everything else (the recent folders, the remembered
// permission mode, the resumable session id) already has its own store keyed
// by the thing it belongs to, and pulling those in here would give one object
// two lifetimes.
//
// PERSISTENCE follows the existing patterns rather than inventing a third one:
// the server address is the SHELL's (`set_server_address`, written 0600, the
// one value that must survive a reinstall of the webview's storage), and the
// refresh token is the shell's too (`store_refresh_token`).
//
// THE SESSION IS THE WRAPPED APP'S OWN. apps/web signs the user in, exactly as
// it does in a browser, and the overlay learns about it the way the mobile
// push client does: the `liaison:session` flag apps/web writes
// (apps/web/src/modules/auth/auth-store.ts), plus the access token the refresh
// bridge sees go past on that app's own auth calls. The shell's device grant
// is a different credential entirely: it mints an AGENT-scoped token for the
// sidecar when a local session starts, and gating the overlay on it left the
// page underneath still logged out. The access token here is held in MEMORY
// only: it is the wrapped app's, apps/web keeps its own copy in memory, and a
// copy of it in localStorage would outlive the window that earned it.

import { createSignal } from "solid-js"
import { DEFAULT_PERMISSION_MODE, getServerAddress, type PermissionMode } from "./sidecar-client"

/** The flag apps/web writes while a session is restorable. Read, never written. */
export const WEB_SESSION_FLAG_KEY = "liaison:session"

const [serverAddressSignal, setServerAddressState] = createSignal<string | null>(null)
/** The Liaison this install is bound to, or null before first launch answers. */
export const serverAddress = serverAddressSignal

const [accessTokenSignal, setAccessTokenState] = createSignal<string | null>(null)
/** The wrapped app's bearer, as the refresh bridge saw it, or null. */
export const accessToken = accessTokenSignal

const [, setSessionFlagState] = createSignal(readWebSessionFlag())

const [readySignal, setReady] = createSignal(false)
/** False until the shell has been asked for the address, so nothing flashes. */
export const bootstrapped = readySignal

function readWebSessionFlag(): boolean {
  try {
    return localStorage.getItem(WEB_SESSION_FLAG_KEY) === "1"
  } catch {
    // A window that refuses storage still has the bridge's token half.
    return false
  }
}

/** Asks the shell which server this install is bound to. Once, at start. */
export async function loadServerAddress(): Promise<string | null> {
  const stored = await getServerAddress()
  noteServerAddress(stored)
  setReady(true)
  return stored
}

/**
 * The address the SHELL answered with. Only the shell records one: a new
 * server goes through `setServerAddress` on the bridge, which switches the
 * whole window (session/server-switch.ts).
 */
export function noteServerAddress(address: string | null): void {
  setServerAddressState(address)
}

/**
 * The bearer the refresh bridge saw the wrapped app's own auth call answer
 * with. In memory only, and null on a sign-out.
 */
export function noteSessionToken(token: string | null): void {
  setAccessTokenState(token && token.length > 0 ? token : null)
}

/** Test and sign-out seam: forgets everything this module holds. */
export function resetDesktopStore(): void {
  setServerAddressState(null)
  setAccessTokenState(null)
  setSessionFlagState(false)
  setReady(false)
  setRuntimeLocationState("liaison")
  clearRuntimeLocationMirror()
  setPermissionModeState(DEFAULT_PERMISSION_MODE)
  setApprovalRequestIdState(null)
  setProducedFilesState([])
}

/** Where the turns of the conversation on screen execute. */
export type RuntimeLocation = "local" | "liaison"

/**
 * WHERE THE CHOICE SURVIVES A RELOAD, beside the server address mirror.
 *
 * The runtime the user picked lived in this module's signal and in the
 * bridge's store, and both die with the window's JS context. The device grant
 * and the connect card both reload the page, so a user who had just said "this
 * machine" came back to a control that said Liaison, with nothing started and
 * nothing to explain it. One key, written by the one setter every picker goes
 * through, read synchronously when the bridge builds its first state.
 */
export const RUNTIME_LOCATION_MIRROR_KEY = "liaison-desktop:runtime-location"

/** The runtime this install last chose, or "liaison" for a window with none. */
export function rememberedRuntimeLocation(): RuntimeLocation {
  try {
    return localStorage.getItem(RUNTIME_LOCATION_MIRROR_KEY) === "local" ? "local" : "liaison"
  } catch {
    // A window that refuses storage is a window that remembers nothing, which
    // is the window that existed before this mirror.
    return "liaison"
  }
}

/** Forgets the choice. The session ending is what makes it somebody else's. */
export function clearRuntimeLocationMirror(): void {
  try {
    localStorage.removeItem(RUNTIME_LOCATION_MIRROR_KEY)
  } catch {
    // Nothing to forget in a window that has no storage.
  }
}

const [, setRuntimeLocationState] = createSignal<RuntimeLocation>(rememberedRuntimeLocation())
export function setRuntimeLocation(location: RuntimeLocation): void {
  setRuntimeLocationState(location)
  try {
    localStorage.setItem(RUNTIME_LOCATION_MIRROR_KEY, location)
  } catch {
    // A full or refused store costs the next window's memory, never the pick.
  }
}

const [permissionModeSignal, setPermissionModeState] =
  createSignal<PermissionMode>(DEFAULT_PERMISSION_MODE)
export const permissionMode = permissionModeSignal
export function setPermissionMode(mode: PermissionMode): void {
  setPermissionModeState(mode)
}

/**
 * The gated call the session is waiting on, or null. It is a signal rather
 * than a prop threaded through the chrome because the banner and whatever
 * staged the approval are on opposite sides of the tree.
 */
const [approvalRequestIdSignal, setApprovalRequestIdState] = createSignal<string | null>(null)
export const approvalRequestId = approvalRequestIdSignal
export function setApprovalRequestId(id: string | null): void {
  setApprovalRequestIdState(id)
}

/**
 * The files the running session has produced, ready to be attached.
 *
 * A LIST (P6d-FX2, SK-8). It was one slot, mapped into the contract's array at
 * the bridge, so a session that produced two files offered only the last and
 * the composer's list was structurally capped at one. Newest last, in the order
 * they were produced, which is the order the attach row reads.
 *
 * They are NOTED by whoever knows one was produced rather than inferred from
 * the tool stream: a tool call's input shape is per tool, and guessing a path
 * out of it would offer the user a file that is not there. Recorded as the
 * bound it is.
 */
const [producedFilesSignal, setProducedFilesState] = createSignal<readonly string[]>([])
export const producedFiles = producedFilesSignal

/** One more file, or nothing for one this session already produced. */
export function noteProducedFile(path: string): void {
  const trimmed = path.trim()
  if (!trimmed) return
  setProducedFilesState((held) => (held.includes(trimmed) ? held : [...held, trimmed]))
}

/** Forgets them all, for a session that ended or a window signing out. */
export function clearProducedFiles(): void {
  setProducedFilesState([])
}

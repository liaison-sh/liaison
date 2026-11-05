// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo workspace that ends while a tab is open in it.
//
// The server refuses every credential of an expired demo workspace with the
// code `demo_workspace_expired` (a 403 on REST and on token refresh, a 4003
// close on the websocket). Every API client, the token refresh and the socket
// report it here, and this is the one place that reacts: ONCE per page, it
// hands over to the registered exit (createAuthManager.ts: the sign-out, then
// the demo door). Until the page leaves, `demoWorkspaceEnded()` is true, so an
// answer racing the exit neither toasts nor sends the person to the login page,
// and the guided tour shows no failure for a turn that could not run.
import { DEMO_WORKSPACE_EXPIRED_CODE } from "@liaison/shared"
import { createSignal } from "solid-js"

/** The door the person lands on. */
export const DEMO_DOOR_PATH = "/demo"

/** Survives the sign-out (written after it) so the door can say why they are there. */
const NOTICE_KEY = "liaison:demo-workspace-ended"

const [ended, setEnded] = createSignal(false)
let exit: (() => void) | null = null

/** Is this refusal the end of the demo workspace? */
export function isDemoWorkspaceExpired(status: number, code: string | undefined): boolean {
  return status === 403 && code === DEMO_WORKSPACE_EXPIRED_CODE
}

/** True once this page has learnt its demo workspace is over. */
export const demoWorkspaceEnded = ended

/** The exit to run when it happens (one, the last registered wins). */
export function setDemoWorkspaceExit(fn: (() => void) | null): void {
  exit = fn
}

/** The workspace is over: leave it, once, however many answers say so. */
export function noteDemoWorkspaceExpired(): void {
  if (ended()) return
  setEnded(true)
  exit?.()
}

/**
 * A refused fetch made outside the API client (the token refresh, the
 * websocket ticket): note the end of the workspace when that is what it says.
 */
export async function noteIfDemoWorkspaceExpired(res: Response): Promise<boolean> {
  if (res.status !== 403) return false
  let code: string | undefined
  try {
    const json = (await res.clone().json()) as { error?: { code?: unknown } }
    code = typeof json?.error?.code === "string" ? json.error.code : undefined
  } catch {
    return false
  }
  if (!isDemoWorkspaceExpired(res.status, code)) return false
  noteDemoWorkspaceExpired()
  return true
}

/** Leave the notice for the door (after the sign-out has cleared storage). */
export function leaveDemoEndedNotice(): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, "1")
  } catch {
    // No storage: the door still opens, without the line.
  }
}

/** Read and clear the notice: true when the door should say the workspace ended. */
export function consumeDemoEndedNotice(): boolean {
  try {
    const set = sessionStorage.getItem(NOTICE_KEY) === "1"
    if (set) sessionStorage.removeItem(NOTICE_KEY)
    return set
  } catch {
    return false
  }
}

/** Tests only: back to a page that has seen nothing. */
export function _resetDemoWorkspaceEnded(): void {
  setEnded(false)
}

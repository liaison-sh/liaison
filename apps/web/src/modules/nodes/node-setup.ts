// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "USE THIS COMPUTER AS MY NODE" (P4 N-D T4, S19, spec-node.md "Setup for
// everyone"): the checklist, as a state machine, and the two flows that turn
// the node on and off.
//
// Turning the switch on checks four things through the shell:
//
//   claude          the Claude sign-in jobs run on (the existing in-app
//                   `claude auth login --claudeai` flow fixes it);
//   notifications   the system lets Liaison notify (a refusal can only be
//                   undone in the system's settings);
//   launchAtLogin   the app starts at login, so the node comes back;
//   keepAwake       the machine stays awake while on power (the shell's
//                   NSProcessInfo activity; not available on Linux, which
//                   does not block).
//
// When all pass, the node registers: POST /api/nodes bound to this install's
// WS deviceId (F11), the node credential handed to the shell (0600 file per
// server, F13), and the window's socket reconnects to present it.
//
// Turning it off is a PATCH `enabled: false`: queued jobs wait (D11), the
// shell keeps the credential so turning back on is a PATCH too.

import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import type { DesktopBridge, DesktopNodeRecord } from "~/lib/desktop-shell-contract"
import { enableNode, updateNode } from "./node-api"
import { setNodeSession } from "./node-session"

export const CHECKLIST = ["claude", "notifications", "launchAtLogin", "keepAwake"] as const
export type ChecklistItem = (typeof CHECKLIST)[number]

export type ItemState = "checking" | "done" | "todo" | "unsupported"

export type SetupPhase =
  /** Reading what the shell holds. */
  | "loading"
  | "off"
  /** Turned on: the four items are being read. */
  | "checking"
  /** Some item is still to do: the checklist offers its fix. */
  | "setup"
  | "registering"
  | "on"
  | "error"

export interface NodeSetupState {
  phase: SetupPhase
  items: Record<ChecklistItem, ItemState>
  error: string | null
}

export type NodeSetupEvent =
  | { type: "loaded"; enabled: boolean }
  | { type: "turnOn" }
  | { type: "checked"; item: ChecklistItem; state: ItemState }
  | { type: "registered" }
  | { type: "failed"; error: string }
  | { type: "turnOff" }

function allItems(state: ItemState): Record<ChecklistItem, ItemState> {
  return { claude: state, notifications: state, launchAtLogin: state, keepAwake: state }
}

export function initialNodeSetup(): NodeSetupState {
  return { phase: "loading", items: allItems("checking"), error: null }
}

/** Every item passes; only keep awake may be unavailable on this OS. */
export function checklistComplete(items: Record<ChecklistItem, ItemState>): boolean {
  return CHECKLIST.every(
    (item) => items[item] === "done" || (item === "keepAwake" && items[item] === "unsupported"),
  )
}

export function nodeSetupReducer(state: NodeSetupState, event: NodeSetupEvent): NodeSetupState {
  switch (event.type) {
    case "loaded":
      return { ...state, phase: event.enabled ? "on" : "off", error: null }
    case "turnOn":
      if (state.phase !== "off" && state.phase !== "error") return state
      return { phase: "checking", items: allItems("checking"), error: null }
    case "checked": {
      const items = { ...state.items, [event.item]: event.state }
      if (state.phase !== "checking" && state.phase !== "setup") return { ...state, items }
      if (CHECKLIST.some((item) => items[item] === "checking")) return { ...state, items }
      return { ...state, items, phase: checklistComplete(items) ? "registering" : "setup" }
    }
    case "registered":
      return state.phase === "registering" ? { ...state, phase: "on", error: null } : state
    case "failed":
      return { ...state, phase: "error", error: event.error }
    case "turnOff":
      return { ...state, phase: "off", error: null }
  }
}

type Shell = Pick<
  DesktopBridge,
  | "platform"
  | "checkClaudeAccount"
  | "startClaudeSignIn"
  | "notificationPermission"
  | "requestNotificationPermission"
  | "launchAtLogin"
  | "setLaunchAtLogin"
  | "keepAwake"
  | "setKeepAwake"
  | "storeNodeCredential"
  | "loadNodeCredential"
>

function keepAwakeState(status: { enabled: boolean; supported: boolean }): ItemState {
  if (!status.supported) return "unsupported"
  return status.enabled ? "done" : "todo"
}

/** One item, as the shell answers it now. A shell that cannot answer is to do. */
export async function readChecklistItem(item: ChecklistItem, shell: Shell): Promise<ItemState> {
  try {
    switch (item) {
      case "claude":
        return (await shell.checkClaudeAccount?.())?.loggedIn ? "done" : "todo"
      case "notifications":
        return (await shell.notificationPermission?.()) === "granted" ? "done" : "todo"
      case "launchAtLogin":
        return (await shell.launchAtLogin?.()) === true ? "done" : "todo"
      case "keepAwake":
        return shell.keepAwake ? keepAwakeState(await shell.keepAwake()) : "unsupported"
    }
  } catch {
    return item === "keepAwake" ? "unsupported" : "todo"
  }
}

/**
 * The one fix each item has. The Claude sign-in is the shell's own flow (its
 * dialog asks for the code); it answers `checking` and the page re-reads the
 * item when the shell's account changes.
 */
export async function fixChecklistItem(item: ChecklistItem, shell: Shell): Promise<ItemState> {
  try {
    switch (item) {
      case "claude":
        return (await shell.startClaudeSignIn?.()) ? "checking" : "todo"
      case "notifications":
        return (await shell.requestNotificationPermission?.()) === "granted" ? "done" : "todo"
      case "launchAtLogin":
        return (await shell.setLaunchAtLogin?.(true)) === true ? "done" : "todo"
      case "keepAwake":
        return shell.setKeepAwake ? keepAwakeState(await shell.setKeepAwake(true)) : "unsupported"
    }
  } catch {
    return "todo"
  }
}

interface FlowDeps {
  api: Pick<ApiClient, "post" | "patch">
  shell: Shell
  server: string
}

/** The server no longer knows the node this shell holds: enable it afresh. */
function forgotten(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status)
}

/**
 * Turns this computer's node on. A node the shell already holds is switched
 * back on (PATCH); otherwise, or when the server forgot it, the node is
 * enabled for this install's device id and the credential handed to the
 * shell. Throws, storing nothing, when the server refuses.
 */
export async function registerNode(
  deps: FlowDeps & { deviceId: string },
): Promise<DesktopNodeRecord> {
  const { api, shell, server, deviceId } = deps
  let record: DesktopNodeRecord | null = null
  const held = (await shell.loadNodeCredential?.(server)) ?? null
  if (held) {
    try {
      await updateNode(api, held.nodeId, { enabled: true })
      record = { ...held, enabled: true }
    } catch (error) {
      if (!forgotten(error)) throw error
    }
  }
  if (!record) {
    const res = await enableNode(api, { deviceId, os: shell.platform })
    if (!res?.node?.id || !res.credential) throw new Error("the server answered no node")
    record = { nodeId: res.node.id, credential: res.credential, enabled: true }
  }
  if (!shell.storeNodeCredential) throw new Error("this app cannot keep a node credential")
  await shell.storeNodeCredential(server, record)
  setNodeSession(record)
  return record
}

/** Turns the node off: nothing queued is cancelled, the credential is kept. */
export async function turnOffNode(deps: FlowDeps): Promise<void> {
  const { api, shell, server } = deps
  const held = (await shell.loadNodeCredential?.(server)) ?? null
  if (held) {
    await updateNode(api, held.nodeId, { enabled: false })
    await shell.storeNodeCredential?.(server, { ...held, enabled: false })
  }
  setNodeSession(held ? { ...held, enabled: false } : null)
}

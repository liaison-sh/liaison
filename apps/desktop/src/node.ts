// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THIS COMPUTER AS THE USER'S NODE (P4 N-D T4, S19): the shell's half.
//
// The node credential the server issued lives in the SHELL, per server, in a
// 0600 file (src-tauri/src/node.rs), like the notification receipt
// credential; the page stores it after enabling and reads it back for its WS
// hello. Keep awake is the shell's NSProcessInfo activity (idle system sleep
// disabled) held while the node is on and the machine is on power.

import type {
  DesktopKeepAwake,
  DesktopNodeRecord,
  DesktopNodeRoot,
} from "@liaison/web/lib/desktop-shell-contract"
import { invoke } from "./tauri"

const NO_KEEP_AWAKE: DesktopKeepAwake = {
  enabled: false,
  supported: false,
  nodeOn: false,
  power: "unknown",
  held: false,
}

function isNodeRecord(value: unknown): value is DesktopNodeRecord {
  const node = value as Partial<DesktopNodeRecord> | null
  return (
    typeof node?.nodeId === "string" &&
    node.nodeId.length > 0 &&
    typeof node.credential === "string" &&
    node.credential.length > 0 &&
    typeof node.enabled === "boolean"
  )
}

function keepAwakeStatus(value: unknown): DesktopKeepAwake {
  const status = value as Partial<DesktopKeepAwake> | null
  if (typeof status?.enabled !== "boolean") return NO_KEEP_AWAKE
  return {
    enabled: status.enabled,
    supported: status.supported === true,
    nodeOn: status.nodeOn === true,
    power: status.power === "ac" || status.power === "battery" ? status.power : "unknown",
    held: status.held === true,
  }
}

/** Stores (or, with null, removes) the CURRENT server's node. Throws on a refusal. */
export async function storeNodeCredential(
  server: string,
  node: DesktopNodeRecord | null,
): Promise<void> {
  await invoke("store_node_credential", { server, node })
}

/** The node the shell keeps for `server`, only when it is the current one. */
export async function loadNodeCredential(server: string): Promise<DesktopNodeRecord | null> {
  try {
    const stored = await invoke<unknown>("load_node_credential", { server })
    return isNodeRecord(stored) ? stored : null
  } catch {
    return null
  }
}

export async function keepAwake(): Promise<DesktopKeepAwake> {
  try {
    return keepAwakeStatus(await invoke<unknown>("get_keep_awake"))
  } catch {
    return NO_KEEP_AWAKE
  }
}

export async function setKeepAwake(enabled: boolean): Promise<DesktopKeepAwake> {
  try {
    return keepAwakeStatus(await invoke<unknown>("set_keep_awake", { enabled }))
  } catch {
    return keepAwake()
  }
}

/** Remote Auto (node_job.rs): off unless the shell says it is on. */
export async function remoteAuto(): Promise<boolean> {
  try {
    return (await invoke<unknown>("get_node_remote_auto")) === true
  } catch {
    return false
  }
}

/** Turning it on asks the shell's own dialog; answers the switch afterwards. */
export async function setRemoteAuto(enabled: boolean): Promise<boolean> {
  try {
    return (await invoke<unknown>("set_node_remote_auto", { enabled })) === true
  } catch {
    return remoteAuto()
  }
}

function nodeRootOf(value: unknown): DesktopNodeRoot {
  const root = value as Partial<DesktopNodeRoot> | null
  return {
    path: typeof root?.path === "string" ? root.path : "",
    isDefault: root?.isDefault === true,
  }
}

export async function nodeRoot(): Promise<DesktopNodeRoot> {
  return nodeRootOf(await invoke<unknown>("get_node_root"))
}

/** Throws the shell's refusal ("JobRunning", "NodeRootRefused"). */
export async function setNodeRoot(path: string | null): Promise<DesktopNodeRoot> {
  return nodeRootOf(await invoke<unknown>("set_node_root", { path }))
}

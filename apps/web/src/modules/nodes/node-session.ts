// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE SESSION OF THIS WINDOW (P4 N-D T4, A25): the node credential the
// shell keeps for the current server, read once at start and replaced when
// Settings > Computers turns this computer on or off. The WS hello presents it
// (createWebSocket `getNodeCredential`), which is what marks the node online
// server-side; a change tells the shell's socket to reconnect so the next
// hello carries the new answer.
//
// Outside the desktop app every entry point is a no-op.

import type { DesktopNodeRecord } from "~/lib/desktop-shell-contract"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { serverAddressOverride } from "~/lib/env"
import { myNodes } from "./node-api"

let current: DesktopNodeRecord | null = null
const listeners = new Set<() => void>()

/** What the hello presents: the credential of an ENABLED node, or nothing. */
export function nodeCredentialForHello(): string | null {
  return current?.enabled ? current.credential : null
}

/** This window's own enabled node, when it is one (the desktop app only). */
export function currentNodeId(): string | null {
  return current?.enabled ? current.nodeId : null
}

/** Replaces the node; listeners hear only a change of what the hello presents. */
export function setNodeSession(node: DesktopNodeRecord | null): void {
  const before = nodeCredentialForHello()
  current = node
  if (nodeCredentialForHello() === before) return
  for (const listener of Array.from(listeners)) listener()
}

export function onNodeSessionChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** At start, before the first hello: the shell's node for the current server. */
export async function restoreNodeSession(): Promise<DesktopNodeRecord | null> {
  const shell = getDesktopBridge()
  const server = serverAddressOverride()
  if (!shell?.loadNodeCredential || !server) return null
  try {
    current = await shell.loadNodeCredential(server)
  } catch {
    current = null
  }
  return current
}

/**
 * A NODE REMOVED ELSEWHERE IS NO NODE (walk N13). Once the session is
 * restored, the server is asked whether it still has this node; when it
 * answers without it (Settings > Computers > Remove on another device), the
 * shell's credential is dropped and the hello presents none. A server that
 * cannot be asked changes nothing. Answers the node that remains, or null.
 */
export async function verifyNodeSession(
  api: Parameters<typeof myNodes>[0],
): Promise<DesktopNodeRecord | null> {
  const node = current
  if (!node?.enabled) return node
  const listed = await myNodes(api).catch(() => null)
  if (!listed || listed.some((n) => n.id === node.nodeId)) return node
  const server = serverAddressOverride()
  const shell = getDesktopBridge()
  if (server && shell?.storeNodeCredential) {
    await shell.storeNodeCredential(server, null).catch(() => undefined)
  }
  setNodeSession(null)
  return null
}

/**
 * Sign-out in the desktop app: the shell's copy goes (the next person to sign
 * in on this computer never presents this owner's node), and the shell lets
 * the machine sleep again. The node itself stays on the server (D11).
 */
export async function forgetNodeSession(): Promise<void> {
  const server = serverAddressOverride()
  current = null
  const shell = getDesktopBridge()
  if (!server || !shell?.storeNodeCredential) return
  await shell.storeNodeCredential(server, null).catch(() => undefined)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const NodeSessionTestAccess = {
  /** Forget the session and every listener. */
  reset(): void {
    current = null
    listeners.clear()
  },
}

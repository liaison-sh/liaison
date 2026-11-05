// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CONVERSATION'S NODE RUNTIME, as the page knows it (P4 N-D T6, S21, S24,
// A24). The server keeps it (apps/api/src/modules/nodes/thread-settings.ts):
//
//   GET /api/nodes/threads/:threadId/settings   every agent's node runtime here
//   PUT /api/nodes/threads/:threadId/settings   { agentId, runsOn, permissionMode?, nodeId?, model? }
//
// so the web, the phone and the desktop show and use the same runtime. No row
// is the cloud. "My node" is offered only while one of the person's nodes is
// enabled and online (GET /api/nodes/me), named by the node, and Bypass is never offered: a node chat is driven
// remotely and the server refuses it (422 bypass_unavailable_remote).

import { NODE_CHAT_PERMISSION_MODES, type NodeChatPermissionMode } from "@liaison/shared"
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import {
  hasEnabledNode as anyEnabledNode,
  availableNodes,
  loadNodes,
  resetNodesStore,
} from "./nodes-store"

export { availableNodes }

export type ThreadRunsOn = "cloud" | "node" | "node_else_cloud"

/** The modes a node chat may run in: the local session's, without Bypass (A24, L23). */
export { NODE_CHAT_PERMISSION_MODES, type NodeChatPermissionMode }

export interface ThreadNodeSetting {
  agentId: string
  runsOn: Exclude<ThreadRunsOn, "cloud">
  permissionMode: NodeChatPermissionMode
  /** The node it runs on; null: whichever of the owner's nodes is live. */
  nodeId: string | null
  /** The Claude model the node chat runs on; null: the agent's preference. */
  model: string | null
  ownerUserId: string
  /** True when the viewer is the node owner (their messages go to the node). */
  mine: boolean
  hasSession: boolean
  updatedAt: string
}

type Api = Pick<ApiClient, "get" | "put">

export const threadSettingsPath = (threadId: string) =>
  `/nodes/threads/${encodeURIComponent(threadId)}/settings`

const [byThread, setByThread] = createStore<Record<string, ThreadNodeSetting[]>>({})
const threadsRead = new Map<string, Promise<void>>()

/** True when the viewer has an enabled node, kept live by the nodes store (L27). */
export function hasEnabledNode(): boolean {
  return anyEnabledNode()
}

/** Reads the viewer's nodes through the live nodes store (a failure reads as none). */
export function loadMyNodes(api: Pick<ApiClient, "get">): Promise<void> {
  return loadNodes(api)
}

/** Reads one conversation's node runtimes, once per page unless forced. */
export function loadThreadNodeRuntime(
  api: Pick<ApiClient, "get">,
  threadId: string,
  force = false,
): Promise<void> {
  const cached = threadsRead.get(threadId)
  if (cached && !force) return cached
  const read = api
    .get<ThreadNodeSetting[]>(threadSettingsPath(threadId))
    .then((rows) => {
      setByThread(threadId, Array.isArray(rows) ? rows : [])
    })
    .catch(() => {
      threadsRead.delete(threadId)
    })
  threadsRead.set(threadId, read)
  return read
}

/** One agent's node runtime in one conversation, or null (the cloud). */
export function nodeRuntimeFor(
  threadId: string | null | undefined,
  agentId: string | null | undefined,
): ThreadNodeSetting | null {
  if (!threadId || !agentId) return null
  return (byThread[threadId] ?? []).find((row) => row.agentId === agentId) ?? null
}

/** The viewer's OWN node runtime in this conversation, whatever the agent. */
export function myNodeRuntimeIn(threadId: string | null | undefined): ThreadNodeSetting | null {
  if (!threadId) return null
  return (byThread[threadId] ?? []).find((row) => row.mine) ?? null
}

/**
 * Stores where one agent's turns run in this conversation. Throws what the
 * server answered; the store moves only once it said yes.
 */
export async function setThreadNodeRuntime(
  api: Api,
  threadId: string,
  body: {
    agentId: string
    runsOn: ThreadRunsOn
    permissionMode?: NodeChatPermissionMode
    nodeId?: string | null
    model?: string | null
  },
): Promise<void> {
  const answer = await api.put<ThreadNodeSetting | { agentId: string; runsOn: "cloud" }>(
    threadSettingsPath(threadId),
    body,
  )
  setByThread(
    produce((all) => {
      const rows = (all[threadId] ?? []).filter((row) => row.agentId !== body.agentId)
      if (answer && answer.runsOn !== "cloud") rows.push(answer as ThreadNodeSetting)
      all[threadId] = rows
    }),
  )
}

/**
 * Forgets every per-thread setting and the enabled-node flag. Runs on sign-out
 * so the next account on this tab never sees the previous one's node runtimes
 * or is offered "My node" from the previous one's node.
 */
export function resetThreadNodeRuntime(): void {
  setByThread(
    produce((all) => {
      for (const key of Object.keys(all)) delete all[key]
    }),
  )
  resetNodesStore()
  threadsRead.clear()
}

onSessionTeardown(resetThreadNodeRuntime)

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ThreadNodeRuntimeTestAccess = {
  /** Forget every per-thread setting and the enabled-node flag. */
  reset(): void {
    resetThreadNodeRuntime()
  },
}

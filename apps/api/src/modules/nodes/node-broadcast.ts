// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Live node changes for the owner's clients (S18, C10, P2-D5).
 *
 * Every change to a node the owner sees on the Nodes page or in the Sessions
 * app (presence, the node row, its capabilities, a profile, an attachment, a
 * removal) is published as one ephemeral app `kernel`, entity `node` frame:
 *
 *   { ownerUserId, nodeId, change, online? }
 *
 * The frame names what changed and nothing else (no paths, no capability
 * contents): the client refetches `GET /nodes/me`. It goes through
 * `broadcastEphemeral`, never the outbox (D40), and the websocket manager's
 * owner filter delivers it to `ownerUserId`'s sockets only, fail closed.
 *
 * Presence listeners (`onNodePresence`) are P3's seam for pause and resume
 * (D36): they run after the broadcast, and a listener error is logged.
 *
 * Best effort throughout: a failed publish is logged and never fails the
 * route or the connection that caused it; clients heal by refetch on resync
 * and focus.
 */
import { and, eq, isNull } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { nodes } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "node-broadcast" })

export type NodeChange = "presence" | "node" | "capabilities" | "profile" | "attachment" | "removed"

export interface NodeChangeFrame {
  ownerUserId: string
  nodeId: string
  change: NodeChange
  online?: boolean
}

/** Publish one node change to its owner's clients. Never throws. */
export async function publishNodeChange(input: {
  orgId: string
  ownerUserId: string
  nodeId: string
  change: NodeChange
  online?: boolean
}): Promise<void> {
  const data: NodeChangeFrame = {
    ownerUserId: input.ownerUserId,
    nodeId: input.nodeId,
    change: input.change,
    ...(input.online !== undefined ? { online: input.online } : {}),
  }
  try {
    await broadcastEphemeral({
      app: "kernel",
      entity: "node",
      action: "update",
      entityId: input.nodeId,
      orgId: input.orgId,
      data,
    })
  } catch (err) {
    log.warn({ err, nodeId: input.nodeId, change: input.change }, "node change publish failed")
  }
}

/**
 * One frame per enabled node of the owner: a profile or an attachment applies
 * to every node of theirs, so each node's page section reloads.
 */
export async function publishOwnerNodesChange(input: {
  orgId: string
  ownerUserId: string
  change: NodeChange
}): Promise<void> {
  let ids: string[] = []
  try {
    const rows = await withSystemDb("nodes:broadcast-owner-nodes", (db) =>
      db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.orgId, input.orgId),
            eq(nodes.ownerUserId, input.ownerUserId),
            eq(nodes.enabled, true),
            isNull(nodes.revokedAt),
          ),
        ),
    )
    ids = rows.map((r) => r.id)
  } catch (err) {
    log.warn({ err, change: input.change }, "node change: owner's nodes read failed")
    return
  }
  for (const nodeId of ids) {
    await publishNodeChange({ ...input, nodeId })
  }
}

export interface NodePresenceChange {
  orgId: string
  ownerUserId: string
  nodeId: string
  online: boolean
}

export type NodePresenceListener = (change: NodePresenceChange) => void | Promise<void>

const presenceListeners = new Set<NodePresenceListener>()

/** Run `listener` on every node presence change, after its broadcast. Returns the unregister. */
export function onNodePresence(listener: NodePresenceListener): () => void {
  presenceListeners.add(listener)
  return () => {
    presenceListeners.delete(listener)
  }
}

/**
 * A node came online or went offline: publish the `presence` frame, then run
 * the listeners in registration order. Never throws.
 */
export async function notifyNodePresence(change: NodePresenceChange): Promise<void> {
  await publishNodeChange({ ...change, change: "presence" })
  for (const listener of [...presenceListeners]) {
    try {
      await listener(change)
    } catch (err) {
      log.warn(
        { err, nodeId: change.nodeId, online: change.online },
        "node presence listener failed",
      )
    }
  }
}

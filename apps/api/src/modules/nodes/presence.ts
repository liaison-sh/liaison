// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Node presence (S19, A23, F11, F12).
 *
 * ONLINE IS THE LIVE PRESENCE REGISTRY, never a stored flag: a node is online
 * while a `desktop_app` connection of its owner is bound to it in the shared
 * registry (TTL 60 s, refreshed by the 30 s heartbeat). A connection is bound
 * when its hello presented the node's credential AND announced the node's
 * deviceId (A25, F11). That is the same registry the computer notifications
 * read, so it holds across API instances and lapses on its own when a machine
 * dies.
 *
 * The connected INTERVALS are recorded too (`node_connections`), because "was a
 * node connected when this job was created" and "last seen" are history the
 * registry does not keep. An interval opens on the node connection's hello
 * and closes on its disconnect. A process that dies never runs its close, so
 * an open interval whose connection has left the registry is closed by the
 * sweep (every minute, and once at boot) as `stale`.
 *
 * A SIMULATED node (a demo org's recorded laptop, `nodes.simulated`) has no
 * socket and never will: on a demo instance it reads as online from its row
 * (a synthetic entry, no connection behind it), so its recorded session is
 * never paused and its owner's controls stay enabled. It can never bind a
 * connection (its hello is refused: no credential) and it has no connected
 * intervals, so the sweep leaves it out.
 */
import { and, eq, isNull, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { nodeConnections, nodes } from "~/db/schema/kernel"
import { isNotifyConnLive, type NotifyPresenceEntry, readNotifyPresence } from "~/infra/websocket"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"
import { isSimulatedNode, verifyNodeCredential } from "./credentials"
import { notifyNodePresence } from "./node-broadcast"

const log = rootLogger.child({ module: "nodes-presence" })

/** The owner's live node connections, keyed by the node they are bound to. */
export async function liveDesktopConnections(
  orgId: string,
  userId: string,
): Promise<Map<string, NotifyPresenceEntry[]>> {
  const out = new Map<string, NotifyPresenceEntry[]>()
  let entries: NotifyPresenceEntry[] = []
  try {
    entries = await readNotifyPresence(redis, orgId, userId)
  } catch (err) {
    // Unknown presence reads as offline: a job is then a backlog job, which
    // asks before it runs. The safe side of the question.
    log.warn({ err, orgId, userId }, "node presence read failed")
    return out
  }
  for (const e of entries) {
    if (e.kind !== "desktop_app" || !e.nodeId) continue
    const list = out.get(e.nodeId) ?? []
    list.push(e)
    out.set(e.nodeId, list)
  }
  for (const e of await simulatedNodeEntries(orgId, userId)) out.set(e.nodeId as string, [e])
  return out
}

/** The connection id of a simulated node's synthetic presence entry (no socket has it). */
export const SIMULATED_CONN_PREFIX = "simulated:"

/**
 * The owner's simulated nodes as synthetic presence entries: online while
 * enabled and not revoked. Only on a demo instance (elsewhere no simulated node
 * can exist, and no query runs). A failed read is no entry (offline).
 */
async function simulatedNodeEntries(orgId: string, userId: string): Promise<NotifyPresenceEntry[]> {
  if (!isDemoModeEnabled()) return []
  try {
    const rows = await withPrivilegedDb(orgId, "nodes:simulated-presence", (tx) =>
      tx
        .select({ id: nodes.id, deviceId: nodes.deviceId, updatedAt: nodes.updatedAt })
        .from(nodes)
        .where(
          and(
            eq(nodes.orgId, orgId),
            eq(nodes.ownerUserId, userId),
            eq(nodes.simulated, true),
            eq(nodes.enabled, true),
            isNull(nodes.revokedAt),
          ),
        ),
    )
    return rows.map((r) => ({
      connId: `${SIMULATED_CONN_PREFIX}${r.id}`,
      instanceId: "simulated",
      kind: "desktop_app" as const,
      lastActiveAt: Date.now(),
      deviceId: r.deviceId,
      nodeId: r.id,
    }))
  } catch (err) {
    log.warn({ err, orgId, userId }, "simulated node presence read failed")
    return []
  }
}

/**
 * Whether another live connection still binds the node, leaving out the one
 * that just closed (its registry cleanup is fire and forget). Unknown reads
 * as offline, the side that pauses rather than runs.
 */
async function boundElsewhere(
  orgId: string,
  ownerUserId: string,
  nodeId: string,
  closedConnId: string,
): Promise<boolean> {
  const live = await liveDesktopConnections(orgId, ownerUserId)
  return (live.get(nodeId) ?? []).some((e) => e.connId !== closedConnId)
}

/** A connection of the node closed: tell the owner's clients, unless another still binds it. */
async function notifyClosed(
  orgId: string,
  ownerUserId: string,
  nodeId: string,
  closedConnId: string,
): Promise<void> {
  if (await boundElsewhere(orgId, ownerUserId, nodeId, closedConnId)) return
  await notifyNodePresence({ orgId, ownerUserId, nodeId, online: false })
}

/**
 * Open a connected interval for a desktop connection's hello, when it
 * presented a live node credential of the connected user, for an enabled node
 * bound to the deviceId the same hello announced. Null otherwise: no credential,
 * someone else's, a rotated or revoked one, a switched-off node, or a
 * credential presented from another install.
 */
export async function openNodeSessionForHello(input: {
  orgId: string
  userId: string
  deviceId: string
  connId: string
  nodeCredential: string | undefined
}): Promise<{ nodeId: string; sessionId: string } | null> {
  if (!input.nodeCredential) return null
  const node = await verifyNodeCredential(input.nodeCredential)
  if (
    !node ||
    isSimulatedNode(node) ||
    node.orgId !== input.orgId ||
    node.ownerUserId !== input.userId ||
    node.deviceId !== input.deviceId ||
    !node.enabled
  ) {
    return null
  }
  return withPrivilegedDb(input.orgId, "nodes:session-open", async (tx) => {
    const [session] = await tx
      .insert(nodeConnections)
      .values({ orgId: input.orgId, nodeId: node.id, connId: input.connId })
      .returning({ id: nodeConnections.id })
    await tx
      .update(nodes)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(nodes.id, node.id), eq(nodes.orgId, input.orgId)))
    return { nodeId: node.id, sessionId: session.id }
  })
}

/** Close one interval (the connection closed). A closed one stays as it was. */
export async function closeNodeSession(
  orgId: string,
  sessionId: string,
  reason: "disconnect" | "stale" | "revoked" = "disconnect",
): Promise<void> {
  const node = await withPrivilegedDb(orgId, "nodes:session-close", async (tx) => {
    const [closed] = await tx
      .update(nodeConnections)
      .set({ disconnectedAt: new Date(), closeReason: reason })
      .where(
        and(
          eq(nodeConnections.id, sessionId),
          eq(nodeConnections.orgId, orgId),
          isNull(nodeConnections.disconnectedAt),
        ),
      )
      .returning({ nodeId: nodeConnections.nodeId, connId: nodeConnections.connId })
    if (!closed) return null
    const [node] = await tx
      .update(nodes)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(nodes.id, closed.nodeId), eq(nodes.orgId, orgId)))
      .returning({ ownerUserId: nodes.ownerUserId })
    return node ? { ...closed, ownerUserId: node.ownerUserId } : null
  })
  if (node) await notifyClosed(orgId, node.ownerUserId, node.nodeId, node.connId)
}

/** Refresh a node's last seen time (the connection's heartbeat). */
export async function touchNode(orgId: string, nodeId: string): Promise<void> {
  await withPrivilegedDb(orgId, "nodes:touch", (tx) =>
    tx
      .update(nodes)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(nodes.id, nodeId), eq(nodes.orgId, orgId))),
  )
}

/**
 * Close every open interval whose connection has left the presence registry
 * (its process died, or its close never ran). Returns how many it closed.
 */
export async function sweepStaleNodeSessions(): Promise<number> {
  // An org being moved keeps its connection rows as they are until the move ends.
  const open = await sweepSkippingMoving((notMoving) =>
    withSystemDb("nodes:session-sweep-load", (db) =>
      db
        .select({
          id: nodeConnections.id,
          orgId: nodeConnections.orgId,
          connId: nodeConnections.connId,
          nodeId: nodeConnections.nodeId,
          ownerUserId: nodes.ownerUserId,
        })
        .from(nodeConnections)
        .innerJoin(nodes, eq(nodes.id, nodeConnections.nodeId))
        .where(
          and(
            isNull(nodeConnections.disconnectedAt),
            eq(nodes.simulated, false),
            notMoving(nodeConnections.orgId),
          ),
        )
        .limit(5000),
    ),
  )
  let closed = 0
  for (const row of open) {
    let live = true
    try {
      live = await isNotifyConnLive(redis, row.connId)
    } catch (err) {
      // Unknown is not stale: close nothing on a Redis error.
      log.warn({ err, sessionId: row.id }, "node session liveness read failed")
      continue
    }
    if (live) continue
    const swept = await writeUnlessMoving(row.orgId, () =>
      withSystemDb("nodes:session-sweep-close", (db) =>
        db
          .update(nodeConnections)
          .set({ disconnectedAt: sql`now()`, closeReason: "stale" })
          .where(
            and(
              eq(nodeConnections.id, row.id),
              eq(nodeConnections.orgId, row.orgId),
              isNull(nodeConnections.disconnectedAt),
            ),
          )
          .returning({ id: nodeConnections.id }),
      ),
    )
    if (swept === SKIPPED_MOVING || swept.length === 0) continue
    await notifyClosed(row.orgId, row.ownerUserId, row.nodeId, row.connId)
    // Walk D9: a connection that died without a close (network loss) leaves
    // the registry on its own; with no other connection bound, the node's
    // sessions pause now rather than when their lease lapses.
    const { onNodeConnectionClosed } = await import("~/modules/node-sessions/lifecycle")
    await onNodeConnectionClosed({
      orgId: row.orgId,
      userId: row.ownerUserId,
      nodeId: row.nodeId,
    })
    closed++
  }
  return closed
}

/** Close every open interval of one node (revocation). */
export async function closeAllNodeSessions(
  orgId: string,
  nodeId: string,
  reason: "revoked" | "stale",
): Promise<void> {
  const owner = await withPrivilegedDb(orgId, "nodes:session-close-all", async (tx) => {
    await tx
      .update(nodeConnections)
      .set({ disconnectedAt: new Date(), closeReason: reason })
      .where(
        and(
          eq(nodeConnections.nodeId, nodeId),
          eq(nodeConnections.orgId, orgId),
          isNull(nodeConnections.disconnectedAt),
        ),
      )
    const [row] = await tx
      .select({ ownerUserId: nodes.ownerUserId })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.orgId, orgId)))
      .limit(1)
    return row ?? null
  })
  if (owner) {
    await notifyNodePresence({ orgId, ownerUserId: owner.ownerUserId, nodeId, online: false })
  }
}

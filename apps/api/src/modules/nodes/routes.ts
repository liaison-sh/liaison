// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The local node API (S19-S23, A19-A27), under /api/nodes. Every route runs
 * on the owner's session; the node-to-server job calls also present the node
 * credential (`X-Node-Credential`), and both must name the same person.
 *
 * Registration (T1):
 *   POST   /                enable this install as a node -> { node, credential }
 *   GET    /me              { nodes } with online (live presence) and queue counts
 *   GET    /self            the node the presented credential speaks for
 *   PATCH  /:id             rename, enable / disable
 *   DELETE /:id             forget the node, revoke its credential
 *
 * Capabilities (P1, C1, D37, D42):
 *   PUT    /:id/capabilities   node credential: its shared folders (with paths),
 *                              models and per-agent level pins -> { folders, models }
 *   Paths live in kernel.node_capabilities (owner-only, written privileged) and
 *   are never answered; GET /me shows folder names, models and pins.
 */
import {
  cleanFolderName,
  currentNodeModels,
  EFFORT_LEVELS,
  type EffortLevel,
  NODE_LEVELS,
  type NodeLevel,
} from "@liaison/shared"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { nodeCapabilities, nodeJobs, nodes } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { mintNodeCredential, type NodeRow, requireNodeCredential } from "./credentials"
import { publishNodeChange } from "./node-broadcast"
import { closeAllNodeSessions, liveDesktopConnections } from "./presence"

export const nodeRoutes = new Hono<AppEnv>()

const deviceIdSchema = z.string().trim().min(1).max(128)
const nameSchema = z.string().trim().min(1).max(120)
const idParam = z.object({ id: z.string().uuid() })

const enableSchema = z.object({
  deviceId: deviceIdSchema,
  name: nameSchema.optional(),
  os: z.string().max(64).optional(),
  appVersion: z.string().max(64).optional(),
})

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    // D35 (G8): the node's live caps; background (routine, agent_tag) within live.
    maxLiveSessions: z.number().int().min(1).max(16).optional(),
    maxLiveBackground: z.number().int().min(0).max(16).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "nothing to change")
  .refine(
    (b) =>
      b.maxLiveSessions === undefined ||
      b.maxLiveBackground === undefined ||
      b.maxLiveBackground <= b.maxLiveSessions,
    "maxLiveBackground: at most maxLiveSessions",
  )

/** The name a node gets when the app enables it without one. */
function defaultNodeName(os: string | undefined): string {
  if (os === "macos") return "Mac"
  if (os === "windows") return "Windows PC"
  if (os === "linux") return "Linux computer"
  return "My computer"
}

export interface NodeQueueCounts {
  queued: number
  running: number
}

/**
 * Per node: the owner's waiting jobs this node could take (untargeted, or
 * targeted at it), and the jobs running on it.
 */
function queueFor(
  nodeId: string,
  jobs: Array<{ status: string; targetNodeId: string | null; nodeId: string | null }>,
): NodeQueueCounts {
  let queued = 0
  let running = 0
  for (const j of jobs) {
    if (j.status === "running" && j.nodeId === nodeId) running++
    else if (
      (j.status === "queued" || j.status === "offered") &&
      (j.targetNodeId === null || j.targetNodeId === nodeId)
    )
      queued++
  }
  return { queued, running }
}

/** A folder the node shares (C1): its name, absolute path and kind. */
export interface NodeCapabilityFolder {
  name: string
  path: string
  kind: "root" | "repo"
  gitDefaultBranch?: string
}

export interface NodeCapabilityModel {
  id: string
  label: string
  /** S25: the reasoning levels the model supports (absent: not published). */
  efforts?: EffortLevel[]
}

export interface NodeLevelPin {
  agentId: string
  level: NodeLevel
}

/** What the owner's clients see of a node's capabilities: folder names, never paths. */
export interface NodeCapabilityView {
  sharedFolderNames: string[]
  /**
   * A shared folder that sits inside another one (a repo the node lists
   * because it is in a folder the owner shared), by name: the name of the
   * folder that holds it. Worked out from the paths here; no path leaves.
   */
  sharedFolderWithin: Record<string, string>
  models: NodeCapabilityModel[]
  levelPins: NodeLevelPin[]
}

/** What a client sees of a node: never the credential hash, never a folder path. */
export function nodeView(
  node: NodeRow,
  online: boolean,
  queue: NodeQueueCounts = { queued: 0, running: 0 },
  capabilities?: NodeCapabilityView,
) {
  return {
    id: node.id,
    deviceId: node.deviceId,
    name: node.name,
    enabled: node.enabled,
    os: node.os,
    appVersion: node.appVersion,
    online,
    /** A demo org's recorded computer (no machine; its session is a replay). */
    simulated: node.simulated,
    maxLiveSessions: node.maxLiveSessions,
    maxLiveBackground: node.maxLiveBackground,
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
    createdAt: node.createdAt.toISOString(),
    queue,
    ...(capabilities ?? {}),
  }
}

/** Each folder inside another shared folder, by name, to the nearest one holding it. */
export function foldersWithin(folders: readonly NodeCapabilityFolder[]): Record<string, string> {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const out: Record<string, string> = {}
  for (const f of folders) {
    const path = norm(f.path)
    let holder: { name: string; length: number } | null = null
    for (const g of folders) {
      const outer = norm(g.path)
      if (g === f || !outer || !path.startsWith(`${outer}/`)) continue
      if (!holder || outer.length > holder.length) holder = { name: g.name, length: outer.length }
    }
    if (holder && holder.name !== f.name) out[f.name] = holder.name
  }
  return out
}

function capabilityView(row?: typeof nodeCapabilities.$inferSelect): NodeCapabilityView {
  const folders = (row?.sharedFolders ?? []) as NodeCapabilityFolder[]
  return {
    sharedFolderNames: folders.map((f) => f.name),
    sharedFolderWithin: foldersWithin(folders),
    // The Sessions model switch offers what this says: each family's current
    // model only, whatever an older desktop published.
    models: currentNodeModels((row?.models ?? []) as NodeCapabilityModel[]),
    levelPins: (row?.levelPins ?? []) as NodeLevelPin[],
  }
}

/** Absolute on macOS, Linux and Windows (drive or UNC). */
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\"), {
    message: "an absolute path",
  })

const capabilitiesSchema = z.object({
  sharedFolders: z
    .array(
      z.object({
        // Shown on cards and to agents: no control or bidi character (review m4).
        name: z.string().trim().min(1).max(200).transform(cleanFolderName),
        path: absolutePath,
        kind: z.enum(["root", "repo"]),
        gitDefaultBranch: z.string().min(1).max(255).optional(),
      }),
    )
    .max(500),
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        label: z.string().max(200),
        // S25: the SDK's supportedEffortLevels, kept for the composer and the agent.
        efforts: z.array(z.enum(EFFORT_LEVELS)).max(5).optional(),
      }),
    )
    .max(50),
  levelPins: z
    .array(z.object({ agentId: z.string().uuid(), level: z.enum(NODE_LEVELS) }))
    .max(200)
    .default([]),
  // S40: the session import protocol the desktop speaks (NODE_PROTOCOL_IMPORT);
  // absent from an older desktop, which then cannot list or follow sessions.
  // Declared here or the key would be stripped (GF-19).
  importProtocol: z.number().int().min(0).max(1000).optional(),
})

/**
 * Every level pin the owner's nodes published (D42): node -> agent -> level.
 * Read with `nodePinFor`, which answers Strict for anything absent.
 */
export async function loadNodePins(
  orgId: string,
  ownerUserId: string,
): Promise<Map<string, Map<string, NodeLevel>>> {
  const rows = await withPrivilegedDb(orgId, "nodes:level-pins", (tx) =>
    tx
      .select({ nodeId: nodeCapabilities.nodeId, levelPins: nodeCapabilities.levelPins })
      .from(nodeCapabilities)
      .where(and(eq(nodeCapabilities.orgId, orgId), eq(nodeCapabilities.ownerUserId, ownerUserId))),
  )
  const pins = new Map<string, Map<string, NodeLevel>>()
  for (const row of rows) {
    pins.set(row.nodeId, new Map(row.levelPins.map((p) => [p.agentId, p.level])))
  }
  return pins
}

/** The level a node has pinned for an agent; Strict when it published none (D42). */
export function nodePinFor(
  pins: Map<string, Map<string, NodeLevel>>,
  nodeId: string,
  agentId: string,
): NodeLevel {
  return pins.get(nodeId)?.get(agentId) ?? "strict"
}

nodeRoutes.post("/", zValidator("json", enableSchema), async (c) => {
  assertUnrestrictedSession(c, "turn this computer into a node")
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const body = c.req.valid("json")
  const { token, hash } = mintNodeCredential()
  const now = new Date()
  // Bound to (owner, install): enabling the same install again rotates the
  // credential, clears a revocation and keeps the row (and its job history).
  const [node] = await withRequestRls(c, (tx) =>
    tx
      .insert(nodes)
      .values({
        orgId,
        ownerUserId: userId,
        deviceId: body.deviceId,
        name: body.name ?? defaultNodeName(body.os),
        os: body.os ?? null,
        appVersion: body.appVersion ?? null,
        credentialHash: hash,
        credentialIssuedAt: now,
      })
      .onConflictDoUpdate({
        target: [nodes.ownerUserId, nodes.deviceId],
        set: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.os !== undefined ? { os: body.os } : {}),
          ...(body.appVersion !== undefined ? { appVersion: body.appVersion } : {}),
          credentialHash: hash,
          credentialIssuedAt: now,
          revokedAt: null,
          enabled: true,
          updatedAt: now,
        },
        // A demo org's recorded node is never enabled as a real one: it
        // never gets a credential (0193).
        setWhere: eq(nodes.simulated, false),
      })
      .returning(),
  )
  if (!node) {
    throw new HTTPException(409, { message: "this device belongs to a recorded demo computer" })
  }
  await publishNodeChange({ orgId, ownerUserId: userId, nodeId: node.id, change: "node" })
  const live = await liveDesktopConnections(orgId, userId)
  return success(
    c,
    // `credential` is answered once; the app keeps it (0600 file, F13).
    { node: nodeView(node, live.has(node.id)), credential: token },
    undefined,
    201,
  )
})

nodeRoutes.get("/me", async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const { rows, jobs, caps } = await withRequestRls(c, async (tx) => {
    const rows = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.ownerUserId, userId), isNull(nodes.revokedAt)))
      .orderBy(nodes.createdAt)
    // Owner-only RLS (D37): the caller's own capability rows, if any.
    const caps =
      rows.length === 0
        ? []
        : await tx
            .select()
            .from(nodeCapabilities)
            .where(
              inArray(
                nodeCapabilities.nodeId,
                rows.map((r) => r.id),
              ),
            )
    const jobs = await tx
      .select({
        status: nodeJobs.status,
        targetNodeId: nodeJobs.targetNodeId,
        nodeId: nodeJobs.nodeId,
      })
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.ownerUserId, userId),
          inArray(nodeJobs.status, ["queued", "offered", "running"]),
        ),
      )
    return { rows, jobs, caps }
  })
  const live = await liveDesktopConnections(orgId, userId)
  const capsByNode = new Map(caps.map((r) => [r.nodeId, r]))
  return success(c, {
    nodes: rows.map((n) =>
      nodeView(
        n,
        n.enabled && live.has(n.id),
        queueFor(n.id, jobs),
        capabilityView(capsByNode.get(n.id)),
      ),
    ),
    queuedJobs: jobs.filter((j) => j.status !== "running").length,
  })
})

nodeRoutes.get("/self", async (c) => {
  const node = await requireNodeCredential(c)
  const live = await liveDesktopConnections(node.orgId, node.ownerUserId)
  return success(c, nodeView(node, node.enabled && live.has(node.id)))
})

nodeRoutes.put(
  "/:id/capabilities",
  zValidator("param", idParam),
  zValidator("json", capabilitiesSchema),
  async (c) => {
    const node = await requireNodeCredential(c)
    const { id } = c.req.valid("param")
    if (node.id !== id) throw new HTTPException(403, { message: "this is not your node" })
    const body = c.req.valid("json")
    const sharedFolders: NodeCapabilityFolder[] = body.sharedFolders
    const values = {
      sharedFolders,
      models: body.models,
      levelPins: body.levelPins,
      importProtocol: body.importProtocol ?? null,
      updatedAt: new Date(),
    }
    // Privileged: the table grants the app role SELECT only (0140). The row
    // is keyed by the credential's own node, owner and org.
    await withPrivilegedDb(node.orgId, "nodes:capabilities", (tx) =>
      tx
        .insert(nodeCapabilities)
        .values({ nodeId: node.id, orgId: node.orgId, ownerUserId: node.ownerUserId, ...values })
        .onConflictDoUpdate({ target: nodeCapabilities.nodeId, set: values }),
    )
    await publishNodeChange({
      orgId: node.orgId,
      ownerUserId: node.ownerUserId,
      nodeId: node.id,
      change: "capabilities",
    })
    return success(c, { folders: sharedFolders.map((f) => f.name), models: body.models })
  },
)

nodeRoutes.patch(
  "/:id",
  zValidator("param", idParam),
  zValidator("json", patchSchema),
  async (c) => {
    const userId = c.get("userId")
    const { id } = c.req.valid("param")
    const body = c.req.valid("json")
    let node: NodeRow | undefined
    try {
      ;[node] = await withRequestRls(c, (tx) =>
        tx
          .update(nodes)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.maxLiveSessions !== undefined
              ? { maxLiveSessions: body.maxLiveSessions }
              : {}),
            ...(body.maxLiveBackground !== undefined
              ? { maxLiveBackground: body.maxLiveBackground }
              : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, userId), isNull(nodes.revokedAt)))
          .returning(),
      )
    } catch (err) {
      // nodes_live_caps_check: background above the stored live cap, or the reverse.
      const e = err as { code?: string; cause?: { code?: string } } | null
      if (e?.code === "23514" || e?.cause?.code === "23514")
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "maxLiveBackground: at most maxLiveSessions",
            },
          },
          400,
        )
      throw err
    }
    if (!node) throw new HTTPException(404, { message: "no such node" })
    await publishNodeChange({
      orgId: node.orgId,
      ownerUserId: userId,
      nodeId: node.id,
      change: "node",
    })
    const live = await liveDesktopConnections(node.orgId, userId)
    return success(c, { node: nodeView(node, node.enabled && live.has(node.id)) })
  },
)

nodeRoutes.delete("/:id", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const { id } = c.req.valid("param")
  // Revoked, not deleted: the job history keeps naming the node. Queued jobs
  // stay queued for the owner's other nodes (D11: nothing is cancelled).
  const [node] = await withRequestRls(c, (tx) =>
    tx
      .update(nodes)
      .set({ revokedAt: new Date(), credentialHash: null, enabled: false, updatedAt: new Date() })
      .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, userId), isNull(nodes.revokedAt)))
      .returning({ id: nodes.id }),
  )
  if (!node) throw new HTTPException(404, { message: "no such node" })
  await closeAllNodeSessions(orgId, node.id, "revoked")
  await publishNodeChange({ orgId, ownerUserId: userId, nodeId: node.id, change: "removed" })
  return success(c, { id: node.id, revoked: true })
})

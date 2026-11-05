// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agents attached to a node owner's node (S25, A17), under /api/nodes, on the
 * owner's session (the desktop client's routes, apps/web node-api.ts):
 *
 *   GET    /me/attachments            the caller's attachments, oldest first
 *   POST   /me/attachments            { agentId, nodeId?, allowedRequesters?, maxJobsPerDay?, maxTokensPerDay? }
 *   PATCH  /attachments/:id           { nodeId?, allowedRequesters?, maxJobsPerDay?, maxTokensPerDay? }
 *   DELETE /attachments/:id
 *   POST   /attachments/:id/allow     the agent's side of attaching a shared agent
 *
 * WHO A REQUEST GOES TO (A17). An attachment routes a request to the node only
 * when (a) the agent allowed it: a personal agent is its own owner's to
 * attach; a shared role or system agent has no owner, so an admin allows it
 * (at once when the node owner is an admin); (b) the requester is on the
 * allowlist: the node owner always, plus the users and agents listed (a
 * request matches when its person OR its asking agent is listed); (c) the node
 * owner still has an enabled node. Several matching attachments: the EARLIEST
 * wins (created_at, then id). Every other request to that agent runs as today.
 *
 * CAPS. maxJobsPerDay counts the attachment's agent_tag jobs of the last 24
 * hours (refused and cancelled ones excluded); maxTokensPerDay sums their
 * reported usage. A reached cap refuses the request in words, never reroutes
 * it to the cloud behind the asker's back.
 */
import { suggestedNodeGuardrail } from "@liaison/shared"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents, nodeAttachments, nodeJobs, nodes, users } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { isMentionableAgent } from "~/modules/agent/directory/listing"
import { publishOwnerNodesChange } from "./node-broadcast"

export const nodeAttachmentRoutes = new Hono<AppEnv>()

export interface NodeRequester {
  type: "user" | "agent"
  id: string
}

const requesterSchema = z.object({ type: z.enum(["user", "agent"]), id: z.string().uuid() })
const capsJobs = z.number().int().min(1).max(1000)
const capsTokens = z.number().int().min(1000).max(1_000_000_000)

const createSchema = z.object({
  agentId: z.string().uuid(),
  nodeId: z.string().uuid().nullable().optional(),
  allowedRequesters: z.array(requesterSchema).max(100).optional(),
  maxJobsPerDay: capsJobs.optional(),
  maxTokensPerDay: capsTokens.optional(),
})

const patchSchema = z
  .object({
    nodeId: z.string().uuid().nullable().optional(),
    allowedRequesters: z.array(requesterSchema).max(100).optional(),
    maxJobsPerDay: capsJobs.optional(),
    maxTokensPerDay: capsTokens.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "nothing to change")

const idParam = z.object({ id: z.string().uuid() })

type AttachmentRow = typeof nodeAttachments.$inferSelect

function isAdmin(scopes: readonly string[]): boolean {
  return scopes.includes("*") || scopes.includes("kernel:*")
}

function requestersOf(row: Pick<AttachmentRow, "allowedRequesters">): NodeRequester[] {
  const raw = Array.isArray(row.allowedRequesters) ? row.allowedRequesters : []
  return raw.flatMap((r) => {
    const parsed = requesterSchema.safeParse(r)
    return parsed.success ? [parsed.data] : []
  })
}

/** Display names for the requesters and agents a list of attachments names. */
async function namesFor(orgId: string, rows: AttachmentRow[]) {
  const agentIds = new Set<string>()
  const userIds = new Set<string>()
  for (const r of rows) {
    agentIds.add(r.agentId)
    for (const q of requestersOf(r)) (q.type === "agent" ? agentIds : userIds).add(q.id)
  }
  const [agentRows, userRows] = await withSystemDb("nodes:attachment-names", async (db) => [
    agentIds.size
      ? await db
          .select({ id: agents.id, name: agents.displayName, model: agents.modelPreference })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.id, [...agentIds])))
      : [],
    userIds.size
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(and(eq(users.orgId, orgId), inArray(users.id, [...userIds])))
      : [],
  ])
  return {
    agents: new Map(agentRows.map((a) => [a.id, a.name])),
    models: new Map(agentRows.map((a) => [a.id, a.model ?? null])),
    users: new Map(userRows.map((u) => [u.id, u.name])),
  }
}

function attachmentView(row: AttachmentRow, names: Awaited<ReturnType<typeof namesFor>>) {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: names.agents.get(row.agentId) ?? null,
    // D18: the agent's model, and the guardrail level suggested for it.
    agentModel: names.models.get(row.agentId) ?? null,
    suggestedGuardrail: suggestedNodeGuardrail(names.models.get(row.agentId) ?? null),
    nodeId: row.nodeId,
    allowedRequesters: requestersOf(row).map((q) => ({
      ...q,
      name: (q.type === "agent" ? names.agents.get(q.id) : names.users.get(q.id)) ?? null,
    })),
    maxJobsPerDay: row.maxJobsPerDay,
    maxTokensPerDay: row.maxTokensPerDay,
    /** Whether the agent's side allowed it (A17): only then are requests routed. */
    allowed: row.agentAllowedAt !== null,
    createdAt: row.createdAt.toISOString(),
  }
}

async function viewOne(orgId: string, row: AttachmentRow) {
  return attachmentView(row, await namesFor(orgId, [row]))
}

/** The owner's enabled, unrevoked nodes; `nodeId` must be one of them when given. */
async function ownerNodeIds(
  c: Parameters<typeof withRequestRls>[0],
  orgId: string,
  userId: string,
): Promise<Set<string>> {
  // The caller's own nodes, read as the caller: nodes_owner admits exactly them.
  const rows = await withRequestRls(c, (tx) =>
    tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.orgId, orgId),
          eq(nodes.ownerUserId, userId),
          eq(nodes.enabled, true),
          isNull(nodes.revokedAt),
        ),
      ),
  )
  return new Set(rows.map((r) => r.id))
}

/** Every listed requester is a user or an agent of this org. */
async function requestersExist(orgId: string, list: NodeRequester[]): Promise<boolean> {
  const userIds = [...new Set(list.filter((q) => q.type === "user").map((q) => q.id))]
  const agentIds = [...new Set(list.filter((q) => q.type === "agent").map((q) => q.id))]
  return withSystemDb("nodes:attach-requesters", async (db) => {
    if (userIds.length) {
      const found = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, orgId), inArray(users.id, userIds)))
      if (found.length !== userIds.length) return false
    }
    if (agentIds.length) {
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))
      if (found.length !== agentIds.length) return false
    }
    return true
  })
}

nodeAttachmentRoutes.get("/me/attachments", async (c) => {
  const orgId = c.get("orgId")
  const rows = await withRequestRls(c, (tx) =>
    tx
      .select()
      .from(nodeAttachments)
      .where(eq(nodeAttachments.nodeOwnerUserId, c.get("userId")))
      .orderBy(asc(nodeAttachments.createdAt), asc(nodeAttachments.id)),
  )
  const names = await namesFor(orgId, rows)
  return success(
    c,
    rows.map((r) => attachmentView(r, names)),
  )
})

nodeAttachmentRoutes.post("/me/attachments", zValidator("json", createSchema), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const body = c.req.valid("json")
  const mine = await ownerNodeIds(c, orgId, userId)
  if (mine.size === 0) {
    throw new HTTPException(409, { message: "turn this computer into a node first" })
  }
  if (body.nodeId && !mine.has(body.nodeId)) {
    throw new HTTPException(404, { message: "no such node" })
  }
  if (!(await isMentionableAgent(orgId, userId, body.agentId))) {
    throw new HTTPException(403, { message: "this agent is not yours to run" })
  }
  const requesters = body.allowedRequesters ?? []
  if (!(await requestersExist(orgId, requesters))) {
    throw new HTTPException(422, { message: "a listed requester is not in this organization" })
  }
  const [agent] = await withSystemDb("nodes:attach-agent", (db) =>
    db
      .select({ kind: agents.kind, ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.id, body.agentId), eq(agents.orgId, orgId)))
      .limit(1),
  )
  if (!agent) throw new HTTPException(404, { message: "no such agent" })
  // A17: the agent's own side. The node owner's own personal agent is theirs to
  // attach; a shared agent needs an admin, which the node owner may be.
  const allowedNow =
    (agent.kind === "personal" && agent.ownerUserId === userId) || isAdmin(c.get("scopes"))
  const now = new Date()
  const [row] = await withRequestRls(c, (tx) =>
    tx
      .insert(nodeAttachments)
      .values({
        orgId,
        nodeOwnerUserId: userId,
        agentId: body.agentId,
        nodeId: body.nodeId ?? null,
        allowedRequesters: requesters,
        ...(body.maxJobsPerDay !== undefined ? { maxJobsPerDay: body.maxJobsPerDay } : {}),
        ...(body.maxTokensPerDay !== undefined ? { maxTokensPerDay: body.maxTokensPerDay } : {}),
        ...(allowedNow ? { agentAllowedBy: userId, agentAllowedAt: now } : {}),
      })
      .onConflictDoNothing({
        target: [nodeAttachments.nodeOwnerUserId, nodeAttachments.agentId],
      })
      .returning(),
  )
  if (!row) throw new HTTPException(409, { message: "this agent is already attached" })
  await publishOwnerNodesChange({ orgId, ownerUserId: userId, change: "attachment" })
  return success(c, await viewOne(orgId, row), undefined, 201)
})

nodeAttachmentRoutes.patch(
  "/attachments/:id",
  zValidator("param", idParam),
  zValidator("json", patchSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const body = c.req.valid("json")
    if (body.nodeId && !(await ownerNodeIds(c, orgId, userId)).has(body.nodeId)) {
      throw new HTTPException(404, { message: "no such node" })
    }
    if (body.allowedRequesters && !(await requestersExist(orgId, body.allowedRequesters))) {
      throw new HTTPException(422, { message: "a listed requester is not in this organization" })
    }
    const [row] = await withRequestRls(c, (tx) =>
      tx
        .update(nodeAttachments)
        .set({
          ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
          ...(body.allowedRequesters !== undefined
            ? { allowedRequesters: body.allowedRequesters }
            : {}),
          ...(body.maxJobsPerDay !== undefined ? { maxJobsPerDay: body.maxJobsPerDay } : {}),
          ...(body.maxTokensPerDay !== undefined ? { maxTokensPerDay: body.maxTokensPerDay } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(nodeAttachments.id, c.req.valid("param").id),
            eq(nodeAttachments.nodeOwnerUserId, userId),
          ),
        )
        .returning(),
    )
    if (!row) throw new HTTPException(404, { message: "no such attachment" })
    await publishOwnerNodesChange({ orgId, ownerUserId: userId, change: "attachment" })
    return success(c, await viewOne(orgId, row))
  },
)

nodeAttachmentRoutes.delete("/attachments/:id", zValidator("param", idParam), async (c) => {
  const rows = await withRequestRls(c, (tx) =>
    tx
      .delete(nodeAttachments)
      .where(
        and(
          eq(nodeAttachments.id, c.req.valid("param").id),
          eq(nodeAttachments.nodeOwnerUserId, c.get("userId")),
        ),
      )
      .returning({ id: nodeAttachments.id }),
  )
  if (rows.length === 0) throw new HTTPException(404, { message: "no such attachment" })
  await publishOwnerNodesChange({
    orgId: c.get("orgId"),
    ownerUserId: c.get("userId"),
    change: "attachment",
  })
  return success(c, { id: rows[0].id, deleted: true })
})

nodeAttachmentRoutes.post("/attachments/:id/allow", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const id = c.req.valid("param").id
  // Read privileged: the person allowing is usually not the node owner, whom
  // the table's RLS shows it to.
  const [row] = await withPrivilegedDb(orgId, "nodes:attach-allow-load", (tx) =>
    tx
      .select({ attachment: nodeAttachments, kind: agents.kind, agentOwner: agents.ownerUserId })
      .from(nodeAttachments)
      .innerJoin(agents, eq(agents.id, nodeAttachments.agentId))
      .where(and(eq(nodeAttachments.id, id), eq(nodeAttachments.orgId, orgId)))
      .limit(1),
  )
  if (!row) throw new HTTPException(404, { message: "no such attachment" })
  const mayAllow =
    isAdmin(c.get("scopes")) || (row.kind === "personal" && row.agentOwner === userId)
  if (!mayAllow) {
    throw new HTTPException(403, {
      message: "only an admin (or the agent's owner) can allow attaching this agent",
    })
  }
  const [updated] = await withPrivilegedDb(orgId, "nodes:attach-allow", (tx) =>
    tx
      .update(nodeAttachments)
      .set({ agentAllowedBy: userId, agentAllowedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(nodeAttachments.id, id), eq(nodeAttachments.orgId, orgId)))
      .returning(),
  )
  return success(c, await viewOne(orgId, updated))
})

// ── routing ─────────────────────────────────────────────────────────────────

export interface NodeRoute {
  orgId: string
  attachmentId: string
  nodeOwnerUserId: string
  agentId: string
  /** The node the attachment names, or null for any of the owner's nodes. */
  nodeId: string | null
  maxJobsPerDay: number
  maxTokensPerDay: number
}

/**
 * The attachment a request to `agentId` from this requester goes through, or
 * null when it runs as today (A17; rules in the header).
 */
export async function findNodeRoute(input: {
  orgId: string
  agentId: string
  requesterUserId: string
  requesterAgentId: string | null
}): Promise<NodeRoute | null> {
  const rows = await withPrivilegedDb(input.orgId, "nodes:route-find", (tx) =>
    tx
      .select()
      .from(nodeAttachments)
      .where(
        and(
          eq(nodeAttachments.orgId, input.orgId),
          eq(nodeAttachments.agentId, input.agentId),
          sql`${nodeAttachments.agentAllowedAt} IS NOT NULL`,
          sql`EXISTS (SELECT 1 FROM ${nodes} n
                       WHERE n.owner_user_id = ${nodeAttachments.nodeOwnerUserId}
                         AND n.org_id = ${nodeAttachments.orgId}
                         AND n.enabled AND n.revoked_at IS NULL)`,
        ),
      )
      .orderBy(asc(nodeAttachments.createdAt), asc(nodeAttachments.id)),
  )
  for (const row of rows) {
    const listed = requestersOf(row)
    const allowed =
      row.nodeOwnerUserId === input.requesterUserId ||
      listed.some((q) => q.type === "user" && q.id === input.requesterUserId) ||
      (input.requesterAgentId !== null &&
        listed.some((q) => q.type === "agent" && q.id === input.requesterAgentId))
    if (!allowed) continue
    return {
      orgId: row.orgId,
      attachmentId: row.id,
      nodeOwnerUserId: row.nodeOwnerUserId,
      agentId: row.agentId,
      nodeId: row.nodeId,
      maxJobsPerDay: row.maxJobsPerDay,
      maxTokensPerDay: row.maxTokensPerDay,
    }
  }
  return null
}

/** Null while the attachment's daily caps leave room, else why not, in words. */
export async function attachmentCapRefusal(route: NodeRoute): Promise<string | null> {
  const orgId = route.orgId
  const [usage] = await withPrivilegedDb(orgId, "nodes:cap-usage", (tx) =>
    tx
      .select({
        jobs: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(coalesce(
          (${nodeJobs.usage}->>'totalTokens')::bigint,
          coalesce((${nodeJobs.usage}->>'inputTokens')::bigint, 0)
            + coalesce((${nodeJobs.usage}->>'outputTokens')::bigint, 0)
        )), 0)::bigint`,
      })
      .from(nodeJobs)
      .where(
        and(
          eq(nodeJobs.orgId, orgId),
          eq(nodeJobs.ownerUserId, route.nodeOwnerUserId),
          eq(nodeJobs.agentId, route.agentId),
          eq(nodeJobs.source, "agent_tag"),
          sql`${nodeJobs.createdAt} > now() - interval '24 hours'`,
          sql`${nodeJobs.status} NOT IN ('refused', 'cancelled')`,
        ),
      ),
  )
  if (Number(usage?.jobs ?? 0) >= route.maxJobsPerDay) {
    return `This agent reached its daily limit of jobs (${route.maxJobsPerDay}) on that computer. Try again tomorrow, or ask its owner to raise the limit.`
  }
  if (Number(usage?.tokens ?? 0) >= route.maxTokensPerDay) {
    return `This agent reached its daily limit of tokens (${route.maxTokensPerDay}) on that computer. Try again tomorrow, or ask its owner to raise the limit.`
  }
  return null
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A conversation's node runtime (S24, A24, A50/F9), under /api/nodes, kept
 * server side so the web, the phone and the desktop show and use the same:
 *
 *   GET /threads/:threadId/settings   every agent's node runtime in this thread
 *   PUT /threads/:threadId/settings   { agentId, runsOn, permissionMode?, nodeId?, model? }
 *
 * `runsOn: "cloud"` removes the caller's row (no row = the cloud). Setting a
 * node runtime makes the caller its NODE OWNER: only their own messages go to
 * their node (routing.ts), everyone else's run in the cloud. One owner per
 * (thread, agent): another person's runtime is refused, not overwritten.
 *
 * BYPASS IS UNAVAILABLE WHEN DRIVEN REMOTELY (A24). A node chat is driven from
 * the web or the phone, so nobody is at the machine to see what a bypassed
 * session does: the route refuses it, and the database cannot hold it.
 *
 * THE MODEL IS ONE THE NODE OFFERS. `model` names the Claude model the node
 * chat runs on (null: the agent's preference). It is accepted only when the
 * conversation's node (or, with no node named, one of the caller's enabled
 * nodes) published it in its capabilities, so nothing but a model id the
 * node's own Claude listed ever reaches the node as a model.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import {
  NODE_PERMISSION_MODES,
  nodeCapabilities,
  nodes,
  threadNodeSettings,
  threads,
} from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { isMentionableAgent } from "~/modules/agent/directory/listing"

export const threadNodeSettingsRoutes = new Hono<AppEnv>()

export type ThreadNodeSetting = typeof threadNodeSettings.$inferSelect

const threadParam = z.object({ threadId: z.string().uuid() })

const putSchema = z.object({
  agentId: z.string().uuid(),
  runsOn: z.enum(["cloud", "node", "node_else_cloud"]),
  // `bypass` is parsed so it can be refused in words, never stored.
  permissionMode: z.enum([...NODE_PERMISSION_MODES, "bypass"]).optional(),
  nodeId: z.string().uuid().nullable().optional(),
  // A Claude model id (the column's CHECK says the same); null: the agent's.
  model: z
    .string()
    .regex(/^claude-[a-z0-9][a-z0-9.[\]-]{0,63}$/)
    .nullable()
    .optional(),
})

/** The model ids these nodes published (node_capabilities.models), deduplicated. */
async function offeredModelIds(
  orgId: string,
  ownerUserId: string,
  nodeIds: string[],
): Promise<Set<string>> {
  if (nodeIds.length === 0) return new Set()
  const rows = await withPrivilegedDb(orgId, "nodes:thread-setting-models", (tx) =>
    tx
      .select({ models: nodeCapabilities.models })
      .from(nodeCapabilities)
      .where(
        and(
          eq(nodeCapabilities.orgId, orgId),
          eq(nodeCapabilities.ownerUserId, ownerUserId),
          inArray(nodeCapabilities.nodeId, nodeIds),
        ),
      ),
  )
  const ids = new Set<string>()
  for (const row of rows) {
    for (const m of (row.models ?? []) as Array<{ id?: unknown }>) {
      if (m && typeof m.id === "string") ids.add(m.id)
    }
  }
  return ids
}

/** The node runtime of one agent in one thread, or null (the cloud). */
export async function loadThreadNodeSetting(
  orgId: string,
  threadId: string,
  agentId: string,
): Promise<ThreadNodeSetting | null> {
  const [row] = await withPrivilegedDb(orgId, "nodes:thread-setting", (tx) =>
    tx
      .select()
      .from(threadNodeSettings)
      .where(
        and(
          eq(threadNodeSettings.orgId, orgId),
          eq(threadNodeSettings.threadId, threadId),
          eq(threadNodeSettings.agentId, agentId),
        ),
      )
      .limit(1),
  )
  return row ?? null
}

function settingView(row: ThreadNodeSetting, userId: string) {
  return {
    agentId: row.agentId,
    runsOn: row.runsOn,
    permissionMode: row.permissionMode,
    nodeId: row.targetNodeId,
    model: row.model,
    ownerUserId: row.ownerUserId,
    /** True when the caller is the node owner (their messages go to the node). */
    mine: row.ownerUserId === userId,
    hasSession: row.sdkSessionId !== null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** The thread, as the caller's own RLS sees it: 404 when they are not in it. */
async function requireThread(c: Parameters<typeof withRequestRls>[0], threadId: string) {
  const [t] = await withRequestRls(c, (tx) =>
    tx.select({ id: threads.id }).from(threads).where(eq(threads.id, threadId)).limit(1),
  )
  if (!t) throw new HTTPException(404, { message: "no such conversation" })
}

threadNodeSettingsRoutes.get(
  "/threads/:threadId/settings",
  zValidator("param", threadParam),
  async (c) => {
    const { threadId } = c.req.valid("param")
    await requireThread(c, threadId)
    // Read privileged: the room shows every agent's runtime, whoever set it.
    const rows = await withPrivilegedDb(c.get("orgId"), "nodes:thread-settings-list", (tx) =>
      tx
        .select()
        .from(threadNodeSettings)
        .where(
          and(
            eq(threadNodeSettings.orgId, c.get("orgId")),
            eq(threadNodeSettings.threadId, threadId),
          ),
        )
        .orderBy(asc(threadNodeSettings.createdAt)),
    )
    return success(
      c,
      rows.map((r) => settingView(r, c.get("userId"))),
    )
  },
)

threadNodeSettingsRoutes.put(
  "/threads/:threadId/settings",
  zValidator("param", threadParam),
  zValidator("json", putSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { threadId } = c.req.valid("param")
    const body = c.req.valid("json")
    if (body.permissionMode === "bypass") {
      return c.json(
        {
          error: {
            code: "bypass_unavailable_remote",
            message:
              "Bypass is not available for a chat that runs on your computer: nobody is at the computer to watch what it does. Pick auto, manual, edit or plan.",
          },
        },
        422,
      )
    }
    await requireThread(c, threadId)
    if (!(await isMentionableAgent(orgId, userId, body.agentId))) {
      throw new HTTPException(403, { message: "this agent is not yours to run" })
    }
    const existing = await loadThreadNodeSetting(orgId, threadId, body.agentId)
    if (existing && existing.ownerUserId !== userId) {
      throw new HTTPException(409, {
        message: "this agent already runs on someone else's computer in this conversation",
      })
    }
    const runsOn = body.runsOn
    if (runsOn === "cloud") {
      if (existing) {
        await withRequestRls(c, (tx) =>
          tx.delete(threadNodeSettings).where(eq(threadNodeSettings.id, existing.id)),
        )
      }
      return success(c, { agentId: body.agentId, runsOn: "cloud" })
    }
    // The caller's own nodes, read as the caller: nodes_owner admits exactly them.
    const targetNodeId = body.nodeId !== undefined ? body.nodeId : (existing?.targetNodeId ?? null)
    const owned = await withRequestRls(c, (tx) =>
      tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.orgId, orgId),
            eq(nodes.ownerUserId, userId),
            eq(nodes.enabled, true),
            isNull(nodes.revokedAt),
            ...(targetNodeId ? [eq(nodes.id, targetNodeId)] : []),
          ),
        ),
    )
    if (owned.length === 0) {
      throw new HTTPException(409, { message: "turn this computer into a node first" })
    }
    if (body.model) {
      const offered = await offeredModelIds(
        orgId,
        userId,
        owned.map((n) => n.id),
      )
      if (!offered.has(body.model)) {
        return c.json(
          {
            error: {
              code: "model_not_offered",
              message: "This computer's Claude does not offer that model. Pick one from its list.",
            },
          },
          422,
        )
      }
    }
    const permissionMode = body.permissionMode ?? existing?.permissionMode ?? "manual"
    const model = body.model !== undefined ? body.model : (existing?.model ?? null)
    const [row] = await withRequestRls(c, (tx) =>
      tx
        .insert(threadNodeSettings)
        .values({
          orgId,
          threadId,
          agentId: body.agentId,
          ownerUserId: userId,
          runsOn,
          permissionMode,
          targetNodeId: body.nodeId ?? null,
          model,
        })
        .onConflictDoUpdate({
          target: [threadNodeSettings.threadId, threadNodeSettings.agentId],
          set: {
            runsOn,
            permissionMode,
            model,
            ...(body.nodeId !== undefined ? { targetNodeId: body.nodeId } : {}),
            updatedAt: new Date(),
          },
        })
        .returning(),
    )
    return success(c, settingView(row, userId))
  },
)

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Show full output" (P3, S7, D3, R26, G12): a tool result over 64 KiB is cut
 * in the event log; its whole text stays on the computer (the sidecar's spill
 * file) and comes up only when the owner asks, for 24 hours, never into the
 * log.
 *
 * Owner, mounted at `/api/me/node-sessions`:
 *   POST /:id/full-output              {toolUseId} -> 202 (the node is asked)
 *                                      404 {code: node_offline} when it is offline
 *   GET  /:id/full-output/:toolUseId   200 text/plain | 202 pending |
 *                                      404 node_offline, gone, not_requested
 *
 * Node, mounted at `/api/node/sessions`:
 *   PUT /:id/full-output/:toolUseId    text/plain ≤ 20 MiB (body cap 21 MiB in
 *                                      app.ts), or an empty body with
 *                                      `X-Full-Output: gone`. Only the session's
 *                                      own node (403 otherwise), only once asked
 *                                      (409 otherwise).
 *
 * Kept in Redis (24 h): `nsfo:<sessionId>:<toolUseId>:state` (pending, ready,
 * gone) and `…:data`. When the node answers, the owner's sockets get the
 * ephemeral `kernel:node_session_full_output` ping (owner only, websocket.ts);
 * clients also poll the GET.
 */
import { TOOL_USE_ID_RE } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { nodeSessions } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { NODE_CREDENTIAL_HEADER, requireNodeCredential } from "~/modules/nodes/credentials"
import { liveNodeTargets } from "~/modules/nodes/jobs"
import { liveDesktopConnections } from "~/modules/nodes/presence"
import { sendConnectionFrame } from "./commands"
import { sessionForNode } from "./store"

const log = rootLogger.child({ module: "node-session-full-output" })

export const FULL_OUTPUT_MAX_BYTES = 20 * 1024 * 1024
export const FULL_OUTPUT_TTL_SECONDS = 24 * 60 * 60

type FullOutputState = "pending" | "ready" | "gone"

const stateKey = (sessionId: string, toolUseId: string) => `nsfo:${sessionId}:${toolUseId}:state`
const dataKey = (sessionId: string, toolUseId: string) => `nsfo:${sessionId}:${toolUseId}:data`

const idParam = z.object({ id: z.string().uuid() })
const toolUseId = z.string().max(200).regex(TOOL_USE_ID_RE)
const toolParam = z.object({ id: z.string().uuid(), toolUseId })
const askSchema = z.object({ toolUseId }).strict()

const err = (code: string, message: string) => ({ error: { code, message } })

// ── owner ───────────────────────────────────────────────────────────────────

export const meNodeSessionFullOutputRoutes = new Hono<AppEnv>()

/** The owner's session (through their own RLS): its node, or null. */
async function ownSession(c: Parameters<typeof withRequestRls>[0], id: string) {
  const [row] = await withRequestRls(c, (tx) =>
    tx
      .select({ id: nodeSessions.id, nodeId: nodeSessions.nodeId })
      .from(nodeSessions)
      .where(and(eq(nodeSessions.id, id), eq(nodeSessions.orgId, c.get("orgId"))))
      .limit(1),
  )
  return row ?? null
}

async function nodeOnline(orgId: string, userId: string, nodeId: string | null): Promise<boolean> {
  if (!nodeId) return false
  return (await liveDesktopConnections(orgId, userId)).has(nodeId)
}

meNodeSessionFullOutputRoutes.post(
  "/:id/full-output",
  async (c, next) => {
    if (c.req.header(NODE_CREDENTIAL_HEADER) !== undefined) {
      return c.json(err("node_credential_refused", "The full output is asked for in the app."), 403)
    }
    await next()
  },
  zValidator("param", idParam),
  zValidator("json", askSchema),
  async (c) => {
    const id = c.req.valid("param").id
    const tool = c.req.valid("json").toolUseId
    const session = await ownSession(c, id)
    if (!session) return c.json(err("not_found", "No such session."), 404)
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    if (!(await nodeOnline(orgId, userId, session.nodeId))) {
      return c.json(err("node_offline", "The full output is on a computer that is offline."), 404)
    }
    const current = (await redis.get(stateKey(id, tool))) as FullOutputState | null
    if (current !== "ready") {
      await redis.set(stateKey(id, tool), "pending", "EX", FULL_OUTPUT_TTL_SECONDS)
      const targets = await liveNodeTargets(orgId, userId, session.nodeId)
      await sendConnectionFrame(targets, {
        type: "node_session_full_output",
        sessionId: id,
        toolUseId: tool,
      })
    }
    return success(c, { state: current === "ready" ? "ready" : "pending" }, undefined, 202)
  },
)

meNodeSessionFullOutputRoutes.get(
  "/:id/full-output/:toolUseId",
  zValidator("param", toolParam),
  async (c) => {
    const { id, toolUseId: tool } = c.req.valid("param")
    const session = await ownSession(c, id)
    if (!session) return c.json(err("not_found", "No such session."), 404)
    const state = (await redis.get(stateKey(id, tool))) as FullOutputState | null
    if (state === "ready") {
      const text = await redis.get(dataKey(id, tool))
      if (text !== null) {
        return c.body(text, 200, { "Content-Type": "text/plain; charset=utf-8" })
      }
    }
    if (state === "gone" || state === "ready") {
      return c.json(err("gone", "The full output is no longer on the computer."), 404)
    }
    if (state === "pending") {
      if (!(await nodeOnline(c.get("orgId"), c.get("userId"), session.nodeId))) {
        return c.json(err("node_offline", "The full output is on a computer that is offline."), 404)
      }
      return success(c, { state: "pending" }, undefined, 202)
    }
    return c.json(err("not_requested", "Ask for the full output first."), 404)
  },
)

// ── node ────────────────────────────────────────────────────────────────────

export const nodeSessionFullOutputRoutes = new Hono<AppEnv>()

nodeSessionFullOutputRoutes.put(
  "/:id/full-output/:toolUseId",
  zValidator("param", toolParam),
  async (c) => {
    const node = await requireNodeCredential(c)
    const { id, toolUseId: tool } = c.req.valid("param")
    const session = await sessionForNode(node, id)
    if (!session) return c.json(err("not_found", "No such session."), 404)
    if (session === "not_your_node") {
      return c.json(err("not_your_node", "This session runs on another node."), 403)
    }
    if ((await redis.get(stateKey(id, tool))) !== "pending") {
      return c.json(err("not_requested", "Nobody asked for this output."), 409)
    }
    const gone = c.req.header("X-Full-Output")?.toLowerCase() === "gone"
    let state: FullOutputState = "gone"
    if (!gone) {
      const text = await c.req.text()
      if (new TextEncoder().encode(text).length > FULL_OUTPUT_MAX_BYTES) {
        return c.json(err("too_large", "A full output is at most 20 MiB."), 413)
      }
      await redis.set(dataKey(id, tool), text, "EX", FULL_OUTPUT_TTL_SECONDS)
      state = "ready"
    }
    await redis.set(stateKey(id, tool), state, "EX", FULL_OUTPUT_TTL_SECONDS)
    try {
      await broadcastEphemeral({
        app: "kernel",
        entity: "node_session_full_output",
        action: "update",
        entityId: `${id}:${tool}`,
        orgId: session.orgId,
        data: { ownerUserId: session.ownerUserId, sessionId: id, toolUseId: tool, state },
      })
    } catch (e) {
      log.warn({ err: e, sessionId: id }, "full-output ping failed; the client polls")
    }
    return success(c, { state })
  },
)

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Permission prompts of a remotely driven node chat (S24, A24, A50/F9).
 *
 * On a local desktop session a permission prompt is a native dialog in front
 * of the person. A node chat is driven from the web or the phone, so the node
 * relays each prompt here and the owner answers it as an in-app approval card
 * (an `agent_notification` with Allow / Deny actions). Nobody answering for 10
 * minutes is a DENY: a prompt never waits for ever, and never defaults to yes.
 *
 *   POST /jobs/:id/permission-requests       node (credential + lease generation):
 *                                            { leaseGeneration, toolName, summary } -> { id, status, expiresAt }
 *   GET  /permission-requests/:id            owner (the node polls it): { status }
 *   POST /permission-requests/:id/decision   owner: { allow }
 *
 * Only an INTERACTIVE job prompts: an unattended job runs in `dontAsk` mode
 * under its profile (A15), and a prompt from one is refused.
 */
import { redactSecrets } from "@liaison/shared"
import { and, eq, gt, lte, sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agents, nodeJobs, nodePermissionPrompts } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { broadcastReadState } from "~/modules/threads/read-state-broadcast"
import { requireNodeCredential } from "./credentials"
import { heldBy } from "./jobs"
import { nodeTurnProgress } from "./turn-live"

const log = rootLogger.child({ module: "node-permission-prompts" })

/** How long a relayed prompt waits for its owner before it is denied (A24). */
export const NODE_PROMPT_TIMEOUT_SECONDS = 10 * 60

export const nodePermissionRoutes = new Hono<AppEnv>()

const idParam = z.object({ id: z.string().uuid() })

const requestSchema = z.object({
  leaseGeneration: z.number().int().positive(),
  toolName: z.string().min(1).max(200),
  summary: z.string().max(2000).default(""),
  /**
   * The call's whole input as the owner must see it to decide (a command, or
   * the tool input as pretty JSON, a file's content included). Sent by
   * desktops that no longer ask on the computer itself; older ones send only
   * `summary` and still confirm in their own dialog.
   */
  detail: z.string().max(200_000).optional(),
})

/** The longest input the chat card shows whole, and so the longest one it may approve (the stored summary holds 2000). */
export const NODE_PROMPT_DETAIL_MAX = 2000

/**
 * Why a call can never be approved from the chat: the card would not show the
 * owner exactly what runs. A secret in the input (the card shows it redacted)
 * or an input longer than the card shows whole is denied at once.
 */
export function unapprovableReason(detail: string | undefined): "secret" | "too_long" | null {
  if (detail === undefined) return null
  if (detail.length > NODE_PROMPT_DETAIL_MAX) return "too_long"
  return redactSecrets(detail) === detail ? null : "secret"
}

const decisionSchema = z.object({ allow: z.boolean() })

type PromptRow = typeof nodePermissionPrompts.$inferSelect

function promptView(row: PromptRow) {
  return {
    id: row.id,
    jobId: row.jobId,
    toolName: row.toolName,
    summary: row.summary,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  }
}

nodePermissionRoutes.post(
  "/jobs/:id/permission-requests",
  zValidator("param", idParam),
  zValidator("json", requestSchema),
  async (c) => {
    const node = await requireNodeCredential(c)
    const jobId = c.req.valid("param").id
    const body = c.req.valid("json")
    const [job] = await withPrivilegedDb(node.orgId, "nodes:prompt-job", (tx) =>
      tx
        .select()
        .from(nodeJobs)
        .where(heldBy(node, jobId, body.leaseGeneration))
        .limit(1),
    )
    if (!job) {
      return c.json(
        { error: { code: "stale_lease", message: "this lease is no longer yours: stop the run" } },
        409,
      )
    }
    if (job.kind !== "interactive") {
      return c.json(
        {
          error: {
            code: "unattended_never_prompts",
            message: "an unattended job runs under its profile and never asks: deny it",
          },
        },
        409,
      )
    }
    const toolName = redactSecrets(body.toolName)
    const refused = unapprovableReason(body.detail)
    // What the card shows: the whole input when the node sent it (redacted, and
    // cut, only for a call that is refused below and never approvable).
    const shown = body.detail === undefined ? body.summary : body.detail
    const summary = redactSecrets(shown).slice(0, NODE_PROMPT_DETAIL_MAX)
    if (refused) {
      // Not approvable from the chat: denied now, and the chat's live turn says
      // why, with what was asked (redacted). No card: nothing to decide.
      const [row] = await withPrivilegedDb(node.orgId, "nodes:prompt-refuse", (tx) =>
        tx
          .insert(nodePermissionPrompts)
          .values({
            orgId: job.orgId,
            jobId: job.id,
            ownerUserId: job.ownerUserId,
            toolName,
            summary,
            status: "denied",
            decidedAt: new Date(),
            expiresAt: sql`now()`,
          })
          .returning(),
      )
      nodeTurnProgress(job, [
        {
          type: "tool_call",
          id: `refused-${row.id}`,
          toolName:
            refused === "secret" ? "permission_denied_secret" : "permission_denied_too_long",
          summary: `${toolName}: ${summary}`.slice(0, 500),
        },
        { type: "tool_result", id: `refused-${row.id}`, isError: true },
      ])
      return success(c, { ...promptView(row), refused }, undefined, 201)
    }
    const row = await withPrivilegedDb(node.orgId, "nodes:prompt-create", async (tx) => {
      const [created] = await tx
        .insert(nodePermissionPrompts)
        .values({
          orgId: job.orgId,
          jobId: job.id,
          ownerUserId: job.ownerUserId,
          toolName,
          summary,
          expiresAt: sql`now() + make_interval(secs => ${NODE_PROMPT_TIMEOUT_SECONDS})`,
        })
        .returning()
      const [agent] = await tx
        .select({ name: agents.displayName })
        .from(agents)
        .where(and(eq(agents.id, job.agentId), eq(agents.orgId, job.orgId)))
        .limit(1)
      const agentName = agent?.name ?? null
      // The approval card: an attention item of the `agent` group, so it
      // reaches the owner wherever they are (in app, desktop, phone). The
      // card shows what is asked, by which agent, from which node (S24).
      await tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: crypto.randomUUID(),
        data: {
          summary: `${agentName ?? "Your agent"} on ${node.name || "your computer"} asks to use ${toolName}${summary ? `: ${summary}` : ""}. Allow or deny within 10 minutes.`,
          urgency: 80,
          targetUserIds: [job.ownerUserId],
          link: { tabType: "thread", entityId: job.threadId },
          nodeJobId: job.id,
          nodePermissionPromptId: created.id,
          nodePermission: {
            promptId: created.id,
            jobId: job.id,
            nodeName: node.name || null,
            agentName,
            toolName,
            summary,
            expiresAt: created.expiresAt.toISOString(),
          },
          actions: ["allow", "deny"],
        },
        actorId: job.ownerUserId,
        actorType: "system",
        agentId: job.agentId,
        orgId: job.orgId,
        timestamp: new Date().toISOString(),
      })
      return created
    })
    return success(c, promptView(row), undefined, 201)
  },
)

const K = () => sql.raw(schemaRef("kernel"))

/**
 * A prompt that is no longer pending (allowed, denied, expired, or its job
 * ended) leaves Home at once: its owner's attention row is read here, on the
 * server, whoever decided (the chat card, the node's deadline, the job's end),
 * and the owner's devices drop it (the read-state frame). By `promptId`, or
 * every row of a job's prompts (`jobId`).
 */
export async function resolvePromptAttention(
  orgId: string,
  ownerUserId: string,
  by: { promptId: string } | { jobId: string },
): Promise<void> {
  const touched = await readPromptRows(orgId, ownerUserId, by)
  // The row is written by the attention translator from the outbox, so a
  // prompt decided within moments of being asked may not have one yet: when
  // nothing was found, look once more a little later.
  if (touched === 0) {
    const retry = setTimeout(() => {
      void readPromptRows(orgId, ownerUserId, by)
    }, PROMPT_ROW_RETRY_MS)
    retry.unref?.()
  }
}

/** How long after a decision a row the outbox had not yet written is looked for again. */
export const PROMPT_ROW_RETRY_MS = 5_000

async function readPromptRows(
  orgId: string,
  ownerUserId: string,
  by: { promptId: string } | { jobId: string },
): Promise<number> {
  try {
    const rows = await withPrivilegedDb(orgId, "nodes:prompt-attention-read", (tx) =>
      tx.execute(sql`
        UPDATE ${K()}.attention_events
           SET read_at = now()
         WHERE org_id = ${orgId}
           AND user_id = ${ownerUserId}
           AND app = 'kernel'
           AND entity_type = 'agent_notification'
           AND read_at IS NULL
           AND ${
             "promptId" in by
               ? sql`metadata->>'nodePermissionPromptId' = ${by.promptId}`
               : sql`metadata->'nodePermission'->>'jobId' = ${by.jobId}`
           }
        RETURNING entity_id`),
    )
    const read = extractRows<{ entity_id: string }>(rows)
    for (const row of read) {
      await broadcastReadState(orgId, ownerUserId, {
        kind: "attention",
        app: "kernel",
        entityType: "agent_notification",
        entityId: row.entity_id,
      })
    }
    return read.length
  } catch (err) {
    log.error({ err, orgId, ...by }, "resolving a node prompt's attention row failed")
    return -1
  }
}

/**
 * A job ended (answered, failed, stopped, lost): nothing can answer its open
 * prompts any more. They are denied, and their rows leave Home.
 */
export async function settleJobPrompts(job: {
  id: string
  orgId: string
  ownerUserId: string
  kind: string
}): Promise<void> {
  if (job.kind !== "interactive") return
  try {
    await withPrivilegedDb(job.orgId, "nodes:prompt-settle-job", (tx) =>
      tx
        .update(nodePermissionPrompts)
        .set({ status: "denied", decidedAt: new Date() })
        .where(
          and(
            eq(nodePermissionPrompts.jobId, job.id),
            eq(nodePermissionPrompts.orgId, job.orgId),
            eq(nodePermissionPrompts.status, "pending"),
          ),
        ),
    )
  } catch (err) {
    log.error({ err, jobId: job.id }, "settling a node job's open prompts failed")
  }
  await resolvePromptAttention(job.orgId, job.ownerUserId, { jobId: job.id })
}

/** A pending prompt past its deadline is denied, here, on its first read. */
async function expireIfDue(c: Parameters<typeof withRequestRls>[0], id: string): Promise<void> {
  await withRequestRls(c, (tx) =>
    tx
      .update(nodePermissionPrompts)
      .set({ status: "denied", decidedAt: new Date() })
      .where(
        and(
          eq(nodePermissionPrompts.id, id),
          eq(nodePermissionPrompts.status, "pending"),
          lte(nodePermissionPrompts.expiresAt, sql`now()`),
        ),
      ),
  )
}

nodePermissionRoutes.get("/permission-requests/:id", zValidator("param", idParam), async (c) => {
  const id = c.req.valid("param").id
  await expireIfDue(c, id)
  const [row] = await withRequestRls(c, (tx) =>
    tx
      .select()
      .from(nodePermissionPrompts)
      .where(
        and(
          eq(nodePermissionPrompts.id, id),
          eq(nodePermissionPrompts.ownerUserId, c.get("userId")),
        ),
      )
      .limit(1),
  )
  if (!row) throw new HTTPException(404, { message: "no such permission request" })
  // The node polls this: an expired (or decided) prompt leaves Home now.
  if (row.status !== "pending") {
    await resolvePromptAttention(c.get("orgId"), row.ownerUserId, { promptId: row.id })
  }
  return success(c, promptView(row))
})

nodePermissionRoutes.post(
  "/permission-requests/:id/decision",
  zValidator("param", idParam),
  zValidator("json", decisionSchema),
  async (c) => {
    const id = c.req.valid("param").id
    const userId = c.get("userId")
    await expireIfDue(c, id)
    const [row] = await withRequestRls(c, (tx) =>
      tx
        .update(nodePermissionPrompts)
        .set({ status: c.req.valid("json").allow ? "allowed" : "denied", decidedAt: new Date() })
        .where(
          and(
            eq(nodePermissionPrompts.id, id),
            eq(nodePermissionPrompts.ownerUserId, userId),
            eq(nodePermissionPrompts.status, "pending"),
            gt(nodePermissionPrompts.expiresAt, sql`now()`),
          ),
        )
        .returning(),
    )
    if (row) {
      await resolvePromptAttention(c.get("orgId"), userId, { promptId: id })
      return success(c, promptView(row))
    }
    const [current] = await withRequestRls(c, (tx) =>
      tx
        .select({ status: nodePermissionPrompts.status })
        .from(nodePermissionPrompts)
        .where(and(eq(nodePermissionPrompts.id, id), eq(nodePermissionPrompts.ownerUserId, userId)))
        .limit(1),
    )
    if (!current) throw new HTTPException(404, { message: "no such permission request" })
    await resolvePromptAttention(c.get("orgId"), userId, { promptId: id })
    log.info({ id, status: current.status }, "late permission decision refused")
    throw new HTTPException(409, { message: `this request was already ${current.status}` })
  },
)

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The node's event batches (C4, S6, S7, D33), mounted at `/api/node/sessions`:
 *
 *   POST /:id/events   { jobId, leaseGeneration, batchNo, events } -> { lastSeq }
 *   GET  /commands?unacked=1   this node's unacked commands for its current runs (P3)
 *
 * The session and the node credential both identify the caller. The body cap
 * for this route is 2 MiB in app.ts (a 1 MiB batch plus its envelope); the
 * protocol's own limits are answered here:
 *   - more than 256 events, or a batch over 1 MiB by `batchBytes` (the node's
 *     own measure): 413 `batch_too_large`;
 *   - one event over 256 KiB by `eventBytes`: 413 `event_too_large` with its index.
 * Every event is then capped again server side (`capEvent`: a field over
 * 64 KiB is cut and marked `truncated` with its `fullBytes`), so the cap is
 * enforced, never trusted.
 *
 * The store fences the write (D33): the session's node, owner and org, and
 * the session's current run (job, lease holder, lease generation); the server
 * numbers the events. Outcomes: 200 `{lastSeq}` (appended, or the same batch
 * re-sent), 409 `gap` with `expectedBatchNo`, 409 `stale`, 403 `not_your_node`,
 * 409 `conflict` (the same batch number with another body: terminal, the run
 * is failed and logged).
 */
import { createHash } from "node:crypto"
import {
  batchBytes,
  capEvent,
  eventBytes,
  NODE_EVENT_LIMITS,
  type NodeCommandPullResponse,
  type NodeSessionEventIn,
  nodeSessionBatchSchema,
} from "@liaison/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { rootLogger } from "~/lib/logger"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireNodeCredential } from "~/modules/nodes/credentials"
import { failNodeJob } from "~/modules/nodes/jobs"
import { unpauseHeldSession } from "./lifecycle"
import { fanOut, ingestBatch, nodeUnackedCommands } from "./store"
import { fireSessionStatus, fireSessionWaiting } from "./waiting-hook"

const log = rootLogger.child({ module: "node-session-ingest" })

export const nodeSessionRoutes = new Hono<AppEnv>()

const idParam = z.object({ id: z.string().uuid() })

const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message, ...extra },
})

/** JSON with object keys sorted at every depth: one text per batch content. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

// Declared before the `/:id/…` routes. The commands of the sessions whose
// current run this node holds, in (session, seq) order, at most 500 (T07).
nodeSessionRoutes.get(
  "/commands",
  zValidator("query", z.object({ unacked: z.literal("1").optional() })),
  async (c) => {
    const node = await requireNodeCredential(c)
    // Walk D1: the node parses this with parseNodeCommandPull (shared).
    const body: NodeCommandPullResponse = { commands: await nodeUnackedCommands(node) }
    return success(c, body)
  },
)

nodeSessionRoutes.post("/:id/events", zValidator("param", idParam), async (c) => {
  const node = await requireNodeCredential(c)
  const sessionId = c.req.valid("param").id
  const raw = (await c.req.json().catch(() => null)) as { events?: unknown } | null
  if (Array.isArray(raw?.events) && raw.events.length > NODE_EVENT_LIMITS.batchEvents) {
    return c.json(
      err("batch_too_large", `A batch holds at most ${NODE_EVENT_LIMITS.batchEvents} events.`),
      413,
    )
  }
  const parsed = nodeSessionBatchSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return c.json(
      err(
        "VALIDATION_ERROR",
        issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid batch",
      ),
      400,
    )
  }
  const batch = parsed.data
  const events = batch.events as NodeSessionEventIn[]
  if (batchBytes(events) > NODE_EVENT_LIMITS.batchBytes) {
    return c.json(err("batch_too_large", "A batch is at most 1 MiB."), 413)
  }
  const tooBig = events.findIndex((e) => eventBytes(e) > NODE_EVENT_LIMITS.eventBytes)
  if (tooBig >= 0) {
    return c.json(err("event_too_large", "An event is at most 256 KiB.", { index: tooBig }), 413)
  }

  // The body as received decides a re-send (keys the schema strips included,
  // so two bodies that differ only there are a conflict, not a replay); the
  // stored events are capped.
  const rawBodyHash = createHash("sha256").update(canonicalJson(raw)).digest("hex")
  const capped = events.map(capEvent)

  const outcome = await ingestBatch(
    node,
    sessionId,
    {
      jobId: batch.jobId,
      leaseGeneration: batch.leaseGeneration,
      batchNo: batch.batchNo,
      events: capped,
    },
    rawBodyHash,
  )
  switch (outcome.kind) {
    case "appended":
      await fanOut(outcome.row, outcome.events)
      // P3-fix M5: the run is heard from again; a silent pause ends.
      if (outcome.row.status === "paused") {
        await unpauseHeldSession(node, batch.jobId, batch.leaseGeneration)
      }
      // P4's push hook: after the commit, never awaited by the node's request.
      if (outcome.becameWaiting) void fireSessionWaiting(outcome.row, outcome.becameWaiting)
      // The status hook: a batch moves a session only running ⇄ waiting.
      if (outcome.statusFrom) {
        void fireSessionStatus(outcome.row, {
          from: outcome.statusFrom,
          to: outcome.row.status,
          cause: "node",
          ...(outcome.becameWaiting ? { becameWaiting: outcome.becameWaiting } : {}),
        })
      }
      return success(c, { lastSeq: outcome.lastSeq })
    case "replayed":
      return success(c, { lastSeq: outcome.lastSeq })
    case "gap":
      return c.json(
        err("gap", `Expected batch ${outcome.expectedBatchNo}.`, {
          expectedBatchNo: outcome.expectedBatchNo,
        }),
        409,
      )
    case "conflict": {
      const message = `ingest conflict: batch ${batch.batchNo} re-sent with another body`
      log.error(
        { sessionId, jobId: batch.jobId, nodeId: node.id, batchNo: batch.batchNo },
        "node session ingest conflict: the run is failed",
      )
      await failNodeJob(node, batch.jobId, batch.leaseGeneration, {
        code: "error",
        error: message,
      })
      return c.json(err("conflict", message), 409)
    }
    case "stale":
      return c.json(err("stale", "This run is no longer the session's current run: stop it."), 409)
    case "not_your_node":
      return c.json(err("not_your_node", "This session runs on another node."), 403)
    case "not_found":
      return c.json(err("not_found", "No such session."), 404)
  }
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cell test seams (P2 T13/T15), mounted only when `qaSeedRoutesEnabled`:
// - a pending mailbox request registered in THIS process, as a turn would, so a
//   cell scenario can answer it through another process and read how it settled;
// - the supersede wait run in this process for a turn running in another;
// - a sub-run running in this process, and its cancel issued from another.
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { agentRuns, threads as kernelThreads } from "~/db/schema/kernel"
import { env, qaSeedRoutesEnabled } from "~/lib/env"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { authMiddleware } from "~/middleware/auth"
import {
  type MailboxRequestOutcome,
  mintMailboxRequestId,
  registerMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import {
  scriptedModelEnabled,
  setScriptedTurn,
} from "~/modules/agent/providers/scripted-model-provider"
import { waitForEarlierLiveTurn } from "~/modules/agent/runtime/superseded-turn"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { cancelSubRunTree, runSubRun } from "~/modules/agent/subruns/subrun-worker"

export const liveStateTestRoutes = new Hono<AppEnv>()

liveStateTestRoutes.use("*", async (_c, next) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  await next()
})
liveStateTestRoutes.use("*", authMiddleware(env.JWT_SECRET))

/** How each request registered here settled (null while pending). */
const outcomes = new Map<string, MailboxRequestOutcome | null>()
const WAIT_MS = 60_000

/** POST /api/_test/live/mailbox-request: a pending `mail.read` for the caller. */
liveStateTestRoutes.post("/mailbox-request", (c) => {
  const requestId = mintMailboxRequestId()
  const turnNonce = crypto.randomUUID()
  const pending = registerMailboxRequest({
    requestId,
    userId: c.get("userId"),
    orgId: c.get("orgId"),
    turnNonce,
    kind: "mail.read",
    messageIds: ["m1"],
  })
  outcomes.set(requestId, null)
  const timer = setTimeout(() => pending.cancel("timeout"), WAIT_MS)
  void pending.promise.then((outcome) => {
    clearTimeout(timer)
    outcomes.set(requestId, outcome)
  })
  return success(c, { requestId, turnNonce })
})

/** GET /api/_test/live/mailbox-request/:id: `{ settled, outcome }`. */
liveStateTestRoutes.get("/mailbox-request/:id", (c) => {
  const id = c.req.param("id")
  if (!outcomes.has(id)) throw new HTTPException(404, { message: "NO_SUCH_REQUEST" })
  const outcome = outcomes.get(id) ?? null
  return success(c, { settled: outcome !== null, outcome })
})

// ── S7 (A31): the demo's supersede wait and a sub-run's cancel, across processes ──

const supersedeWaitSchema = z.object({
  threadId: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
})

/**
 * POST /api/_test/live/supersede-wait: a newer request of the caller in
 * `threadId` waits HERE for the caller's earlier live turn to the same agent,
 * wherever that turn runs (waitForEarlierLiveTurn, the visitor turn's wait).
 */
liveStateTestRoutes.post("/supersede-wait", zValidator("json", supersedeWaitSchema), async (c) => {
  const { threadId, agentId, timeoutMs } = c.req.valid("json")
  const started = Date.now()
  const outcome = await waitForEarlierLiveTurn({
    threadId,
    messageId: crypto.randomUUID(),
    senderId: c.get("userId"),
    agentId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
  return success(c, { outcome, waitedMs: Date.now() - started, endedAt: Date.now() })
})

const subRunSchema = z.object({
  /** The sub-run's model steps (the scripted provider, this process's no-thread key). */
  steps: z
    .array(
      z.object({ text: z.string().optional(), delayMs: z.number().min(0).max(5000).optional() }),
    )
    .min(1)
    .max(10),
})

/**
 * POST /api/_test/live/sub-run: a sub-run of the caller that RUNS IN THIS
 * PROCESS (runSubRun, as the job handler would), on a scripted model. The run
 * row, its hidden thread and its sub-agent role are written as spawnAgent
 * writes them; the model calls replay `steps`.
 */
liveStateTestRoutes.post("/sub-run", zValidator("json", subRunSchema), async (c) => {
  const { steps } = c.req.valid("json")
  if (!scriptedModelEnabled()) {
    throw new HTTPException(409, { message: "SCRIPTED_PROVIDER_OFF" })
  }
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const scopes = c.get("scopes") as unknown as string[]
  const agentType = `cell-${crypto.randomUUID().slice(0, 8)}`
  await createSubAgentDefinition({
    orgId,
    creatorScopes: scopes,
    agentType,
    whenToUse: "cell scenario: a sub-run cancelled from another process",
    scopeCeiling: [],
    toolAllowlist: [],
    systemPrompt: "Work slowly.",
  })
  const runId = crypto.randomUUID()
  const hiddenThreadId = await withPrivilegedDb(orgId, "test-cell-subrun", async (tx) => {
    const [hidden] = await tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `subrun-${crypto.randomUUID().slice(0, 12)}`,
        title: `${agentType}: cell`,
        type: "subrun",
        hiddenFromList: true,
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id })
    if (!hidden) throw new Error("hidden thread insert returned nothing")
    await tx.insert(agentRuns).values({
      id: runId,
      orgId,
      rootRunId: runId,
      threadId: hidden.id,
      subagentType: agentType,
      actor: { actorType: "user", userId, orgId, scopes, dimensionGrants: {} },
      effectiveScopes: [],
      status: "queued",
      prompt: "Work slowly.",
      maxSteps: 10,
      timeoutMs: 60_000,
      schemaRetryBudget: 0,
      nestingDepth: 1,
    })
    return hidden.id
  })
  // A sub-run's model is resolved without a thread: the no-thread key.
  await setScriptedTurn(null, steps)
  void runSubRun(runId, orgId, []).catch(() => {})
  return success(c, { runId, hiddenThreadId })
})

/** POST /api/_test/live/sub-run/:id/cancel: the caller stops it, from this process. */
liveStateTestRoutes.post("/sub-run/:id/cancel", async (c) => {
  const cancelled = await cancelSubRunTree(c.req.param("id"), c.get("orgId"))
  return success(c, { cancelled })
})

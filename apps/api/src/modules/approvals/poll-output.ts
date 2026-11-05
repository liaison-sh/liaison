// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { appsLogger as log } from "~/lib/logger"
import { cascadeDeferredDependents } from "~/modules/approvals/cascade"
import { failBundle } from "~/modules/approvals/cascade-fail"
import { loadRequesterContext } from "~/modules/approvals/event-data"
import { toolRegistry } from "~/modules/apps/app-registries"

const K = drizzleSql.raw(schemaRef("kernel"))

/** Backoff before each poll attempt, in ms. attempt N waits POLL_SCHEDULE[N].
 *  One tunable constant — extended tail so a slow-but-normal output (e.g. a
 *  carrier label) is not misclassified as a failure. */
export const POLL_SCHEDULE = [0, 15_000, 60_000, 300_000, 900_000]

export async function enqueuePoll(
  orgId: string,
  approvalRequestId: string,
  toolName: string,
  attempt: number,
): Promise<void> {
  await enqueueAppJob(
    "kernel",
    "approval-poll-output",
    { orgId, approvalRequestId, toolName, attempt },
    { jobId: `approval-poll:${approvalRequestId}:${attempt}`, delay: POLL_SCHEDULE[attempt] ?? 0 },
  )
}

/** Terminalize the execution off `awaiting_output` when a poll path fails, so a
 *  late provider webhook cannot pass `resolveDeferredOutput`'s dedup gate
 *  (`WHERE status = 'awaiting_output'`) and re-cascade an already-failed bundle. */
async function markExecutionFailed(
  orgId: string,
  approvalRequestId: string,
  toolName: string,
): Promise<void> {
  await withPrivilegedDb(orgId, "poll-fail-terminalize", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${K}.approved_handler_executions
      SET status = 'failed_no_effect', finished_at = now()
      WHERE approval_request_id = ${approvalRequestId} AND tool_name = ${toolName}
        AND status = 'awaiting_output'`),
  )
}

/** Load the bundle requester's effective UserContext (the context the cascade
 *  threads through) and the human who DECIDED the head. The resumed steps must
 *  name that same human as their decider: their authority is what the remaining
 *  steps execute with, and they, not the requester, approved the sequence. */
async function loadDeciderContext(orgId: string, approvalRequestId: string) {
  const [row] = extractRows<{ requested_by: string; decided_by: string | null }>(
    await withPrivilegedDb(orgId, "poll-load-requester", (tx) =>
      tx.execute(
        drizzleSql`SELECT requested_by, decided_by FROM ${K}.approval_requests WHERE id = ${approvalRequestId}`,
      ),
    ),
  )
  const requester = await loadRequesterContext(orgId, row.requested_by, "poll-requester-perms")
  return { requester, deciderId: row.decided_by ?? row.requested_by }
}

/** Writes the final result, flips the execution to succeeded, then resumes the
 *  cascade. Also callable directly by a provider webhook.
 *
 *  Dedup gate: the `WHERE status = 'awaiting_output'` UPDATE is the single point
 *  that decides who proceeds. When a provider webhook and the poll job both
 *  resolve the same step, only the first caller flips the row; the second sees
 *  0 rows updated and MUST NOT cascade. */
export async function resolveDeferredOutput(
  orgId: string,
  approvalRequestId: string,
  toolName: string,
  result: Record<string, unknown>,
): Promise<void> {
  const flipped = await withPrivilegedDb(orgId, "approval-resolve-output", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${K}.approved_handler_executions
        SET status = 'succeeded', result = ${JSON.stringify(result)}::jsonb, finished_at = now()
        WHERE approval_request_id = ${approvalRequestId} AND tool_name = ${toolName}
          AND status = 'awaiting_output'
        RETURNING id`),
    ),
  )
  if (flipped.length === 0) return // another resolver already won — do not cascade
  const { requester, deciderId } = await loadDeciderContext(orgId, approvalRequestId)
  await cascadeDeferredDependents({
    orgId,
    approvedId: approvalRequestId,
    decider: requester,
    deciderId,
  })
}

export async function runApprovalOutputPoll(payload: {
  orgId: string
  approvalRequestId: string
  toolName: string
  attempt: number
}): Promise<void> {
  const { orgId, approvalRequestId, toolName, attempt } = payload
  const [appName, short] = toolName.split(":")
  const tool = toolRegistry.get([orgId, appName, short])
  if (!tool?.poll) {
    await markExecutionFailed(orgId, approvalRequestId, toolName)
    await failBundle(orgId, approvalRequestId, `poll handler missing for ${toolName}`)
    return
  }

  const [exec] = extractRows<{ external_ref: unknown; status: string }>(
    await withPrivilegedDb(orgId, "poll-load", (tx) =>
      tx.execute(drizzleSql`
        SELECT external_ref, status FROM ${K}.approved_handler_executions
        WHERE approval_request_id = ${approvalRequestId} AND tool_name = ${toolName}`),
    ),
  )
  if (!exec || exec.status !== "awaiting_output") return // already resolved / failed

  let res: { ready: true; result: Record<string, unknown> } | { ready: false }
  try {
    res = await withPrivilegedDb(orgId, "poll-call", (tx) =>
      // biome-ignore lint/style/noNonNullAssertion: guarded above
      tool.poll!({ orgId, userId: "system", tx }, exec.external_ref),
    )
  } catch (err) {
    await markExecutionFailed(orgId, approvalRequestId, toolName)
    await failBundle(orgId, approvalRequestId, `poll error: ${(err as Error).message}`)
    return
  }

  if (res.ready) {
    await resolveDeferredOutput(orgId, approvalRequestId, toolName, res.result)
    return
  }

  const next = attempt + 1
  if (next >= POLL_SCHEDULE.length) {
    log.warn({ approvalRequestId, toolName }, "Poll deadline exceeded — failing bundle")
    await markExecutionFailed(orgId, approvalRequestId, toolName)
    await failBundle(
      orgId,
      approvalRequestId,
      `output not ready after ${POLL_SCHEDULE.length} polls`,
    )
    return
  }
  await enqueuePoll(orgId, approvalRequestId, toolName, next)
}

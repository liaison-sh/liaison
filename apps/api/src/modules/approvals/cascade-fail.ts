// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { enqueueRoutineDecisionTurn } from "~/modules/approvals/approval-result-turn"
import { postDualSystemMessages } from "~/modules/approvals/event-data"
import { bundleFailureRequiredScopes } from "~/modules/approvals/result-notice"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

const K = drizzleSql.raw(schemaRef("kernel"))

/** Cap on a single step's serialized result inside the re-invocation prompt —
 *  a step output may be large (e.g. a label PDF blob) and must not bloat the
 *  agent context or the thread message. */
const MAX_RESULT_CHARS = 600

function summarizeStepResult(result: unknown): string {
  const json = JSON.stringify(result ?? null)
  return json.length <= MAX_RESULT_CHARS
    ? json
    : `${json.slice(0, MAX_RESULT_CHARS)}… (truncated, ${json.length} chars total)`
}

/** What the platform records on every row of a bundle that failed (and on a
 *  lone call that failed for good when it ran): which step failed and the real
 *  error, so whoever wakes the agent (the chat re-invocation, a routine run's
 *  resume) can say so. */
export interface ExecutionFailure {
  failedStepId: string
  reason: string
  bundleId: string | null
}

/** Stamp the failure on the bundle's rows (or the lone row), in `tx`. */
export async function stampExecutionFailure(
  tx: PrivilegedDb,
  orgId: string,
  failure: ExecutionFailure,
): Promise<void> {
  const value = JSON.stringify(failure)
  await tx.execute(drizzleSql`
    UPDATE ${K}.approval_requests
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('executionFailure', ${value}::jsonb)
    WHERE org_id = ${orgId}::uuid
      AND (id = ${failure.failedStepId}::uuid
        ${failure.bundleId ? drizzleSql`OR bundle_id = ${failure.bundleId}::uuid` : drizzleSql``})`)
}

/** The failed bundle, step by step, and what the agent should do next: the
 *  failed step and its real error, what ran (with its result), what did not
 *  run, and that a corrected sequence is proposed as new calls (this one is
 *  closed). Read by the chat re-invocation and by a routine run's resume. */
export async function describeBundleFailure(
  tx: PrivilegedDb,
  orgId: string,
  failure: ExecutionFailure,
): Promise<string> {
  const steps = extractRows<{
    id: string
    tool_name: string
    status: string
    bundle_position: number | null
    execution: string | null
    result: unknown
  }>(
    await tx.execute(drizzleSql`
      SELECT ar.id::text, ar.tool_name, ar.status, ar.bundle_position,
        (SELECT e.status FROM ${K}.approved_handler_executions e
          WHERE e.approval_request_id = ar.id
          ORDER BY e.last_attempt_at DESC NULLS LAST LIMIT 1) AS execution,
        (SELECT e.result FROM ${K}.approved_handler_executions e
          WHERE e.approval_request_id = ar.id AND e.status = 'succeeded'
          LIMIT 1) AS result
      FROM ${K}.approval_requests ar
      WHERE ar.org_id = ${orgId}::uuid
        AND (ar.id = ${failure.failedStepId}::uuid
          ${failure.bundleId ? drizzleSql`OR ar.bundle_id = ${failure.bundleId}::uuid` : drizzleSql``})
      ORDER BY ar.bundle_position NULLS FIRST, ar.created_at`),
  )
  const label = (s: (typeof steps)[number], i: number) =>
    `Step ${(s.bundle_position ?? i) + 1} (${s.tool_name})`
  const failed = steps.find((s) => s.id === failure.failedStepId)
  const effect = (s: (typeof steps)[number]) =>
    s.execution === "ambiguous"
      ? "It MAY have taken effect: check before doing it again."
      : "It did not take effect."
  if (steps.length === 1 && failed && failed.status !== "approved") {
    // A lone call, not a sequence.
    return [
      `A call failed when it ran and was closed: ${failed.tool_name}: ${failure.reason}. ${effect(failed)}`,
      "It cannot be retried or approved again. To finish the task, propose a corrected call (a NEW call) that changes what the error names. If changing the call cannot fix the error, tell the person what is needed instead.",
    ].join("\n")
  }
  const failedIndex = failed ? steps.indexOf(failed) : -1
  const lines: string[] = [
    failed
      ? `An approval sequence failed and was stopped: ${label(failed, failedIndex)} failed: ${failure.reason}`
      : `An approval sequence failed and was stopped: ${failure.reason}`,
    "Step outcomes:",
  ]
  const notRun: string[] = []
  let ranCount = 0
  steps.forEach((s, i) => {
    if (s.id === failure.failedStepId && s.status !== "approved") {
      lines.push(
        s.execution === "ambiguous"
          ? `- ${label(s, i)}: FAILED while it ran: ${failure.reason}. ${effect(s)}`
          : s.execution
            ? `- ${label(s, i)}: FAILED when it ran: ${failure.reason}. ${effect(s)}`
            : `- ${label(s, i)}: FAILED before it ran: ${failure.reason}. ${effect(s)}`,
      )
    } else if (s.status === "approved") {
      ranCount++
      lines.push(
        s.id === failure.failedStepId
          ? `- ${label(s, i)}: RAN, then failed: ${failure.reason}. Do not run it again.`
          : `- ${label(s, i)}: RAN and took effect, result: ${summarizeStepResult(s.result)}. Do not run it again.`,
      )
    } else {
      notRun.push(s.tool_name)
      lines.push(
        `- ${label(s, i)}: NOT RUN (${s.status}, because ${failed ? `step ${(failed.bundle_position ?? failedIndex) + 1}` : "an earlier step"} failed).`,
      )
    }
  })
  const failedPending = failed && failed.status !== "approved"
  lines.push(
    "This sequence is closed: it cannot be retried or approved again.",
    failedPending || notRun.length > 0
      ? `To finish the task, propose a corrected sequence as NEW tool calls: ${failedPending ? `the call to ${failed.tool_name}, changed so the error above cannot happen again` : "what the failed step was for"}${notRun.length > 0 ? `, then the steps that did not run (${notRun.join(", ")}), chained with @ref tokens from the new calls` : ""}.${ranCount > 0 ? " Use the results of the steps that already ran as plain values instead of running them again." : ""} If changing the call cannot fix the error, tell the person what is needed instead.`
      : "Nothing is left to run. Tell the person what failed.",
  )
  return lines.join("\n")
}

/** Cancel every not-yet-succeeded step of the bundle that owns `approvalId`,
 *  post a thread message, and enqueue an agent re-invocation. Committed
 *  (approved) steps are left untouched. */
export async function failBundle(orgId: string, approvalId: string, reason: string): Promise<void> {
  const routineRunBundle = await withPrivilegedDb(orgId, "bundle-fail", async (tx) => {
    const [self] = extractRows<{
      bundle_id: string | null
      originating_thread_id: string
      thread_id: string
      requested_by: string
      tool_name: string
      agent_id: string | null
      routine_run: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT bundle_id, originating_thread_id, thread_id, requested_by, tool_name, agent_id,
          metadata->>'originRoutineRunId' AS routine_run
        FROM ${K}.approval_requests WHERE id = ${approvalId}`),
    )
    const bundleId = self.bundle_id ?? approvalId
    const failure: ExecutionFailure = { failedStepId: approvalId, reason, bundleId }
    await stampExecutionFailure(tx, orgId, failure)

    // Cancel the failed step + every not-yet-terminal sibling (position > 0).
    await tx.execute(drizzleSql`
      UPDATE ${K}.approval_requests SET status = 'cancelled'
      WHERE bundle_id = ${bundleId}
        AND status IN ('deferred','approving','pending')
        AND bundle_position > 0`)

    const context = await describeBundleFailure(tx, orgId, failure)
    // The reason can quote a tool or poll error, and the context what earlier
    // steps returned: the notice requires what those steps could reveal.
    const requesterScopes = (await loadEffectivePermissions(tx, self.requested_by, orgId)).scopes
    await postDualSystemMessages(tx, {
      requiredScopes: await bundleFailureRequiredScopes(tx, {
        orgId,
        bundleId,
        failedStepId: approvalId,
        requesterScopes,
      }),
      orgId,
      threadId: self.thread_id,
      originatingThreadId: self.originating_thread_id,
      requesterId: self.requested_by,
      actorUserId: self.requested_by,
      content: `The approval sequence could not complete automatically: ${reason}.`,
      metadata: { type: "sequence-failed", bundleId, reason, failedStepId: approvalId },
      // A11: this notice is the agent's failure, posted from a privileged path
      // outside its turn's frame. The identity comes off the approval row read
      // above, exactly as the re-invocation's does two lines below.
      agentId: self.agent_id ?? null,
    })
    // A routine run's bundle: the run waiting on it resumes, told the sequence
    // failed (routine-run-resume.ts), after this commits. No chat re-invocation,
    // which would act on the same failure outside the run and its lock.
    if (self.routine_run) return true
    // attempts: 1 — re-invocation posts a message and runs the agent (which
    // deducts credits). A BullMQ retry after a post-send throw would re-post and
    // double-charge; runAgentReinvoke is also idempotent on (threadId, bundleId)
    // as defense in depth (I-REL-10). jobId dedups concurrent enqueues.
    await enqueueAppJob(
      "kernel",
      "agent-reinvoke",
      {
        orgId,
        threadId: self.originating_thread_id,
        bundleId,
        requesterId: self.requested_by,
        context,
        // A11. The re-invocation runs in a BullMQ job, long after the proposing
        // turn ended and outside its ALS frame, so the identity RIDES THE
        // MESSAGE exactly as T32's rides the event envelope: the agent recorded
        // on the approval row when the gated call was proposed. Never
        // re-resolved inside the job, which asks "who would act now" and can
        // name a DIFFERENT agent than the one whose turn actually failed. Null
        // when the row names none: fail closed on identity, never the
        // requester's own id.
        agentId: self.agent_id ?? null,
      },
      { jobId: `agent-reinvoke:${bundleId}`, attempts: 1 },
    )
    return false
  })
  if (routineRunBundle) await enqueueRoutineDecisionTurn(orgId, approvalId)
}

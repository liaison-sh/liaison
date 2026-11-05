// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

const K = drizzleSql.raw(schemaRef("kernel"))

export class HandlerNoEffectError extends Error {
  code = "handler_no_effect"
  constructor(
    public toolName: string,
    public details: unknown,
  ) {
    super(`handler ${toolName} failed with no side effect`)
  }
}

export class HandlerAmbiguousError extends Error {
  code = "handler_ambiguous"
  constructor(
    public toolName: string,
    public details: unknown,
  ) {
    super(`handler ${toolName} ambiguous outcome`)
  }
}

export interface ApprovalProtocolContext {
  orgId: string
  approvalRequestId: string
  approvalDeciderId: string
  /** The routine that RAISED this approval, captured at request time. */
  originRoutineId?: string
  toolName: string
}

function assertCanonicalToolName(ctx: ApprovalProtocolContext, toolName: string): void {
  if (toolName !== ctx.toolName) {
    throw new Error("approval protocol toolName does not match approval request")
  }
}

export async function recordStarted(
  tx: PrivilegedDb,
  ctx: ApprovalProtocolContext,
  toolName: string,
): Promise<void> {
  assertCanonicalToolName(ctx, toolName)
  await tx.execute(drizzleSql`
    INSERT INTO ${K}.approved_handler_executions
      (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at)
    VALUES (${ctx.orgId}, ${ctx.approvalRequestId}, ${toolName}, 'started', ${ctx.approvalDeciderId}, 1, now())
    ON CONFLICT (approval_request_id, tool_name) DO UPDATE
      SET status = 'started',
          attempts = ${K}.approved_handler_executions.attempts + 1,
          last_attempt_at = now(),
          actor_id = EXCLUDED.actor_id,
          error = NULL,
          finished_at = NULL
  `)
}

export async function recordSucceeded(
  tx: PrivilegedDb,
  ctx: ApprovalProtocolContext,
  toolName: string,
  externalRef?: unknown,
): Promise<void> {
  assertCanonicalToolName(ctx, toolName)
  const refJson =
    externalRef === undefined || externalRef === null ? null : JSON.stringify(externalRef)
  await tx.execute(drizzleSql`
    UPDATE ${K}.approved_handler_executions
    SET status = 'succeeded',
        external_ref = ${refJson}::jsonb,
        finished_at = now()
    WHERE approval_request_id = ${ctx.approvalRequestId} AND tool_name = ${toolName}
  `)
}

export async function recordAwaitingOutput(
  tx: PrivilegedDb,
  ctx: ApprovalProtocolContext,
  toolName: string,
  externalRef?: unknown,
): Promise<void> {
  assertCanonicalToolName(ctx, toolName)
  // Mirror recordSucceeded exactly: absent ref → SQL NULL, not JSON 'null'.
  const refJson =
    externalRef === undefined || externalRef === null ? null : JSON.stringify(externalRef)
  await tx.execute(drizzleSql`
    UPDATE ${K}.approved_handler_executions
    SET status = 'awaiting_output',
        external_ref = ${refJson}::jsonb
    WHERE approval_request_id = ${ctx.approvalRequestId} AND tool_name = ${toolName}
  `)
}

export async function recordFailedNoEffect(
  tx: PrivilegedDb,
  ctx: ApprovalProtocolContext,
  toolName: string,
  err: unknown,
): Promise<void> {
  assertCanonicalToolName(ctx, toolName)
  const payload = JSON.stringify(err ?? {})
  await tx.execute(drizzleSql`
    UPDATE ${K}.approved_handler_executions
    SET status = 'failed_no_effect',
        error = ${payload}::jsonb,
        finished_at = now()
    WHERE approval_request_id = ${ctx.approvalRequestId} AND tool_name = ${toolName}
      AND ${NOT_LANDED}
  `)
}

/**
 * The key `recordEffectLanded` stamps into `external_ref`. Its presence on a row
 * that is not yet `succeeded` means the provider accepted the external effect
 * and only the handler's post-effect work (persisting a copy, relinking files)
 * was still running.
 */
export const EFFECT_LANDED_KEY = "effectLandedAt"

/** SQL guard: the row carries no landed external effect. */
const NOT_LANDED = drizzleSql`NOT COALESCE(external_ref ? ${EFFECT_LANDED_KEY}, false)`

/**
 * Record, durably and BEFORE any post-effect work, that the external effect
 * landed: the provider call returned and `externalRef` names what it created
 * (e.g. `{ provider: "gmail", messageId, externalThreadId }`).
 *
 * A handler can be cut off after its provider call (the sandbox ceiling
 * interrupts it mid post-send work, or the process dies) and never reach
 * `recordSucceeded`. Without this record the row stays `started`, the outcome
 * is unknown, and the approval parks for a human although the effect plainly
 * happened. With it, the host promotes the row to `succeeded`
 * (`promoteLandedEffect`) and never runs the provider call again.
 *
 * Accepted on `ambiguous` too: the host may have classified a cut-off execution
 * before this write, still in flight on the bridge, reached the database.
 */
export async function recordEffectLanded(
  tx: PrivilegedDb,
  ctx: ApprovalProtocolContext,
  toolName: string,
  externalRef: unknown,
): Promise<void> {
  assertCanonicalToolName(ctx, toolName)
  const ref = isPlainRecord(externalRef) ? externalRef : { value: externalRef ?? null }
  await tx.execute(drizzleSql`
    UPDATE ${K}.approved_handler_executions
    SET external_ref = ${JSON.stringify(ref)}::jsonb
          || jsonb_build_object(${EFFECT_LANDED_KEY}::text, now())
    WHERE approval_request_id = ${ctx.approvalRequestId} AND tool_name = ${toolName}
      AND status IN ('started', 'ambiguous')
  `)
}

/** True when a protocol row's `external_ref` was written by `recordEffectLanded`. */
export function hasLandedEffect(externalRef: unknown): boolean {
  return isPlainRecord(externalRef) && externalRef[EFFECT_LANDED_KEY] != null
}

/**
 * Promote a `started` or `ambiguous` row whose external effect landed to
 * `succeeded`, keeping the ref and exposing it (without the marker) as the
 * decided result when the handler never wrote one. Returns that result, or null
 * when the row has no landed effect (nothing changed).
 */
export async function promoteLandedEffect(
  tx: PrivilegedDb,
  approvalRequestId: string,
  toolName: string,
): Promise<Record<string, unknown> | null> {
  const rows = extractRows<{ result: unknown }>(
    await tx.execute(drizzleSql`
      UPDATE ${K}.approved_handler_executions
      SET status = 'succeeded',
          result = COALESCE(result, external_ref - ${EFFECT_LANDED_KEY}::text),
          finished_at = now()
      WHERE approval_request_id = ${approvalRequestId} AND tool_name = ${toolName}
        AND status IN ('started', 'ambiguous')
        AND external_ref ? ${EFFECT_LANDED_KEY}
      RETURNING result
    `),
  )
  if (rows.length === 0) return null
  return isPlainRecord(rows[0]?.result) ? rows[0].result : {}
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export async function recordAmbiguous(
  tx: PrivilegedDb,
  ctx: ApprovalProtocolContext,
  toolName: string,
  err: unknown,
): Promise<void> {
  assertCanonicalToolName(ctx, toolName)
  const payload = JSON.stringify(err ?? {})
  await tx.execute(drizzleSql`
    UPDATE ${K}.approved_handler_executions
    SET status = 'ambiguous',
        error = ${payload}::jsonb,
        finished_at = now()
    WHERE approval_request_id = ${ctx.approvalRequestId} AND tool_name = ${toolName}
  `)
}

/**
 * Clear a PREVIOUS attempt's terminal-failure row before a fresh attempt.
 *
 * The outcome contract treats "no row + clean return" as synchronous success,
 * and nothing reset the ledger between attempts -- so a leftover
 * failed_no_effect (or ambiguous) row made throwPersistedHandlerOutcome
 * re-throw the OLD error over a retry that had just SUCCEEDED. Prod 2026-08-06:
 * the skill update landed (kernel.skills.updated_at moved), yet the approver
 * saw the stale "You do not have permission" refusal and the request stayed
 * pending. A synchronous handler could never recover from one failure.
 *
 * Only terminal FAILURES are cleared. A 'started' row is a crash marker whose
 * whole purpose is double-send protection and MUST survive; succeeded /
 * awaiting_output stay authoritative. Clearing 'ambiguous' is deliberate: the
 * human explicitly chose to retry, and this attempt's own protocol writes
 * re-record whatever actually happens. An `ambiguous` row whose external effect
 * landed (`recordEffectLanded`) is kept: deleting it would let the retry send
 * again.
 */
export async function clearStaleTerminalFailure(
  tx: PrivilegedDb,
  ctx: ApprovalProtocolContext,
  toolName: string,
): Promise<void> {
  assertCanonicalToolName(ctx, toolName)
  await tx.execute(drizzleSql`
    DELETE FROM ${K}.approved_handler_executions
    WHERE org_id = ${ctx.orgId}
      AND approval_request_id = ${ctx.approvalRequestId}
      AND tool_name = ${toolName}
      AND status IN ('failed_no_effect', 'ambiguous')
      AND ${NOT_LANDED}
  `)
}

export async function readHandlerExecution(
  orgId: string,
  approvalRequestId: string,
  toolName: string,
): Promise<{ status: string; error: unknown; externalRef: unknown } | null> {
  const result = await withPrivilegedDb(orgId, "approval-read-handler-execution", (tx) =>
    tx.execute(drizzleSql`
      SELECT status, error, external_ref
      FROM ${K}.approved_handler_executions
      WHERE approval_request_id = ${approvalRequestId} AND tool_name = ${toolName}
    `),
  )
  const [row] = extractRows<{ status: string; error: unknown; external_ref: unknown }>(result)
  return row ? { status: row.status, error: row.error, externalRef: row.external_ref } : null
}

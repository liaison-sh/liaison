// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A routine that failed or paused tells its OWNER, on Home (D21).
 *
 * Before this, only a run-now requester got a Home item when a run went wrong
 * (routine-worker's run-now notification). A scheduled run's failure, or an
 * automatic pause (scope mismatch, no credits), was a `routine:status` frame
 * for an open Routines screen and nothing else: the owner of a morning brief
 * that stopped working found out by noticing the brief was missing.
 *
 * One Home item per routine: the event is keyed on the routine id, and an
 * unread attention row upserts on its entity, so a routine failing every hour
 * reads as one row carrying the latest error, not a pile. Urgency 60 keeps it
 * an FYI tier (not "needs you now"); Home files any item carrying
 * `routineAlert` under Agents > "Routines failed or paused".
 *
 * The caller hands in its own transaction so the alert commits with the run
 * row it reports on.
 */
import { routineDisplayName } from "~/modules/agent/routines/routine-label"

export type RoutineAlertStatus = "failed" | "paused_scope_mismatch" | "paused_no_credits"

export interface RoutineAlertRoutine {
  id: string
  name: string
  /** Its title (0304), shown in place of the identifier when set. */
  title?: string | null
  ownerUserId: string
  ownerAgentId: string | null
  outputThreadId: string | null
}

interface QueueingTx {
  queueEvent: (event: {
    app: string
    entity: string
    action: string
    entityId: string
    data: Record<string, unknown>
    actorId: string
    actorType: "system"
    agentId: string | null
    orgId: string
    timestamp: string
  }) => Promise<unknown>
}

/**
 * Why a routine whose owner's account is no longer active is paused: the reason the routine, its
 * list row and its runs show. Shared by the deactivation itself and the routine's ticks.
 */
export function routineOwnerInactiveReason(ownerStatus: string): string {
  return (
    `Paused: its owner's account is ${ownerStatus}, so this routine would act for someone who no longer works here. ` +
    "Reactivating the owner runs it again at its next tick; to keep it running without them, make someone else its owner."
  )
}

/** The owner-facing sentence. The run row and the routine page carry the detail. */
export function routineAlertSummary(name: string, status: RoutineAlertStatus): string {
  if (status === "failed") return `Routine "${name}" run failed`
  if (status === "paused_no_credits") return `Routine "${name}" paused: out of credits`
  return `Routine "${name}" paused: a scope it needs is missing`
}

export async function queueRoutineAlert(
  tx: QueueingTx,
  opts: {
    orgId: string
    routine: RoutineAlertRoutine
    status: RoutineAlertStatus
    error: string | null
  },
): Promise<void> {
  const { routine } = opts
  await tx.queueEvent({
    app: "kernel",
    entity: "agent_notification",
    action: "create",
    // Keyed on the routine: the unread row upserts instead of piling up.
    entityId: routine.id,
    data: {
      summary: routineAlertSummary(routineDisplayName(routine), opts.status),
      urgency: 60,
      targetUserIds: [routine.ownerUserId],
      ...(routine.outputThreadId
        ? { link: { tabType: "thread", entityId: routine.outputThreadId } }
        : {}),
      routineAlert: {
        routineId: routine.id,
        status: opts.status,
        error: opts.error,
        at: new Date().toISOString(),
      },
    },
    actorId: routine.ownerUserId,
    actorType: "system",
    agentId: routine.ownerAgentId ?? null,
    orgId: opts.orgId,
    timestamp: new Date().toISOString(),
  })
}

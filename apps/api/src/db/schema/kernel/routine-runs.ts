// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { check, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { routines } from "./routines"

export const routineRuns = kernel.table(
  "routine_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    turnsAdded: integer("turns_added"),
    /** What started the run: 'schedule', 'event', 'manual' (0157) or 'retry' (0159). NULL on older rows. */
    trigger: text("trigger"),
    /** The event that fired an event run, as `app.entity.action`. */
    triggerLabel: text("trigger_label"),
    /** When the run began; its transcript is the output thread between this and `ranAt`. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** The outbox id of the event an event or retry run was fired for (0159), as kernel.audit_log keeps it. */
    eventId: uuid("event_id"),
    /** That event's entity id. */
    eventEntityId: text("event_entity_id"),
    /** 0 for the run the event fired, n for the reconciler's nth retry of it. */
    attempt: integer("attempt").notNull().default(0),
    /**
     * A run that waits for an approval (status 'waiting_approval', 0222): what
     * its resume needs (routine-run-resume.ts). Kept after the run ends, as the
     * record of its pauses. NULL for a run that never paused.
     */
    pauseState: jsonb("pause_state").$type<RoutineRunPauseState>(),
    /**
     * A run that waits for its owner's private mailbox (status
     * 'waiting_mailbox', 0232; routine-mailbox-wait.ts). Ids and times only.
     * NULL for a run that never waited.
     */
    mailboxWait: jsonb("mailbox_wait").$type<RoutineRunMailboxWait>(),
  },
  (t) => [
    index("routine_runs_routine_ran_idx").on(t.routineId, sql`ran_at DESC`),
    index("routine_runs_routine_event_idx")
      .on(t.routineId, t.eventId)
      .where(sql`event_id IS NOT NULL`),
    index("routine_runs_routine_event_entity_idx")
      .on(t.routineId, t.eventEntityId)
      .where(sql`event_entity_id IS NOT NULL`),
    check(
      "routine_runs_status_chk",
      sql`${t.status} IN ('succeeded','failed','skipped_no_credits','skipped_overlap','skipped_scope_mismatch','output_thread_recreated','dispatched','waiting_approval','waiting_mailbox','mailbox_wait_expired','mailbox_wait_dismissed')`,
    ),
    index("routine_runs_waiting_idx").on(t.routineId).where(sql`status = 'waiting_approval'`),
    check(
      "routine_runs_trigger_chk",
      sql`${t.trigger} IS NULL OR ${t.trigger} IN ('schedule', 'event', 'manual', 'retry')`,
    ),
  ],
)

/** What a paused run keeps for its resume (routine-run-resume.ts). */
export interface RoutineRunPauseState {
  /** The run frame's root id: every approval the run asks for records it. */
  tickRunId: string
  /** The approvals the run waits on, all of them decided before it resumes. */
  approvalIds: string[]
  /** How many times the run has resumed. */
  resumeCount: number
  outputThreadId: string
  /** The run's line in its report conversation, when it posts there. */
  runLineId: string | null
  /** When the run started (ISO): its report reads the replies since then. */
  startedAt: string
  /** Whether the output thread was marked as having read outside text at the pause. */
  tainted: boolean
  /**
   * Where that outside text came from, as the thread's mark names it (scopes/taint.ts): the MCP
   * servers it came from, or null when one of them is unknown. Absent (a run paused before this
   * was kept) counts as unknown.
   */
  taintedSources?: string[] | null
  /** The run's token account (`RunContext.tokenAccount`): the resume goes on counting in it. */
  tokenAccount?: { id: string; used: number } | null
  /** The person who asked for a run-now, told when the run ends. */
  requestedByUserId?: string | null
  /** The event an event run was fired for. */
  triggerEventId?: string | null
  /** The owner's message that started the run: its text is quoted to the resume. */
  promptMessageId?: string | null
  /** What the run's agent wrote at each pause, quoted to the resume. */
  progress?: string[]
  /** Turns the run has taken so far. */
  turnsAdded?: number
  /** The run recreated its output thread (its final status says so). */
  recreated?: boolean
  /** What started the run, as the run history names it. */
  trigger?: "schedule" | "event" | "manual" | "retry"
  /** The entity of the event an event run was fired for. */
  eventEntityId?: string | null
  /**
   * Set when a resume claimed the run (ISO), until it pauses again or ends.
   * The waited-on approvals move to `resumedFrom` then, so a late event for one
   * of them never starts a second resume.
   */
  resumingAt?: string | null
  /** The approvals the current resume was started for. */
  resumedFrom?: string[]
}

/** The event an event run was fired for (routine-worker.ts `RoutineTriggerEvent`). */
export interface RoutineRunWaitEvent {
  app: string
  entity: string
  action: string
  entityId: string | null
  /** Never written (ids and times only): a Run now reads the event's data back from the
   *  audit log by `eventId`. Rows parked by an earlier release may still carry it. */
  data?: unknown
  origin?: "external" | "internal"
  eventId?: string | null
  retryAttempt?: number
}

/**
 * What a run waiting for its owner's private mailbox keeps (routine-mailbox-wait.ts).
 * Never any mail content: whose mailbox, which one, until when, and the claim
 * a Run now holds while it runs.
 */
export interface RoutineRunMailboxWait {
  /** The mailbox owner: the routine's owner, the only person who may run it. */
  ownerUserId: string
  /** The private mailbox the run needed (mail account id), when it was known. */
  accountId: string | null
  /** When the wait lapses (ISO): 24 hours after it began. */
  expiresAt: string
  outputThreadId: string
  /** The event an event run was fired for, so a Run now handles that same event. */
  triggerEvent?: RoutineRunWaitEvent | null
  /** Set when the owner pressed Run now (ISO); a second press is refused. */
  claimedAt?: string | null
}

export type RoutineRun = typeof routineRuns.$inferSelect
export type NewRoutineRun = typeof routineRuns.$inferInsert

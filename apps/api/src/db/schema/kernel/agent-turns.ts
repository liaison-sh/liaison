// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { threads } from "./threads"

/** Where a turn came from (migration 0225). */
export const AGENT_TURN_ORIGINS = [
  "chat",
  "thread",
  "routine",
  "reinvoke",
  "subrun",
  "job",
] as const
export type AgentTurnOrigin = (typeof AGENT_TURN_ORIGINS)[number]

/**
 * A turn's lifecycle: `running` while a process owns it, `handoff` when a
 * draining process stopped it at a step boundary for another to resume, then
 * one terminal state.
 */
export const AGENT_TURN_STATES = ["running", "handoff", "done", "failed", "interrupted"] as const
export type AgentTurnState = (typeof AGENT_TURN_STATES)[number]

/**
 * Why a turn that did not end `done` ended (migration 0228): `process` (the
 * process running it stopped or died and it could not be carried on: not
 * resumable, the resume refused or failed, or never resumed before the
 * maximum age), `turn` (it failed on its own: a model or tool error, a
 * timeout) or `client` (its caller left before any output). A deploy's
 * counters count only `process` (scripts/lib/deploy-counters.ts).
 */
export const AGENT_TURN_FAILURE_REASONS = ["process", "turn", "client"] as const
export type AgentTurnFailureReason = (typeof AGENT_TURN_FAILURE_REASONS)[number]

/**
 * What rebuilds a turn's model call on another process. Written once when the
 * turn opens; the resume reads it back. Every field is optional so a turn
 * kind fills only what it has.
 */
export interface AgentTurnResumeInput {
  /** The actor the turn runs as, as it stood when the turn opened. */
  actor?: Record<string, unknown>
  actingAgentId?: string | null
  modelId?: string | null
  reasoningLevel?: string | null
  background?: boolean
  routineId?: string | null
  /** The turn's step budget (the loop continues with `maxSteps - step_count`). */
  maxSteps?: number
  clientSurface?: string | null
  /** The live-stream key, so a resumed turn continues the same `seq`. */
  liveTurnKey?: string | null
  /** The tool names the turn started with (a mismatch on resume is logged). */
  toolNames?: string[]
  /** A hash of the system prompt the turn started with. */
  systemPromptHash?: string
  /**
   * False for a turn whose caller holds its reply in process (a Share anyway
   * rerun: `persistReply: false`, read-only tools, a scope override). A resume
   * cannot rebuild that caller, so such a turn is never resumed: it ends
   * `interrupted` and posts nothing. Absent = resumable.
   */
  resumable?: boolean
  /** What the turn's scope accumulator held when it opened (the taint it started with). */
  startScopes?: string[]
  /** Every restriction the turn ran under; a resume re-applies all of them. */
  restrictions?: AgentTurnRestrictions
}

/**
 * The restrictions a turn ran under (S10, H1). A resume runs with exactly
 * these, never wider: the effective scope (on `actor.effectiveScope`) caps the
 * resumed scope, a delegated ask keeps its delegated scope and its framing, a
 * restricted session stays restricted, and the dimension grants are the ones
 * the turn started with intersected with the person's current ones.
 */
export interface AgentTurnRestrictions {
  /** An agent (or an external app) asked: the hand off (TurnCoordination). */
  coordination?: {
    callerAgentId: string | null
    parentMessageId: string
    delegatedScope?: string[]
    callerTaintScopes?: string[]
    askedQuestion?: { askedBy: string; question: string }
  }
  sessionRestricted?: boolean
  agentDispatched?: boolean
  anchorHistory?: boolean
  askId?: string
  replyRootId?: string | null
  currentView?: { tabType: string; entityId: string }
  dimensionGrants?: Record<string, string[]>
  /** A routine run's id and token account (S17): the resume counts on the same account. */
  routineRunId?: string
  tokenAccount?: { id: string; tokenBudget: number | null; hardTokenLimit: number | null }
}

/**
 * One agent turn (migration 0225). Owned by `runnerInstanceId` while running;
 * every write the runner makes is fenced on that ownership
 * (modules/agent/runtime/turn-ledger.ts, the only writer). Reached only
 * through the privileged connection.
 */
export const agentTurns = kernel.table(
  "agent_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id"),
    origin: text("origin", { enum: AGENT_TURN_ORIGINS }).notNull(),
    originRef: text("origin_ref"),
    userMessageId: uuid("user_message_id"),
    runId: uuid("run_id"),
    state: text("state", { enum: AGENT_TURN_STATES }).notNull().default("running"),
    runnerInstanceId: text("runner_instance_id").notNull(),
    attempt: integer("attempt").notNull().default(0),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    stepCount: integer("step_count").notNull().default(0),
    resumeInput: jsonb("resume_input").$type<AgentTurnResumeInput>().notNull().default({}),
    agentMessageId: uuid("agent_message_id"),
    errorCode: text("error_code"),
    failureReason: text("failure_reason", { enum: AGENT_TURN_FAILURE_REASONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_turns_state_heartbeat_idx").on(table.state, table.heartbeatAt),
    uniqueIndex("agent_turns_org_origin_ref_idx")
      .on(table.orgId, table.originRef)
      .where(sql`origin_ref IS NOT NULL`),
    index("agent_turns_thread_open_idx")
      .on(table.threadId)
      .where(sql`state IN ('running', 'handoff')`),
  ],
)

export type AgentTurnRow = typeof agentTurns.$inferSelect

/**
 * A turn's journal: one row per complete step, in order (migration 0225).
 * `payload` is the step as the turn runtime journaled it. Deleted with the
 * turn and when the turn finishes.
 */
export const agentTurnEvents = kernel.table(
  "agent_turn_events",
  {
    turnId: uuid("turn_id")
      .notNull()
      .references(() => agentTurns.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: ["step"] }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.turnId, table.seq] })],
)

export type AgentTurnEventRow = typeof agentTurnEvents.$inferSelect

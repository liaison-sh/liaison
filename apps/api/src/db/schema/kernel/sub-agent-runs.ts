// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  type AnyPgColumn,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import type { ActorContext } from "~/db/rls"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { threads } from "./threads"

// One row per agent execution — root chat run, routine-spawned run, or sub-run.
//
// `parent_run_id` is null for roots; non-null for descendants.
// `root_run_id`   is the top ancestor (self-reference for roots; the FK is
//                 DEFERRABLE INITIALLY DEFERRED so a single statement can set
//                 root_run_id = id atomically using gen_random_uuid()).
// `thread_id`     points to (a) the surface thread for a root chat run,
//                 (b) the routine's thread for a routine-spawned root run, or
//                 (c) the hidden subrun thread for sub-runs.
// `subagent_type` is null for root runs and the role slug for sub-runs (kept
//                 named `subagent_type` to avoid rippling renames; documented
//                 here that null means "no role assigned").
// `actor`         is a JSONB snapshot of the ActorContext that owns the run.
// `output_schema` is a JSON-schema. When present, the runtime injects a
//                 synthetic `finalize` tool whose input schema is this value.
export const agentRuns = kernel.table(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => agentRuns.id, {
      onDelete: "cascade",
    }),
    rootRunId: uuid("root_run_id").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    // The parent surface thread id — where the collapsed sub_run card was
    // posted. Null for root runs (their `threadId` is itself the surface);
    // non-null for sub-runs so emit-status events can carry it.
    parentThreadId: uuid("parent_thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    // The agent the SPAWNING turn was acting as (A11). Persisted at spawn
    // because the run's terminal event is emitted after the run's own
    // transaction, outside every frame: without a column there is no identity
    // left to carry, and the row is anonymous. Null is a positive "no agent
    // spawned this": a cron, a job or a webhook. The composite
    // (agent_id, org_id) key is in the table config below (0074).
    agentId: uuid("agent_id"),
    subagentType: text("subagent_type"),
    actor: jsonb("actor").$type<ActorContext>().notNull(),
    effectiveScopes: text("effective_scopes").array().notNull().default([]),
    status: text("status").notNull().default("queued"),
    prompt: text("prompt").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>(),
    summary: text("summary"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    usagePromptTokens: integer("usage_prompt_tokens").notNull().default(0),
    usageCompletionTokens: integer("usage_completion_tokens").notNull().default(0),
    creditCost: numeric("credit_cost").notNull().default("0"),
    maxSteps: integer("max_steps").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    schemaRetryBudget: integer("schema_retry_budget").notNull(),
    schemaRetryCount: integer("schema_retry_count").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    nestingDepth: integer("nesting_depth").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_runs_org_parent_idx").on(table.orgId, table.parentRunId),
    index("agent_runs_org_root_idx").on(table.orgId, table.rootRunId),
    index("agent_runs_org_status_idx").on(table.orgId, table.status),
    index("agent_runs_org_thread_idx").on(table.orgId, table.threadId),
    // The agent must belong to the RUN'S OWN ORG, the class 0072 closed.
    // ON DELETE SET NULL: an agent hard-deleted (personal-agent erasure) costs
    // the name, never the run row or its audit trail.
    foreignKey({
      columns: [table.agentId, table.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "agent_runs_agent_org_fk",
    }).onDelete("set null"),
    index("agent_runs_agent_idx")
      .on(table.agentId)
      .where("agent_id IS NOT NULL" as any),
  ],
)

export type AgentRun = typeof agentRuns.$inferSelect
export type NewAgentRun = typeof agentRuns.$inferInsert

export type AgentRunStatus = "queued" | "running" | "done" | "failed" | "cancelled"

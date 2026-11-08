// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Deals: a deal is a root task of a pipeline project, with a row in
 * `app_projects.deals` (company, contact, outcome) and one in
 * `app_projects.deal_values` (the amount, behind projects:deals:read).
 *
 * The outcome of a deal follows the stage its task sits in: a stage whose
 * `deal_outcome` is `won` or `lost` closes the deal, any other stage leaves it
 * open. {@link syncDealOutcome} is the ONE place that writes `outcome`,
 * `closed_at`, `closed_by`, `lost_reason` and `reopen_status_id`, and every
 * write of a task's status in this service calls it in the same transaction
 * (create, update, move, cross-project move, the column migration of a status
 * delete, a stage losing its outcome). `deal-outcome-writer.guard.test.ts`
 * fails on a status write that does not, and on an outcome written anywhere
 * else.
 *
 * Deleting a deal's task archives it (deleteTask): its deal rows stay, every
 * deal read here leaves archived tasks out, and a restore brings the deal back
 * whole, amount, company and outcome included.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import type { UserContext } from "~/db/rls"
import { ProjectsServiceError } from "./statuses"

type SqlClient = RlsClient | RlsTx

export type DealOutcome = "open" | "won" | "lost"

/** One outcome change {@link syncDealOutcome} made. */
export interface DealOutcomeChange {
  taskId: string
  from: DealOutcome
  to: DealOutcome
  companyId: string | null
}

export interface SyncDealOutcomeOptions {
  /** The status each task held before the write, when the caller knows it: a
   *  deal closed from an open stage remembers that stage, so a reopen goes back
   *  to it. */
  fromStatusIds?: Readonly<Record<string, string>>
  /** Stored as the lost reason when this write closes a deal as lost. */
  lostReason?: string | null
}

// ---------------------------------------------------------------------------
// Failpoint: proves the outcome write and the status write commit together.
// ---------------------------------------------------------------------------

type DealOutcomeFailpoint = () => Promise<void> | void
let afterDealOutcomeWrite: DealOutcomeFailpoint | null = null

/** Arm a fault right after the outcome is written. Refused in production. */
export function armAfterDealOutcomeFailpoint(fn: DealOutcomeFailpoint): () => void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The deal outcome failpoint cannot be armed in production")
  }
  afterDealOutcomeWrite = fn
  return () => {
    afterDealOutcomeWrite = null
  }
}

function idList(ids: readonly string[]): SQL {
  return drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
}

/**
 * Bring the deal rows of `taskIds` in line with the stage each task sits in,
 * after a write of their status. Idempotent: a task whose outcome already
 * matches its stage is left alone and emits nothing, so a second "mark won"
 * is a no-op.
 *
 * - A live root task of a pipeline with no deal row gets one, and its empty
 *   value row through `ensure_deal_value` (a task created in, moved into, or
 *   promoted to the root of a pipeline).
 * - Reaching a `won` or `lost` stage sets the outcome, `closed_at` and
 *   `closed_by` and emits `projects/deal:closed`.
 * - Leaving a closing stage for an open one clears the outcome, the close
 *   stamps and the lost reason and emits `projects/deal:reopened`.
 * - Won to lost (or back) emits `reopened` then `closed`.
 */
export async function syncDealOutcome(
  tx: SqlClient,
  orgId: string,
  actor: UserContext,
  taskIds: readonly string[],
  options: SyncDealOutcomeOptions = {},
): Promise<DealOutcomeChange[]> {
  if (taskIds.length === 0) return []
  const ids = idList(taskIds)

  const created = extractRows<{ task_id: string }>(
    await tx.execute(drizzleSql`
      INSERT INTO ${projectsRel("deals")} (task_id, org_id)
      SELECT t.id, t.org_id
      FROM ${projectsRel("tasks")} t
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      WHERE t.id IN (${ids})
        AND t.org_id = ${orgId}::uuid
        AND t.parent_task_id IS NULL
        AND t.archived_at IS NULL
        AND p.kind = 'pipeline'
      ON CONFLICT (task_id) DO NOTHING
      RETURNING task_id
    `),
  )
  for (const row of created) {
    await tx.execute(drizzleSql`SELECT ${projectsRel("ensure_deal_value")}(${row.task_id}::uuid)`)
  }

  // A remembered reopen stage of another project (the deal crossed pipelines)
  // no longer applies.
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("deals")} d
    SET reopen_status_id = NULL, updated_at = now()
    FROM ${projectsRel("tasks")} t, ${projectsRel("project_statuses")} rs
    WHERE d.task_id IN (${ids}) AND d.org_id = ${orgId}::uuid
      AND t.id = d.task_id AND t.org_id = d.org_id
      AND rs.id = d.reopen_status_id AND rs.project_id <> t.project_id
  `)

  const rows = extractRows<{
    task_id: string
    outcome: DealOutcome
    company_id: string | null
    target: DealOutcome
    project_id: string
  }>(
    await tx.execute(drizzleSql`
      SELECT d.task_id, d.outcome, d.company_id, t.project_id,
             COALESCE(s.deal_outcome, 'open') AS target
      FROM ${projectsRel("deals")} d
      JOIN ${projectsRel("tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      WHERE d.task_id IN (${ids}) AND d.org_id = ${orgId}::uuid
      ORDER BY d.task_id
      FOR UPDATE OF d
    `),
  )

  const changes: DealOutcomeChange[] = []
  for (const row of rows) {
    if (row.outcome === row.target) continue
    const change: DealOutcomeChange = {
      taskId: row.task_id,
      from: row.outcome,
      to: row.target,
      companyId: row.company_id,
    }
    if (row.target === "open") {
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("deals")}
        SET outcome = 'open', closed_at = NULL, closed_by = NULL, lost_reason = NULL,
            reopen_status_id = NULL, updated_at = now()
        WHERE task_id = ${row.task_id}::uuid AND org_id = ${orgId}::uuid
      `)
    } else {
      const fromStatusId = options.fromStatusIds?.[row.task_id]
      // Only an open stage of the same project is a place to reopen to; a deal
      // going from won to lost keeps the stage it was first closed from.
      const reopenSql =
        row.outcome === "open" && fromStatusId
          ? drizzleSql`(SELECT id FROM ${projectsRel("project_statuses")}
                WHERE id = ${fromStatusId}::uuid AND org_id = ${orgId}::uuid
                  AND project_id = ${row.project_id}::uuid AND NOT terminal)`
          : row.outcome === "open"
            ? drizzleSql`NULL`
            : drizzleSql`reopen_status_id`
      const reason = row.target === "lost" ? options.lostReason?.trim() || null : null
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("deals")}
        SET outcome = ${row.target}, closed_at = now(), closed_by = ${actor.userId}::uuid,
            lost_reason = ${reason}, reopen_status_id = ${reopenSql}, updated_at = now()
        WHERE task_id = ${row.task_id}::uuid AND org_id = ${orgId}::uuid
      `)
    }
    if (afterDealOutcomeWrite) await afterDealOutcomeWrite()
    if (change.from !== "open") {
      await tx.queueEvent({
        app: "projects",
        entity: "deal",
        action: "reopened",
        entityId: row.task_id,
        data: {
          taskId: row.task_id,
          outcome: "open",
          from: change.from,
          companyId: row.company_id,
        },
        actorId: actor.userId,
        actorType: "user",
        orgId,
      })
    }
    if (change.to !== "open") {
      await tx.queueEvent({
        app: "projects",
        entity: "deal",
        action: "closed",
        entityId: row.task_id,
        data: { taskId: row.task_id, outcome: change.to, companyId: row.company_id },
        actorId: actor.userId,
        actorType: "user",
        orgId,
      })
    }
    changes.push(change)
  }
  return changes
}

// ---------------------------------------------------------------------------
// Pipelines and their stages
// ---------------------------------------------------------------------------

/** The stages of a new pipeline: [label, color]. Won and Lost close a deal. */
export const PIPELINE_OPEN_STAGES: ReadonlyArray<readonly [string, string]> = [
  ["Lead", "#6b7280"],
  ["Qualified", "#3b82f6"],
  ["Demo", "#f59e0b"],
  ["Proposal", "#8b5cf6"],
]
export const PIPELINE_CLOSING_STAGES: ReadonlyArray<
  readonly [string, string, Exclude<DealOutcome, "open">]
> = [
  ["Won", "#22c55e", "won"],
  ["Lost", "#ef4444", "lost"],
]

export async function projectKind(
  tx: SqlClient,
  orgId: string,
  projectId: string,
): Promise<"work" | "pipeline" | null> {
  const rows = extractRows<{ kind: "work" | "pipeline" }>(
    await tx.execute(drizzleSql`
      SELECT kind FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `),
  )
  return rows[0]?.kind ?? null
}

async function hasDealRow(tx: SqlClient, orgId: string, taskId: string): Promise<boolean> {
  const rows = extractRows<{ task_id: string }>(
    await tx.execute(drizzleSql`
      SELECT task_id FROM ${projectsRel("deals")}
      WHERE task_id = ${taskId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `),
  )
  return rows.length > 0
}

/**
 * A cross-project move of a deal: refused into a work project (a deal needs a
 * pipeline), and into another pipeline the stage it lands on follows its
 * outcome (a won deal lands on the won stage), then the first open stage.
 * Returns the stage to use, or undefined when the task is not a deal (the
 * move's own rule applies).
 */
export async function dealTargetStatusForMove(
  tx: SqlClient,
  orgId: string,
  taskId: string,
  targetProjectId: string,
): Promise<string | undefined> {
  if (!(await hasDealRow(tx, orgId, taskId))) return undefined
  if ((await projectKind(tx, orgId, targetProjectId)) !== "pipeline") {
    throw new ProjectsServiceError(
      409,
      "deal_needs_pipeline",
      "This task is a deal and can only move to another pipeline. Nothing was moved.",
    )
  }
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT s.id
      FROM ${projectsRel("project_statuses")} s
      JOIN ${projectsRel("deals")} d ON d.task_id = ${taskId}::uuid AND d.org_id = s.org_id
      WHERE s.project_id = ${targetProjectId}::uuid AND s.org_id = ${orgId}::uuid
        AND (CASE WHEN d.outcome = 'open' THEN NOT s.terminal ELSE s.deal_outcome = d.outcome END)
      ORDER BY s."order" ASC
      LIMIT 1
    `),
  )
  return rows[0]?.id
}

/**
 * The closing stages of a pipeline, by name, for a status reference that named
 * none of its stages ("mark it done"): nothing is changed and the answer names
 * the stages that close a deal. Rethrows anything else unchanged.
 */
export async function explainClosingStages(
  tx: SqlClient,
  orgId: string,
  projectId: string,
  err: unknown,
): Promise<never> {
  if (!(err instanceof ProjectsServiceError) || err.code !== "status_not_found") throw err
  if ((await projectKind(tx, orgId, projectId)) !== "pipeline") throw err
  const closing = extractRows<{ id: string; label: string; deal_outcome: DealOutcome }>(
    await tx.execute(drizzleSql`
      SELECT id, label, deal_outcome FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
        AND deal_outcome IS NOT NULL
      ORDER BY "order" ASC
    `),
  )
  if (closing.length === 0) throw err
  const names = closing.map((s) => JSON.stringify(s.label)).join(" or ")
  throw new ProjectsServiceError(
    err.status,
    err.code,
    `This board is a pipeline: a deal closes on ${names}. Say which one; nothing was changed.`,
    {
      ...((err.details as Record<string, unknown> | undefined) ?? {}),
      closingStages: closing.map((s) => ({ id: s.id, label: s.label, outcome: s.deal_outcome })),
    },
  )
}

/**
 * A pipeline keeps at least one won and one lost stage. Called before a stage
 * is deleted or stops closing deals; refuses with `last_closing_stage`.
 */
export async function assertKeepsClosingStages(
  tx: SqlClient,
  orgId: string,
  projectId: string,
  statusId: string,
): Promise<void> {
  const rows = extractRows<{ deal_outcome: DealOutcome | null; label: string; others: number }>(
    await tx.execute(drizzleSql`
      SELECT s.deal_outcome, s.label,
             (SELECT COUNT(*)::int FROM ${projectsRel("project_statuses")} o
               WHERE o.project_id = s.project_id AND o.org_id = s.org_id
                 AND o.id <> s.id AND o.deal_outcome = s.deal_outcome) AS others
      FROM ${projectsRel("project_statuses")} s
      WHERE s.id = ${statusId}::uuid AND s.project_id = ${projectId}::uuid
        AND s.org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  const row = rows[0]
  if (!row?.deal_outcome || row.others > 0) return
  throw new ProjectsServiceError(
    409,
    "last_closing_stage",
    `${JSON.stringify(row.label)} is this pipeline's only ${row.deal_outcome} stage, and a pipeline keeps one won and one lost stage. Nothing was changed.`,
  )
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Before two tasks merge: two deals naming different companies are refused
 * (`deals_different_company`). The survivor keeps its own deal rows; the
 * source's rows are removed (its value row goes with it).
 */
export async function mergeDealRows(
  tx: SqlClient,
  orgId: string,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const rows = extractRows<{ task_id: string; company_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT task_id, company_id FROM ${projectsRel("deals")}
      WHERE task_id IN (${sourceId}::uuid, ${targetId}::uuid) AND org_id = ${orgId}::uuid
    `),
  )
  const source = rows.find((r) => r.task_id === sourceId)
  const target = rows.find((r) => r.task_id === targetId)
  if (!source) return
  if (target && source.company_id && target.company_id && source.company_id !== target.company_id) {
    throw new ProjectsServiceError(
      409,
      "deals_different_company",
      "These two deals name different companies, so they are not merged. Nothing was changed.",
    )
  }
  await tx.execute(drizzleSql`
    DELETE FROM ${projectsRel("deals")}
    WHERE task_id = ${sourceId}::uuid AND org_id = ${orgId}::uuid
  `)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface DealValue {
  amountMinor: number | null
  currency: string | null
  amountPeriod: "once" | "month" | "year"
  probability: number | null
}

export interface DealRow {
  taskId: string
  projectId: string
  title: string
  statusId: string
  assigneeId: string | null
  companyId: string | null
  contactId: string | null
  outcome: DealOutcome
  nextStep: string | null
  lostReason: string | null
  closedAt: string | null
  closedBy: string | null
  /** Null when the reader has no deal access (the value row is not visible). */
  value: DealValue | null
}

export interface ListDealsFilter {
  taskId?: string
  projectId?: string
  companyId?: string
  contactId?: string
  outcome?: DealOutcome
  limit?: number
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

/**
 * The deals the reader can see, live tasks only: a deleted (archived) deal is
 * left out until it is restored. The value is read under the reader's own
 * access and is null without it.
 */
export async function listDeals(
  tx: SqlClient,
  orgId: string,
  filter: ListDealsFilter = {},
): Promise<DealRow[]> {
  const conds: SQL[] = [drizzleSql`d.org_id = ${orgId}::uuid`, drizzleSql`t.archived_at IS NULL`]
  if (filter.taskId) conds.push(drizzleSql`d.task_id = ${filter.taskId}::uuid`)
  if (filter.projectId) conds.push(drizzleSql`t.project_id = ${filter.projectId}::uuid`)
  if (filter.companyId) conds.push(drizzleSql`d.company_id = ${filter.companyId}::uuid`)
  if (filter.contactId) conds.push(drizzleSql`d.contact_id = ${filter.contactId}::uuid`)
  if (filter.outcome) conds.push(drizzleSql`d.outcome = ${filter.outcome}`)
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const rows = extractRows<{
    task_id: string
    project_id: string
    title: string
    status_id: string
    assignee_id: string | null
    company_id: string | null
    contact_id: string | null
    outcome: DealOutcome
    next_step: string | null
    lost_reason: string | null
    closed_at: Date | string | null
    closed_by: string | null
    has_value: boolean
    amount_minor: string | number | null
    currency: string | null
    amount_period: "once" | "month" | "year" | null
    probability: number | null
  }>(
    await tx.execute(drizzleSql`
      SELECT d.task_id, t.project_id, t.title, t.status_id, t.assignee_id,
             d.company_id, d.contact_id, d.outcome, d.next_step, d.lost_reason,
             d.closed_at, d.closed_by,
             (v.task_id IS NOT NULL) AS has_value,
             v.amount_minor, v.currency, v.amount_period, v.probability
      FROM ${projectsRel("deals")} d
      JOIN ${projectsRel("tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      LEFT JOIN ${projectsRel("deal_values")} v ON v.task_id = d.task_id AND v.org_id = d.org_id
      WHERE ${drizzleSql.join(conds, drizzleSql` AND `)}
        AND p.archived_at IS NULL
      ORDER BY t.updated_at DESC, d.task_id
      LIMIT ${limit}
    `),
  )
  return rows.map((r) => ({
    taskId: r.task_id,
    projectId: r.project_id,
    title: r.title,
    statusId: r.status_id,
    assigneeId: r.assignee_id,
    companyId: r.company_id,
    contactId: r.contact_id,
    outcome: r.outcome,
    nextStep: r.next_step,
    lostReason: r.lost_reason,
    closedAt: iso(r.closed_at),
    closedBy: r.closed_by,
    value: r.has_value
      ? {
          amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
          currency: r.currency,
          amountPeriod: r.amount_period ?? "once",
          probability: r.probability,
        }
      : null,
  }))
}

// ---------------------------------------------------------------------------
// Setting an outcome directly (a "Mark won" card action, the deal update tool)
// ---------------------------------------------------------------------------

export interface SetDealOutcomeArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  taskId: string
  outcome: DealOutcome
  reason?: string | null
}

export interface SetDealOutcomeResult {
  taskId: string
  outcome: DealOutcome
  statusId: string
  closedAt: string | null
  /** False when the deal already had this outcome: nothing was written. */
  changed: boolean
}

/**
 * Close or reopen a deal by moving its task: `won` and `lost` move it to the
 * pipeline's first stage with that outcome, `open` back to the stage it was
 * closed from, else the last open stage. The move writes the outcome through
 * {@link syncDealOutcome}, like a drag on the board. The same outcome twice is
 * a no-op.
 */
export async function setDealOutcome(args: SetDealOutcomeArgs): Promise<SetDealOutcomeResult> {
  const { tx, orgId, actor, taskId, outcome } = args
  return tx.transaction(async (innerTx) => {
    const deals = await listDeals(innerTx, orgId, { taskId })
    const deal = deals[0]
    if (!deal) {
      throw new ProjectsServiceError(404, "deal_not_found", "No live deal has this task id.")
    }
    if (deal.outcome === outcome) {
      return {
        taskId,
        outcome,
        statusId: deal.statusId,
        closedAt: deal.closedAt,
        changed: false,
      }
    }
    const target =
      outcome === "open"
        ? extractRows<{ id: string }>(
            await innerTx.execute(drizzleSql`
              SELECT s.id FROM ${projectsRel("project_statuses")} s
              LEFT JOIN ${projectsRel("deals")} d ON d.task_id = ${taskId}::uuid AND d.org_id = s.org_id
              WHERE s.project_id = ${deal.projectId}::uuid AND s.org_id = ${orgId}::uuid
                AND NOT s.terminal
              ORDER BY COALESCE(s.id = d.reopen_status_id, false) DESC, s."order" DESC
              LIMIT 1
            `),
          )[0]
        : extractRows<{ id: string }>(
            await innerTx.execute(drizzleSql`
              SELECT id FROM ${projectsRel("project_statuses")}
              WHERE project_id = ${deal.projectId}::uuid AND org_id = ${orgId}::uuid
                AND deal_outcome = ${outcome}
              ORDER BY "order" ASC
              LIMIT 1
            `),
          )[0]
    if (!target) {
      throw new ProjectsServiceError(
        409,
        "no_stage_for_outcome",
        outcome === "open"
          ? "This pipeline has no open stage to reopen the deal to. Nothing was changed."
          : `This pipeline has no ${outcome} stage. Nothing was changed.`,
      )
    }
    const { moveTask } = await import("./move-task")
    await moveTask({
      tx: innerTx as RlsClient,
      orgId,
      actor,
      taskId,
      statusId: target.id,
      lostReason: args.reason ?? null,
    })
    const after = (await listDeals(innerTx, orgId, { taskId }))[0]!
    return {
      taskId,
      outcome: after.outcome,
      statusId: after.statusId,
      closedAt: after.closedAt,
      changed: true,
    }
  })
}

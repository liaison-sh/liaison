// SPDX-License-Identifier: FSL-1.1-ALv2
// The projects sweep. Once a day it heals what a lost after-commit write could
// leave behind: each org's time and budgets row is recomputed from its
// projects' switches (`syncTimeBudgetsFeature`), and time rows whose task moved
// follow it to its project. It reads only the projects' switch state and the
// task each time row belongs to, never anyone's activity, and tells no one.
// Every hour it also tidies reconcile state it stored itself: a proposal nobody touched for
// 30 days is deleted with the cards it drew, and claims follow the key their reconciliation's
// draft got (billed on issue, credited on a full credit, released only when no document carries
// the key). It reads no trace.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { clearToolCardsByKeyIn } from "~/modules/agent/runtime/tool-card-store"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"
import { releaseReconciliation } from "./claims"
import { syncTimeBudgetsFeature, TIME_FEATURE } from "./time-feature"

const log = rootLogger.child({ module: "projects/reconcile-sweep" })

/** The UTC hour of the day the hourly sweep also heals. */
export const HEAL_HOUR_UTC = 4

/**
 * Recompute the time and budgets row of every org that has one or has a project with the
 * switch on, and re-point time rows to their task's project. Answers the orgs it corrected.
 */
export async function healTimeBudgets(): Promise<{
  checked: number
  corrected: string[]
  rowsRepointed: number
}> {
  const { orgIds, rowsRepointed } = await sweepSkippingMoving((notMoving) =>
    withSystemDb("projects-reconcile-sweep", async (tx) => {
      const orgs = extractRows<{ org_id: string }>(
        await tx.execute(drizzleSql`
          SELECT DISTINCT org_id::text AS org_id FROM (
            SELECT org_id FROM ${projectsRel("projects")} WHERE time_budgets_on
            UNION
            SELECT org_id FROM ${drizzleSql.raw(schemaRef("kernel"))}.org_app_features
             WHERE app_name = 'projects' AND feature = ${TIME_FEATURE}
          ) o WHERE ${notMoving(drizzleSql.raw("o.org_id"))}`),
      )
      const moved = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${projectsRel("task_time")} tt SET project_id = t.project_id, updated_at = now()
            FROM ${projectsRel("tasks")} t
           WHERE t.id = tt.task_id AND t.org_id = tt.org_id AND tt.project_id <> t.project_id
             AND ${notMoving(drizzleSql.raw("tt.org_id"))}
          RETURNING tt.id::text AS id`),
      )
      return { orgIds: orgs.map((o) => o.org_id), rowsRepointed: moved.length }
    }),
  )
  const corrected: string[] = []
  for (const orgId of orgIds) {
    const result = await writeUnlessMoving(orgId, () =>
      syncTimeBudgetsFeature(orgId, null, { pool: "jobs" }),
    )
    if (result !== SKIPPED_MOVING && result.changed) {
      corrected.push(orgId)
      log.warn(
        { orgId, enabled: result.enabled },
        "time and budgets org row corrected by the sweep",
      )
    }
  }
  return { checked: orgIds.length, corrected, rowsRepointed }
}

/** A proposal untouched this many days is housekeeping: it holds labels from someone's reads. */
export const IDLE_PROPOSAL_DAYS = 30
/** A reservation with no document after this many hours is released. */
export const RESERVATION_HOLD_HOURS = 1
/** Document states in which a reserved claim is billed. */
export const ISSUED_STATES = ["issued", "paid", "overdue"] as const

/** The moment before which an untouched proposal is idle. */
export function idleCutoff(now: Date): string {
  return new Date(now.getTime() - IDLE_PROPOSAL_DAYS * 86_400_000).toISOString()
}

interface IdleSweepHooks {
  /** Runs in each org's write before its cards are cleared (a test makes one org fail here). */
  beforeClear?: (orgId: string) => void
}

/**
 * One org's idle proposals: their cards are cleared in every thread that stored one, and the
 * rows are deleted, in one write. A move that began since the sweep's first read skips the org
 * whole (`"skipped"`), so the rows stay to be found again with their cards.
 */
export async function sweepOrgIdleProposals(
  orgId: string,
  cutoff: string,
  hooks: IdleSweepHooks = {},
): Promise<{ deleted: number; cardsCleared: number } | "skipped"> {
  const out = await writeUnlessMoving(orgId, () =>
    withSystemDb("projects-reconcile-sweep", async (tx) => {
      const idle = extractRows<{ id: string; created_by: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, created_by::text AS created_by
            FROM ${projectsRel("reconciliations")}
           WHERE org_id = ${orgId}::uuid AND state = 'proposed'
             AND updated_at < ${cutoff}::timestamptz
           FOR UPDATE`),
      )
      if (idle.length === 0) return { deleted: 0, cardsCleared: 0 }
      hooks.beforeClear?.(orgId)
      let cardsCleared = 0
      for (const r of idle) {
        cardsCleared += await clearToolCardsByKeyIn(tx, {
          orgId,
          actorId: r.created_by,
          app: "projects",
          key: `reconcile:${r.id}`,
        })
      }
      const deleted = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          DELETE FROM ${projectsRel("reconciliations")}
           WHERE org_id = ${orgId}::uuid AND id IN (${drizzleSql.join(
             idle.map((r) => drizzleSql`${r.id}::uuid`),
             drizzleSql`, `,
           )})
          RETURNING id::text AS id`),
      ).length
      return { deleted, cardsCleared }
    }),
  )
  return out === SKIPPED_MOVING ? "skipped" : out
}

/**
 * Delete every proposed reconciliation untouched for 30 days with the cards it drew, in every
 * thread, so no proof label outlives it. A card that left `proposed` is never touched. Each org
 * is its own write: one that fails or starts moving is left for the next run, and the others
 * are still swept.
 */
export async function sweepIdleProposals(
  now: Date = new Date(),
  hooks: IdleSweepHooks = {},
): Promise<{ deleted: number; cardsCleared: number; failedOrgs: number }> {
  const cutoff = idleCutoff(now)
  const orgIds = await sweepSkippingMoving((notMoving) =>
    withSystemDb("projects-reconcile-sweep", async (tx) =>
      extractRows<{ org_id: string }>(
        await tx.execute(drizzleSql`
          SELECT DISTINCT org_id::text AS org_id FROM ${projectsRel("reconciliations")}
           WHERE state = 'proposed' AND updated_at < ${cutoff}::timestamptz
             AND ${notMoving(drizzleSql.raw("org_id"))}`),
      ).map((r) => r.org_id),
    ),
  )
  let deleted = 0
  let cardsCleared = 0
  let failedOrgs = 0
  for (const orgId of orgIds) {
    try {
      const out = await sweepOrgIdleProposals(orgId, cutoff, hooks)
      if (out === "skipped") continue
      deleted += out.deleted
      cardsCleared += out.cardsCleared
    } catch (err) {
      failedOrgs++
      log.warn({ err, orgId }, "idle reconcile proposals left for the next sweep")
    }
  }
  return { deleted, cardsCleared, failedOrgs }
}

/** The invoicing documents table, or null where the app was never installed. */
async function documentsTable(tx: {
  execute: (q: ReturnType<typeof drizzleSql>) => Promise<unknown>
}): Promise<string | null> {
  const docs = `${schemaRef("app_invoicing")}.documents`
  const present = extractRows<{ present: boolean }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${docs}) IS NOT NULL AS present`),
  )[0]?.present
  return present ? docs : null
}

/** A document carrying a reconciliation's key, with what credit notes took back from it. */
export interface RefDocument {
  id: string
  number: string | null
  status: string
  grandTotalMinor: bigint
  creditedMinor: bigint
}

/** Credit notes that count against an invoice: any but a draft or one that never went out. */
const CREDIT_COUNTS = drizzleSql`cn.status NOT IN ('draft', 'pending_approval', 'voided', 'cancelled')`

/**
 * Every document of the org that carries `ref` as its key, in any state, with the total its
 * credit notes took back. A system read: the claims' own writers run under the caller's rows,
 * which may not reach invoicing's tables.
 */
export async function documentsForRef(orgId: string, ref: string): Promise<RefDocument[]> {
  return withSystemDb("projects-reconcile-claims", async (tx) => {
    const docs = await documentsTable(tx)
    if (!docs) return []
    const rows = extractRows<{
      id: string
      number: string | null
      status: string
      grand: string | number | null
      credited: string | number | null
    }>(
      await tx.execute(drizzleSql`
        SELECT d.id::text AS id, d.number, d.status, d.grand_total_minor::text AS grand,
               (SELECT coalesce(sum(abs(cn.grand_total_minor)), 0)::text
                  FROM ${drizzleSql.raw(docs)} cn
                 WHERE cn.org_id = d.org_id AND cn.type = 'credit_note'
                   AND cn.original_document_id = d.id AND ${CREDIT_COUNTS}) AS credited
          FROM ${drizzleSql.raw(docs)} d
         WHERE d.org_id = ${orgId}::uuid AND d.external_ref = ${ref}
           AND d.type <> 'credit_note'`),
    )
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      grandTotalMinor: BigInt(r.grand ?? 0),
      creditedMinor: BigInt(r.credited ?? 0),
    }))
  })
}

/**
 * Claims follow their reconciliation's key, in one write and in this order:
 * 1. a reserved claim is billed once an issued invoice carries the key (a draft never flips it);
 * 2. a drafted reconciliation whose invoice is issued is invoiced;
 * 3. an invoice credit notes took back whole frees its claims (credited) and its reconciliation;
 * 4. a reservation an hour old is released only when no document carries the key in any state,
 *    with its reconciliation's left-off claims, and a drafted reconciliation is proposed again.
 */
export async function sweepClaims(): Promise<{
  billed: number
  invoiced: number
  credited: number
  released: number
}> {
  return sweepSkippingMoving((notMoving) =>
    withSystemDb("projects-reconcile-sweep", async (tx) => {
      const docs = await documentsTable(tx)
      const issued = drizzleSql.join(
        ISSUED_STATES.map((st) => drizzleSql`${st}`),
        drizzleSql`, `,
      )
      let billed = 0
      let invoiced = 0
      let credited = 0
      if (docs) {
        const D = drizzleSql.raw(docs)
        billed = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            UPDATE ${projectsRel("billing_claims")} c
               SET state = 'billed', document_id = d.id, document_number = d.number,
                   updated_at = now()
              FROM ${projectsRel("reconciliations")} r, ${D} d
             WHERE c.state = 'reserved' AND r.id = c.reconciliation_id AND r.org_id = c.org_id
               AND d.org_id = r.org_id AND d.external_ref = r.document_ref
               AND d.type <> 'credit_note' AND d.status IN (${issued})
               AND ${notMoving(drizzleSql.raw("c.org_id"))}
            RETURNING c.id::text AS id`),
        ).length
        invoiced = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            UPDATE ${projectsRel("reconciliations")} r
               SET state = 'invoiced', document_id = d.id, updated_at = now()
              FROM ${D} d
             WHERE r.state = 'drafted' AND d.org_id = r.org_id AND d.external_ref = r.document_ref
               AND d.type <> 'credit_note' AND d.status IN (${issued})
               AND ${notMoving(drizzleSql.raw("r.org_id"))}
            RETURNING r.id::text AS id`),
        ).length
        const whole = extractRows<{ id: string; org_id: string; doc: string }>(
          await tx.execute(drizzleSql`
            SELECT r.id::text AS id, r.org_id::text AS org_id, d.id::text AS doc
              FROM ${projectsRel("reconciliations")} r
              JOIN ${D} d ON d.org_id = r.org_id AND d.external_ref = r.document_ref
               AND d.type <> 'credit_note'
             WHERE r.state IN ('drafted', 'invoiced')
               AND d.status NOT IN ('draft', 'pending_approval')
               AND abs(d.grand_total_minor) > 0
               AND (SELECT coalesce(sum(abs(cn.grand_total_minor)), 0) FROM ${D} cn
                     WHERE cn.org_id = d.org_id AND cn.type = 'credit_note'
                       AND cn.original_document_id = d.id AND ${CREDIT_COUNTS})
                   >= abs(d.grand_total_minor)
               AND ${notMoving(drizzleSql.raw("r.org_id"))}`),
        )
        for (const w of whole) {
          credited += extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
              UPDATE ${projectsRel("billing_claims")}
                 SET state = 'credited', document_id = ${w.doc}::uuid, updated_at = now()
               WHERE org_id = ${w.org_id}::uuid AND reconciliation_id = ${w.id}::uuid
                 AND state IN ('reserved', 'billed')
              RETURNING id::text AS id`),
          ).length
          await tx.execute(drizzleSql`
            UPDATE ${projectsRel("reconciliations")}
               SET state = 'credited', document_id = ${w.doc}::uuid, updated_at = now()
             WHERE id = ${w.id}::uuid AND org_id = ${w.org_id}::uuid
               AND state IN ('drafted', 'invoiced')`)
        }
      }
      const carried = docs
        ? drizzleSql`EXISTS (
            SELECT 1 FROM ${projectsRel("reconciliations")} r
              JOIN ${drizzleSql.raw(docs)} d ON d.org_id = r.org_id AND d.external_ref = r.document_ref
             WHERE r.id = c.reconciliation_id AND r.org_id = c.org_id)`
        : drizzleSql`false`
      const freed = extractRows<{ reconciliation_id: string | null; org_id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${projectsRel("billing_claims")} c SET state = 'released', updated_at = now()
           WHERE c.state = 'reserved'
             AND c.created_at < now() - make_interval(hours => ${RESERVATION_HOLD_HOURS})
             AND NOT ${carried}
             AND ${notMoving(drizzleSql.raw("c.org_id"))}
          RETURNING c.reconciliation_id::text AS reconciliation_id, c.org_id::text AS org_id`),
      )
      const touched = new Map<string, string>()
      for (const f of freed) if (f.reconciliation_id) touched.set(f.reconciliation_id, f.org_id)
      for (const [id, org] of touched) {
        const out = await releaseReconciliation(tx as never, { orgId: org, reconciliationId: id })
        if (out.state === "drafted") {
          // A newer proposal of the same person and period holds the proposed slot: this one,
          // with no claim and no document left, would only block a later bill.
          await tx.execute(drizzleSql`
            DELETE FROM ${projectsRel("reconciliations")}
             WHERE id = ${id}::uuid AND org_id = ${org}::uuid AND state = 'drafted'`)
        }
      }
      return { billed, invoiced, credited, released: freed.length }
    }),
  )
}

/** One run of the hourly sweep: reconcile housekeeping every hour, the heal at its hour. */
export async function runReconcileSweep(now: Date = new Date()): Promise<void> {
  log.info(
    { ...(await sweepIdleProposals(now)), ...(await sweepClaims()) },
    "projects_reconcile_sweep",
  )
  if (now.getUTCHours() !== HEAL_HOUR_UTC) return
  log.info(await healTimeBudgets(), "projects_reconcile_sweep_heal")
}

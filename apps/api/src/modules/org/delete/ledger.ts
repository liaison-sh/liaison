// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org deletion ledger, `kernel.org_deletions` (migration 0236): one row per
// operator deletion, written before the org is marked deleting and updated
// after every step. It is how a crashed deletion is resumed (by the org id,
// also after the org row is gone) and the instance's record of every org it
// deleted, waivers included. It survives the purge: the org is
// `deleted_org_id`, never an `org_id` column (modules/org/purge/rows.ts).
//
// Statuses: started (the CLI wrote it) → queued (the purge job was handed to
// the server) → running (a job run holds it, `run_id`, heartbeat on
// `updated_at`) → completed | failed (a re-run resumes it) | aborted
// (`--abort` before the purge began).
import crypto from "node:crypto"
import { and, desc, sql as drizzleSql, eq, isNull, notInArray } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import {
  type OrgDeletionExport,
  type OrgDeletionRow,
  type OrgDeletionWaiver,
  organizations,
  orgDeletions,
} from "~/db/schema/kernel"

/** The step a job run records when the destructive part begins; `--abort` is refused after it. */
export const PURGE_STARTED_STEP = "purge"

/** A running row whose heartbeat is older than this may be taken over by a new run. */
export const ORG_DELETION_STALE_MS = 2 * 60_000

const CLOSED = ["completed", "aborted"] as const

export interface NewOrgDeletion {
  orgId: string
  slug: string
  name: string
  operator: string
  waivers: OrgDeletionWaiver[]
  export: OrgDeletionExport | null
  legalArchiveRecipient: string | null
}

/** Thrown when another deletion of the org is still open. */
export class OrgDeletionOpenError extends Error {
  constructor(readonly orgId: string) {
    super(`a deletion of org ${orgId} is already open`)
    this.name = "OrgDeletionOpenError"
  }
}

/** Write the ledger row (status `started`). */
export async function createOrgDeletion(input: NewOrgDeletion): Promise<OrgDeletionRow> {
  try {
    const [row] = await withSystemDb("org-delete-ledger-create", (tx) =>
      tx
        .insert(orgDeletions)
        .values({
          deletedOrgId: input.orgId,
          orgSlug: input.slug,
          orgName: input.name,
          operator: input.operator,
          waivers: input.waivers,
          export: input.export,
          legalArchiveRecipient: input.legalArchiveRecipient,
        })
        .returning(),
    )
    if (!row) throw new Error("org deletion ledger insert returned no row")
    return row
  } catch (err) {
    const code =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
    if (code === "23505") throw new OrgDeletionOpenError(input.orgId)
    throw err
  }
}

export async function getOrgDeletion(id: string): Promise<OrgDeletionRow | null> {
  const [row] = await withSystemDb("org-delete-ledger-get", (tx) =>
    tx.select().from(orgDeletions).where(eq(orgDeletions.id, id)),
  )
  return row ?? null
}

/** The org's open deletion (not completed, not aborted), by org id. */
export async function findOpenOrgDeletion(orgId: string): Promise<OrgDeletionRow | null> {
  const [row] = await withSystemDb("org-delete-ledger-open", (tx) =>
    tx
      .select()
      .from(orgDeletions)
      .where(
        and(eq(orgDeletions.deletedOrgId, orgId), notInArray(orgDeletions.status, [...CLOSED])),
      ),
  )
  return row ?? null
}

/** The latest open deletion of an org slug (the org row may be gone). */
export async function findOpenOrgDeletionBySlug(slug: string): Promise<OrgDeletionRow | null> {
  const [row] = await withSystemDb("org-delete-ledger-open-slug", (tx) =>
    tx
      .select()
      .from(orgDeletions)
      .where(and(eq(orgDeletions.orgSlug, slug), notInArray(orgDeletions.status, [...CLOSED])))
      .orderBy(desc(orgDeletions.createdAt))
      .limit(1),
  )
  return row ?? null
}

/** Append a step (once) and merge `counts`. With `runId`, only while that run holds the row. */
export async function recordOrgDeletionStep(
  id: string,
  step: string,
  opts: { runId?: string; counts?: Record<string, unknown> } = {},
): Promise<boolean> {
  const rows = await withSystemDb("org-delete-ledger-step", (tx) =>
    tx
      .update(orgDeletions)
      .set({
        stepsDone: drizzleSql`CASE WHEN ${step} = ANY(${orgDeletions.stepsDone}) THEN ${orgDeletions.stepsDone} ELSE array_append(${orgDeletions.stepsDone}, ${step}::text) END`,
        ...(opts.counts
          ? {
              counts: drizzleSql`COALESCE(${orgDeletions.counts}, '{}'::jsonb) || ${JSON.stringify(opts.counts)}::jsonb`,
            }
          : {}),
        updatedAt: drizzleSql`now()`,
      })
      .where(
        opts.runId
          ? and(
              eq(orgDeletions.id, id),
              eq(orgDeletions.runId, opts.runId),
              eq(orgDeletions.status, "running"),
            )
          : eq(orgDeletions.id, id),
      )
      .returning({ id: orgDeletions.id }),
  )
  return rows.length > 0
}

/** `started` / `failed` → `queued`, before the job is handed to the server. */
export async function markOrgDeletionQueued(id: string): Promise<boolean> {
  const rows = await withSystemDb("org-delete-ledger-queued", (tx) =>
    tx
      .update(orgDeletions)
      .set({ status: "queued", error: null, updatedAt: drizzleSql`now()` })
      .where(
        and(
          eq(orgDeletions.id, id),
          drizzleSql`${orgDeletions.status} IN ('started', 'failed', 'queued')`,
        ),
      )
      .returning({ id: orgDeletions.id }),
  )
  return rows.length > 0
}

/**
 * Claim the row for one job run: from queued or failed, or from a running row
 * whose heartbeat stopped. Returns the run token and the row, or null.
 */
export async function claimOrgDeletion(
  id: string,
): Promise<{ runId: string; row: OrgDeletionRow } | null> {
  const runId = crypto.randomUUID()
  const staleBefore = new Date(Date.now() - ORG_DELETION_STALE_MS).toISOString()
  const [row] = await withSystemDb("org-delete-ledger-claim", (tx) =>
    tx
      .update(orgDeletions)
      .set({ status: "running", runId, error: null, updatedAt: drizzleSql`now()` })
      .where(
        and(
          eq(orgDeletions.id, id),
          drizzleSql`(${orgDeletions.status} IN ('started', 'queued', 'failed')
            OR (${orgDeletions.status} = 'running' AND ${orgDeletions.updatedAt} < ${staleBefore}::timestamptz))`,
        ),
      )
      .returning(),
  )
  return row ? { runId, row } : null
}

/** The run's heartbeat; false when the run no longer holds the row. */
export async function heartbeatOrgDeletion(id: string, runId: string): Promise<boolean> {
  const rows = await withSystemDb("org-delete-ledger-heartbeat", (tx) =>
    tx
      .update(orgDeletions)
      .set({ updatedAt: drizzleSql`now()` })
      .where(
        and(
          eq(orgDeletions.id, id),
          eq(orgDeletions.runId, runId),
          eq(orgDeletions.status, "running"),
        ),
      )
      .returning({ id: orgDeletions.id }),
  )
  return rows.length > 0
}

/**
 * Record the purge's start, atomically with the check that the run still holds
 * the row (an `--abort` that won the race leaves it `aborted`). Idempotent: a
 * re-run that finds the step recorded gets true.
 */
export async function claimPurgeStart(id: string, runId: string): Promise<boolean> {
  return recordOrgDeletionStep(id, PURGE_STARTED_STEP, { runId })
}

/** The run's outcome. Only while the run holds the row. */
export async function finishOrgDeletion(
  id: string,
  runId: string,
  outcome:
    | { status: "completed"; counts: Record<string, unknown> }
    | { status: "failed"; error: string },
): Promise<boolean> {
  const rows = await withSystemDb("org-delete-ledger-finish", (tx) =>
    tx
      .update(orgDeletions)
      .set(
        outcome.status === "completed"
          ? {
              status: "completed",
              counts: drizzleSql`COALESCE(${orgDeletions.counts}, '{}'::jsonb) || ${JSON.stringify(outcome.counts)}::jsonb`,
              completedAt: drizzleSql`now()`,
              updatedAt: drizzleSql`now()`,
            }
          : { status: "failed", error: outcome.error.slice(0, 4000), updatedAt: drizzleSql`now()` },
      )
      .where(
        and(
          eq(orgDeletions.id, id),
          eq(orgDeletions.runId, runId),
          eq(orgDeletions.status, "running"),
        ),
      )
      .returning({ id: orgDeletions.id }),
  )
  return rows.length > 0
}

/** A failure outside a job run (the queue refused the job). */
export async function failOrgDeletion(id: string, error: string): Promise<void> {
  await withSystemDb("org-delete-ledger-fail", (tx) =>
    tx
      .update(orgDeletions)
      .set({ status: "failed", error: error.slice(0, 4000), updatedAt: drizzleSql`now()` })
      .where(and(eq(orgDeletions.id, id), notInArray(orgDeletions.status, [...CLOSED]))),
  )
}

/**
 * Step 1 as a job run does it: record `step` and mark the org deleting in one
 * transaction, only while `runId` holds the deletion. An `--abort` takes the
 * same ledger row lock first and clears the mark in its own transaction, so the
 * two serialize: either the abort sees the mark and clears it, or the run sees
 * the abort and marks nothing. False when the run lost the deletion.
 */
export async function markOrgDeletingForRun(
  id: string,
  runId: string,
  orgId: string,
  step: string,
): Promise<boolean> {
  return withSystemDb("org-delete-ledger-mark", async (tx) => {
    const held = await tx
      .update(orgDeletions)
      .set({
        stepsDone: drizzleSql`CASE WHEN ${step} = ANY(${orgDeletions.stepsDone}) THEN ${orgDeletions.stepsDone} ELSE array_append(${orgDeletions.stepsDone}, ${step}::text) END`,
        updatedAt: drizzleSql`now()`,
      })
      .where(
        and(
          eq(orgDeletions.id, id),
          eq(orgDeletions.runId, runId),
          eq(orgDeletions.status, "running"),
        ),
      )
      .returning({ id: orgDeletions.id })
    if (held.length === 0) return false
    await tx
      .update(organizations)
      .set({ deletingAt: drizzleSql`now()` })
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletingAt)))
    return true
  })
}

/**
 * `--abort`: close the deletion as aborted, only while the purge has not
 * started, and clear the org's deleting mark in the same transaction (see
 * `markOrgDeletingForRun`). Returns the closed row, or null when the purge
 * already began (or the row is closed).
 */
export async function abortOrgDeletion(id: string): Promise<OrgDeletionRow | null> {
  return withSystemDb("org-delete-ledger-abort", async (tx) => {
    const [row] = await tx
      .update(orgDeletions)
      .set({
        status: "aborted",
        completedAt: drizzleSql`now()`,
        updatedAt: drizzleSql`now()`,
      })
      .where(
        and(
          eq(orgDeletions.id, id),
          notInArray(orgDeletions.status, [...CLOSED]),
          drizzleSql`NOT (${PURGE_STARTED_STEP} = ANY(${orgDeletions.stepsDone}))`,
        ),
      )
      .returning()
    if (!row) return null
    await tx
      .update(organizations)
      .set({ deletingAt: null })
      .where(eq(organizations.id, row.deletedOrgId))
    return row
  })
}

/** The ledger line printed as JSON (S2.8). */
export function ledgerLine(row: OrgDeletionRow): Record<string, unknown> {
  return {
    deletionId: row.id,
    orgId: row.deletedOrgId,
    slug: row.orgSlug,
    operator: row.operator,
    status: row.status,
    stepsDone: row.stepsDone,
    waivers: row.waivers,
    export: row.export,
    archiveKey: row.archiveKey,
    counts: row.counts,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  }
}

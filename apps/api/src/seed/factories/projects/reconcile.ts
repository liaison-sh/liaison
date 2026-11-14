// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reconcile factory: a stored reconciliation and a billing claim as they look after some
// time has passed, for the housekeeping that acts on age. A person's reconcile card is drawn by
// reconcile_propose; what this writes is the row an old card left behind (an idle proposal, a
// reservation an hour old), which no tool can produce on demand. Rows go in through the one app
// table writer, under the schema prefix.
import { withPrivilegedDb } from "~/db/privileged"
import { type AppCell, upsertAppRow } from "~/seed/factories/app-tables"

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString()
const DAY_MS = 86_400_000

/** A bare project row: a key and an owner, for a test that needs a project and nothing on it. */
export async function seedBareProject(
  orgId: string,
  input: { name: string; key: string; ownerId: string },
): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(orgId, "seed-reconcile:project", (tx) =>
    upsertAppRow(tx, "projects", "projects", {
      id,
      org_id: orgId,
      name: input.name,
      key: input.key,
      owner_id: input.ownerId,
    }),
  )
  return id
}

/** A reconciliation in `state`, last changed `idleDays` ago, for one month (`YYYY-MM`). */
export async function seedReconciliation(
  orgId: string,
  input: {
    projectId: string
    createdBy: string
    threadId: string
    state: "proposed" | "drafted" | "invoiced" | "credited"
    month: string
    idleDays: number
    basis?: string
    /** The key its draft invoice got at Create. */
    documentRef?: string
    /** The first day of the period, when it is not the month's first. */
    periodStart?: string
    /** The instant ages count back from. */
    now: Date
  },
): Promise<string> {
  const id = crypto.randomUUID()
  const row: Record<string, AppCell> & { id: string; org_id: string } = {
    id,
    org_id: orgId,
    project_id: input.projectId,
    period_start: input.periodStart ?? `${input.month}-01`,
    period_end: `${input.month}-28`,
    basis: input.basis ?? "daily",
    state: input.state,
    created_by: input.createdBy,
    thread_id: input.threadId,
    updated_at: ago(input.now, input.idleDays * DAY_MS),
    ...(input.documentRef ? { document_ref: input.documentRef } : {}),
  }
  await withPrivilegedDb(orgId, "seed-reconcile:reconciliation", (tx) =>
    upsertAppRow(tx, "projects", "reconciliations", row),
  )
  return id
}

/** One line of a stored reconciliation, with its tasks, its bill and its proofs. */
export async function seedReconciliationLine(
  orgId: string,
  input: {
    reconciliationId: string
    position: number
    name: string
    taskIds: string[]
    billMinutes: number
    realMinutes?: number
    realNoteMinutes?: number
    traceEstimateMinutes?: number
    proofs?: Array<{ kind: string; ref: string; label: string }>
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(orgId, "seed-reconcile:line", async (tx) => {
    await upsertAppRow(tx, "projects", "reconciliation_lines", {
      id,
      org_id: orgId,
      reconciliation_id: input.reconciliationId,
      position: input.position,
      name: input.name,
      kind: "planned",
      task_ids: `{${input.taskIds.join(",")}}`,
      real_minutes: input.realMinutes ?? null,
      real_note_minutes: input.realNoteMinutes ?? null,
      trace_estimate_minutes: input.traceEstimateMinutes ?? null,
      bill_minutes: input.billMinutes,
    })
    for (const p of input.proofs ?? []) {
      await upsertAppRow(tx, "projects", "reconciliation_proofs", {
        id: crypto.randomUUID(),
        org_id: orgId,
        line_id: id,
        kind: p.kind,
        ref: p.ref,
        label: p.label,
      })
    }
  })
  return id
}

/** A claim on one task for a period, made `ageMinutes` ago. */
export async function seedBillingClaim(
  orgId: string,
  input: {
    projectId: string
    sourceRef: string
    periodKey: string
    state: "reserved" | "billed" | "released" | "left_off"
    ageMinutes: number
    /** The reconciliation that reserved it. */
    reconciliationId?: string
    /** The instant ages count back from. */
    now: Date
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(orgId, "seed-reconcile:claim", (tx) =>
    upsertAppRow(tx, "projects", "billing_claims", {
      id,
      org_id: orgId,
      project_id: input.projectId,
      source_kind: "task",
      source_ref: input.sourceRef,
      period_key: input.periodKey,
      state: input.state,
      created_at: ago(input.now, input.ageMinutes * 60_000),
      ...(input.reconciliationId ? { reconciliation_id: input.reconciliationId } : {}),
    }),
  )
  return id
}

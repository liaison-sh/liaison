// SPDX-License-Identifier: FSL-1.1-ALv2
// Billing claims: what keeps one piece of work from being billed twice.
//
// At Create a reconciliation reserves each task and proof of its billed lines (`reserveClaims`),
// and records the tasks of lines left at zero as left off. The partial unique index on live claims
// (reserved or billed) is the guard: a second reservation of the same source does nothing, and is
// answered with the document or draft that holds it. Claims then follow the draft's key, the
// `document_ref` the reconciliation stores: billed once the invoice carrying it is issued, credited
// once that invoice is fully credited, released only when no document carries the key at all.
//
// Every write here runs under the caller's own row security (`projects:reconcile:write`, or the
// widened scope of a declared cross-app call) and is compare-and-set on the state it expects, so
// the hourly sweep and `reconcile_mark` may run in either order. The one read outside the caller's
// rows is the invoicing documents read the sweep already does (`documentsForRef`).
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { worded } from "./reconcile-lines"
import { documentsForRef, ISSUED_STATES, type RefDocument } from "./reconcile-sweep"
import { ProjectsServiceError } from "./statuses"
import { type Basis, hoursPerDayMinutes, orgTimezone } from "./time-plan"

type Tx = RlsClient

/** The period a task's claim covers: the month on a retainer, the task's whole life otherwise. */
export function claimPeriodKey(basis: string, periodStart: string | null): string {
  return basis === "retainer" && periodStart ? periodStart.slice(0, 7) : "all"
}

interface ReconRow {
  id: string
  project_id: string
  project_name: string
  basis: string
  state: string
  revision: number
  period_start: string | null
  period_end: string | null
  document_ref: string | null
  document_id: string | null
}

async function readReconciliation(tx: Tx, orgId: string, id: string, lock = false) {
  const row = extractRows<ReconRow>(
    await tx.execute(drizzleSql`
      SELECT r.id::text AS id, r.project_id::text AS project_id, p.name AS project_name, r.basis,
             r.state, r.revision, r.period_start::text AS period_start,
             r.period_end::text AS period_end, r.document_ref, r.document_id::text AS document_id
        FROM ${projectsRel("reconciliations")} r
        JOIN ${projectsRel("projects")} p ON p.id = r.project_id AND p.org_id = r.org_id
       WHERE r.id = ${id}::uuid AND r.org_id = ${orgId}::uuid
       ${lock ? drizzleSql`FOR UPDATE OF r` : drizzleSql``}`),
  )[0]
  if (!row) {
    throw new ProjectsServiceError(
      404,
      "not_found",
      `No reconciliation ${id} you can read. Nothing was changed.`,
    )
  }
  return row
}

interface Source {
  lineId: string
  kind: string
  ref: string
  periodKey: string
  label: string
}

/** The sources a reconciliation bills, and the tasks of the lines it leaves at zero. */
async function sourcesOf(
  tx: Tx,
  orgId: string,
  r: ReconRow,
): Promise<{ billed: Source[]; leftOff: Source[] }> {
  const lines = extractRows<{
    id: string
    name: string | null
    bill_minutes: number
    task_ids: string[] | string
    other_project_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, coalesce(wording, name) AS name, bill_minutes,
             task_ids::text[] AS task_ids, other_project_id::text AS other_project_id
        FROM ${projectsRel("reconciliation_lines")}
       WHERE reconciliation_id = ${r.id}::uuid AND org_id = ${orgId}::uuid
       ORDER BY position`),
  )
  const proofs = extractRows<{ line_id: string; kind: string; ref: string; label: string }>(
    await tx.execute(drizzleSql`
      SELECT pr.line_id::text AS line_id, pr.kind, pr.ref, pr.label
        FROM ${projectsRel("reconciliation_proofs")} pr
        JOIN ${projectsRel("reconciliation_lines")} l ON l.id = pr.line_id AND l.org_id = pr.org_id
       WHERE l.reconciliation_id = ${r.id}::uuid AND pr.org_id = ${orgId}::uuid
       ORDER BY pr.created_at, pr.id`),
  )
  const taskKey = claimPeriodKey(r.basis, r.period_start)
  const billed: Source[] = []
  const leftOff: Source[] = []
  const seen = new Set<string>()
  const add = (to: Source[], s: Source) => {
    const k = `${s.kind}\u0000${s.ref}\u0000${s.periodKey}`
    if (seen.has(k)) return
    seen.add(k)
    to.push(s)
  }
  const taskIds = (raw: string[] | string): string[] =>
    Array.isArray(raw) ? raw : raw.replace(/[{}]/g, "").split(",").filter(Boolean)
  for (const l of lines) {
    if (l.bill_minutes <= 0) continue
    const tasks = taskIds(l.task_ids)
    for (const t of tasks) {
      add(billed, { lineId: l.id, kind: "task", ref: t, periodKey: taskKey, label: l.name ?? "" })
    }
    for (const p of proofs) {
      if (p.line_id !== l.id) continue
      // A task proof names a task already claimed through the line's tasks.
      if (p.kind === "task" && tasks.includes(p.ref)) continue
      add(billed, { lineId: l.id, kind: p.kind, ref: p.ref, periodKey: "all", label: p.label })
    }
  }
  // Left off: the tasks of lines at zero, on this project, that no billed line claims.
  for (const l of lines) {
    if (l.bill_minutes > 0 || l.other_project_id) continue
    for (const t of taskIds(l.task_ids)) {
      add(leftOff, { lineId: l.id, kind: "task", ref: t, periodKey: taskKey, label: l.name ?? "" })
    }
  }
  return { billed, leftOff }
}

export interface ReserveResult {
  reconciliationId: string
  documentRef: string
  reserved: number
  leftOff: number
  /** True when the reconciliation's own claims from an earlier try were reused. */
  reused: boolean
  message: string
}

/**
 * Reserve a reconciliation's sources at Create, and store the key its draft gets. A retry with
 * the same reconciliation reuses its own live claims. A source another reconciliation holds is
 * answered `already_on`, naming the invoice number or the draft, and nothing is written.
 */
export async function reserveClaims(
  tx: Tx,
  input: {
    orgId: string
    reconciliationId: string
    documentRef: string
    /** The rate, currency and hours in a day at Create, frozen on the reconciliation. */
    terms?: { rateMinor: number | null; currency: string | null; hoursPerDayMinutes: number }
  },
): Promise<ReserveResult> {
  const { orgId, reconciliationId, documentRef } = input
  const freeze = input.terms
    ? drizzleSql`, create_rate_minor = ${input.terms.rateMinor},
        create_currency = ${input.terms.currency},
        create_hours_per_day_minutes = ${input.terms.hoursPerDayMinutes}`
    : drizzleSql``
  return tx.transaction(async (sp) => {
    const r = await readReconciliation(sp as Tx, orgId, reconciliationId, true)
    if (r.state === "invoiced" || r.state === "credited") {
      throw new ProjectsServiceError(
        409,
        "reconcile_locked",
        `The reconciliation of ${r.project_name} is already ${r.state}. Nothing was reserved.`,
      )
    }
    if (r.document_ref && r.document_ref !== documentRef) {
      throw new ProjectsServiceError(
        409,
        "card_changed",
        `The reconciliation of ${r.project_name} is already on the draft keyed ${r.document_ref}. Nothing was reserved.`,
      )
    }
    const own = extractRows<{ state: string; n: number }>(
      await sp.execute(drizzleSql`
        SELECT state, count(*)::int AS n FROM ${projectsRel("billing_claims")}
         WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${reconciliationId}::uuid
           AND state IN ('reserved', 'billed', 'left_off')
         GROUP BY state`),
    )
    const count = (s: string) => own.find((o) => o.state === s)?.n ?? 0
    if (count("reserved") + count("billed") > 0) {
      await sp.execute(drizzleSql`
        UPDATE ${projectsRel("reconciliations")}
           SET document_ref = ${documentRef}, updated_at = now() ${freeze}
         WHERE id = ${reconciliationId}::uuid AND org_id = ${orgId}::uuid`)
      const reserved = count("reserved") + count("billed")
      return {
        reconciliationId,
        documentRef,
        reserved,
        leftOff: count("left_off"),
        reused: true,
        message: `The ${reserved} source${reserved === 1 ? "" : "s"} of ${r.project_name}'s reconciliation were already reserved by it; they are kept for the draft keyed ${documentRef}.`,
      }
    }
    // A fresh reservation: what an earlier, released try left off is recorded again below.
    await sp.execute(drizzleSql`
      UPDATE ${projectsRel("billing_claims")} SET state = 'released', updated_at = now()
       WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${reconciliationId}::uuid
         AND state = 'left_off'`)
    const { billed, leftOff } = await sourcesOf(sp as Tx, orgId, r)
    const lost: Source[] = []
    for (const s of billed) {
      const inserted = extractRows<{ id: string }>(
        await sp.execute(drizzleSql`
          INSERT INTO ${projectsRel("billing_claims")}
            (org_id, project_id, reconciliation_id, line_id, source_kind, source_ref, period_key, state)
          VALUES (${orgId}::uuid, ${r.project_id}::uuid, ${reconciliationId}::uuid,
            ${s.lineId}::uuid, ${s.kind}, ${s.ref}, ${s.periodKey}, 'reserved')
          ON CONFLICT (org_id, source_kind, source_ref, period_key)
            WHERE state IN ('reserved', 'billed') DO NOTHING
          RETURNING id::text AS id`),
      )
      if (inserted.length === 0) lost.push(s)
    }
    if (lost.length > 0) throw await alreadyOn(sp as Tx, orgId, lost[0]!)
    for (const s of leftOff) {
      await sp.execute(drizzleSql`
        INSERT INTO ${projectsRel("billing_claims")}
          (org_id, project_id, reconciliation_id, line_id, source_kind, source_ref, period_key, state)
        VALUES (${orgId}::uuid, ${r.project_id}::uuid, ${reconciliationId}::uuid,
          ${s.lineId}::uuid, ${s.kind}, ${s.ref}, ${s.periodKey}, 'left_off')`)
    }
    await sp.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliations")}
         SET document_ref = ${documentRef}, updated_at = now() ${freeze}
       WHERE id = ${reconciliationId}::uuid AND org_id = ${orgId}::uuid`)
    return {
      reconciliationId,
      documentRef,
      reserved: billed.length,
      leftOff: leftOff.length,
      reused: false,
      message: `Reserved ${billed.length} source${billed.length === 1 ? "" : "s"} of ${r.project_name} for the draft keyed ${documentRef}; ${leftOff.length} task${leftOff.length === 1 ? "" : "s"} left off the bill.`,
    }
  })
}

/** The refusal for a source another reconciliation holds, naming its invoice or draft. */
async function alreadyOn(tx: Tx, orgId: string, s: Source): Promise<ProjectsServiceError> {
  const holder = extractRows<{
    document_number: string | null
    state: string
    project_name: string | null
    period_start: string | null
    period_end: string | null
    task_title: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT c.document_number, c.state, p.name AS project_name,
             r.period_start::text AS period_start, r.period_end::text AS period_end,
             (SELECT t.title FROM ${projectsRel("tasks")} t
               WHERE c.source_kind = 'task' AND t.org_id = c.org_id
                 AND t.id::text = c.source_ref) AS task_title
        FROM ${projectsRel("billing_claims")} c
        LEFT JOIN ${projectsRel("reconciliations")} r ON r.id = c.reconciliation_id AND r.org_id = c.org_id
        LEFT JOIN ${projectsRel("projects")} p ON p.id = c.project_id AND p.org_id = c.org_id
       WHERE c.org_id = ${orgId}::uuid AND c.source_kind = ${s.kind} AND c.source_ref = ${s.ref}
         AND c.period_key = ${s.periodKey} AND c.state IN ('reserved', 'billed')
       LIMIT 1`),
  )[0]
  const what = holder?.task_title ? `"${holder.task_title}"` : `"${s.label || s.ref}"`
  const draft = holder
    ? `the draft invoice for ${holder.project_name ?? "another project"}${
        holder.period_start ? `, ${holder.period_start} to ${holder.period_end}` : ""
      }`
    : "another draft invoice"
  const on = holder?.document_number ? `invoice ${holder.document_number}` : draft
  return new ProjectsServiceError(
    409,
    "already_on",
    `${what} is already on ${on}. Nothing was reserved and no draft was made: take it off this card, or correct ${on} instead.`,
    {
      documentNumber: holder?.document_number ?? null,
      draft: holder?.document_number ? null : draft,
      source: { kind: s.kind, ref: s.ref },
    },
  )
}

/**
 * Release a reconciliation's reservations: its reserved and left-off claims are released, and a
 * drafted reconciliation is back to proposed, touched now so the idle delete does not take it at
 * once. The caller has made sure no document carries its key. Billed and credited claims stay.
 */
export async function releaseReconciliation(
  tx: Tx,
  input: { orgId: string; reconciliationId: string },
): Promise<{ released: number; state: string }> {
  const { orgId, reconciliationId } = input
  const released = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("billing_claims")} SET state = 'released', updated_at = now()
       WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${reconciliationId}::uuid
         AND state IN ('reserved', 'left_off')
      RETURNING id::text AS id`),
  ).length
  const back = extractRows<{ state: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliations")} r
         SET state = 'proposed', document_id = NULL, document_ref = NULL, drafted_at = NULL,
             drafted_by = NULL, updated_at = now()
       WHERE r.id = ${reconciliationId}::uuid AND r.org_id = ${orgId}::uuid AND r.state = 'drafted'
         AND NOT EXISTS (
           SELECT 1 FROM ${projectsRel("reconciliations")} o
            WHERE o.org_id = r.org_id AND o.project_id = r.project_id AND o.state = 'proposed'
              AND o.created_by = r.created_by AND o.id <> r.id
              AND o.period_start IS NOT DISTINCT FROM r.period_start)
      RETURNING state`),
  )[0]
  const state =
    back?.state ??
    extractRows<{ state: string }>(
      await tx.execute(drizzleSql`
        SELECT state FROM ${projectsRel("reconciliations")}
         WHERE id = ${reconciliationId}::uuid AND org_id = ${orgId}::uuid`),
    )[0]?.state ??
    "gone"
  return { released, state }
}

// ── reconcile_mark ──────────────────────────────────────────────────────────

export type MarkTo = "billed" | "released" | "credited" | "partly_credited"
const MARK_TO: readonly MarkTo[] = ["billed", "released", "credited", "partly_credited"]

export interface MarkInput {
  reconciliationId: string
  to: MarkTo
  documentId?: string
  documentNumber?: string
  /** Minutes credited so far on each line, all credit notes together, by line id. */
  creditedMinutesByLine?: Record<string, number>
}

export interface MarkResult {
  reconciliationId: string
  to: MarkTo
  changed: boolean
  state: string
  claims: number
  documentNumber: string | null
  message: string
}

function isFullyCredited(d: RefDocument): boolean {
  const total = d.grandTotalMinor < 0n ? -d.grandTotalMinor : d.grandTotalMinor
  return total > 0n && d.creditedMinor >= total
}

/**
 * Move a reconciliation's claims after something happened to its invoice. Each move is checked
 * against the invoicing documents first and is compare-and-set, so a repeat, a race with the sweep,
 * or a call on a draft changes nothing.
 */
export async function reconcileMark(args: {
  tx: Tx
  orgId: string
  input: MarkInput
}): Promise<MarkResult> {
  const { tx, orgId, input } = args
  if (!MARK_TO.includes(input.to)) {
    throw new ProjectsServiceError(
      400,
      "invalid_input",
      `to must be one of ${MARK_TO.join(", ")}. Nothing was changed.`,
    )
  }
  const r = await readReconciliation(tx, orgId, input.reconciliationId, true)
  const docs = r.document_ref ? await documentsForRef(orgId, r.document_ref) : []
  const issued = docs.find((d) => (ISSUED_STATES as readonly string[]).includes(d.status)) ?? null
  const label = `the reconciliation of ${r.project_name}${
    r.period_start ? ` for ${r.period_start} to ${r.period_end}` : ""
  }`
  const result = (
    changed: boolean,
    state: string,
    claims: number,
    message: string,
    documentNumber: string | null = issued?.number ?? null,
  ): MarkResult => ({
    reconciliationId: r.id,
    to: input.to,
    changed,
    state,
    claims,
    documentNumber,
    message,
  })

  if (input.to === "released") {
    if (docs.length > 0) {
      const d = docs[0]!
      return result(
        false,
        r.state,
        0,
        `Nothing released: ${d.number ? `invoice ${d.number}` : "a draft invoice"} still carries ${r.document_ref}. Discard or credit it first.`,
        d.number,
      )
    }
    const out = await releaseReconciliation(tx, { orgId, reconciliationId: r.id })
    return result(
      out.released > 0 || out.state !== r.state,
      out.state,
      out.released,
      `Released ${out.released} claim${out.released === 1 ? "" : "s"} of ${label}; it is ${out.state} again, and its work can be billed again.`,
      null,
    )
  }

  if (!issued) {
    return result(
      false,
      r.state,
      0,
      `Nothing marked: no issued invoice carries the key of ${label}${
        r.document_ref ? ` (${r.document_ref})` : ""
      }. A draft never moves its claims; they move once it is issued.`,
      null,
    )
  }
  if (input.documentId && input.documentId !== issued.id) {
    throw new ProjectsServiceError(
      409,
      "document_mismatch",
      `Invoice ${issued.number ?? issued.id} carries the key of ${label}, not document ${input.documentId}. Nothing was changed.`,
    )
  }

  if (input.to === "billed") {
    const claims = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("billing_claims")}
           SET state = 'billed', document_id = ${issued.id}::uuid,
               document_number = ${issued.number}, updated_at = now()
         WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${r.id}::uuid AND state = 'reserved'
        RETURNING id::text AS id`),
    ).length
    const moved = extractRows<{ state: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("reconciliations")}
           SET state = 'invoiced', document_id = ${issued.id}::uuid, updated_at = now()
         WHERE id = ${r.id}::uuid AND org_id = ${orgId}::uuid AND state = 'drafted'
        RETURNING state`),
    ).length
    const state = moved > 0 ? "invoiced" : r.state
    return result(
      claims > 0 || moved > 0,
      state,
      claims,
      claims > 0 || moved > 0
        ? `Marked ${claims} claim${claims === 1 ? "" : "s"} of ${label} billed on invoice ${issued.number}; the reconciliation is ${state}.`
        : `Nothing to mark: the claims of ${label} were already billed on invoice ${issued.number}.`,
    )
  }

  if (input.to === "credited") {
    if (!isFullyCredited(issued)) {
      return result(
        false,
        r.state,
        0,
        `Nothing marked: invoice ${issued.number} is not fully credited yet. A partial credit keeps its claims billed.`,
      )
    }
    const claims = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("billing_claims")}
           SET state = 'credited', document_id = ${issued.id}::uuid,
               document_number = coalesce(document_number, ${issued.number}), updated_at = now()
         WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${r.id}::uuid
           AND state IN ('reserved', 'billed')
        RETURNING id::text AS id`),
    ).length
    const moved = extractRows<{ state: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("reconciliations")}
           SET state = 'credited', document_id = ${issued.id}::uuid, updated_at = now()
         WHERE id = ${r.id}::uuid AND org_id = ${orgId}::uuid AND state IN ('drafted', 'invoiced')
        RETURNING state`),
    ).length
    return result(
      claims > 0 || moved > 0,
      moved > 0 ? "credited" : r.state,
      claims,
      `Invoice ${issued.number} is fully credited: ${claims} claim${claims === 1 ? "" : "s"} of ${label} are freed, and that work can be billed again on a new reconciliation.`,
    )
  }

  // partly_credited: the billed-after-credit figure per line; claim and reconciliation states stay.
  const credited = input.creditedMinutesByLine ?? {}
  let lines = 0
  for (const [lineId, minutes] of Object.entries(credited)) {
    if (!Number.isInteger(minutes) || minutes < 0) {
      throw new ProjectsServiceError(
        400,
        "invalid_input",
        `creditedMinutesByLine.${lineId} must be a whole number of minutes, 0 or more. Nothing was changed.`,
      )
    }
    lines += extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("reconciliation_lines")}
           SET billed_after_credit_minutes = greatest(bill_minutes - ${minutes}, 0), updated_at = now()
         WHERE id = ${lineId}::uuid AND org_id = ${orgId}::uuid
           AND reconciliation_id = ${r.id}::uuid
           AND billed_after_credit_minutes IS DISTINCT FROM greatest(bill_minutes - ${minutes}, 0)
        RETURNING id::text AS id`),
    ).length
  }
  return result(
    lines > 0,
    r.state,
    0,
    `Recorded the billed-after-credit figure on ${lines} line${lines === 1 ? "" : "s"} of ${label} after a partial credit of invoice ${issued.number}; its claims stay billed.`,
  )
}

// ── reconcile_lines_read ────────────────────────────────────────────────────

/**
 * What a reconciliation bills, for the invoice made from it: each billed line's wording, its
 * quantity in the project's unit, the proof labels and the rate frozen at Create. Never real time,
 * a time-spent note, a trace estimate or a person.
 */
export async function reconcileLinesRead(args: {
  tx: Tx
  orgId: string
  input: { reconciliationId: string }
}) {
  const { tx, orgId } = args
  const r = await readReconciliation(tx, orgId, args.input.reconciliationId)
  const frozen = extractRows<{
    rate: string | number | null
    currency: string | null
    hpd: number | null
  }>(
    await tx.execute(drizzleSql`
      SELECT create_rate_minor AS rate, create_currency AS currency,
             create_hours_per_day_minutes AS hpd
        FROM ${projectsRel("reconciliations")}
       WHERE id = ${r.id}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  const hpd = frozen?.hpd ?? (await hoursPerDayMinutes(tx, orgId))
  const basis = r.basis as Basis
  const lines = extractRows<{
    id: string
    position: number
    wording: string | null
    bill_minutes: number
    billed_after_credit_minutes: number | null
    document_line_position: number | null
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, position, coalesce(wording, name) AS wording, bill_minutes,
             billed_after_credit_minutes, document_line_position
        FROM ${projectsRel("reconciliation_lines")}
       WHERE reconciliation_id = ${r.id}::uuid AND org_id = ${orgId}::uuid AND bill_minutes > 0
       ORDER BY position`),
  )
  const proofs = extractRows<{ line_id: string; label: string }>(
    await tx.execute(drizzleSql`
      SELECT pr.line_id::text AS line_id, pr.label
        FROM ${projectsRel("reconciliation_proofs")} pr
        JOIN ${projectsRel("reconciliation_lines")} l ON l.id = pr.line_id AND l.org_id = pr.org_id
       WHERE l.reconciliation_id = ${r.id}::uuid AND pr.org_id = ${orgId}::uuid
       ORDER BY pr.created_at, pr.id`),
  )
  const reserved =
    extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM ${projectsRel("billing_claims")}
         WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${r.id}::uuid AND state = 'reserved'`),
    )[0]?.n ?? 0
  const per = basis === "daily" ? hpd : 60
  const unit = basis === "daily" ? "day" : "hour"
  return {
    reconciliationId: r.id,
    projectId: r.project_id,
    basis,
    state: r.state,
    revision: r.revision,
    documentRef: r.document_ref,
    claimsReserved: reserved > 0,
    period: { from: r.period_start, to: r.period_end },
    rate: {
      rateMinor: frozen?.rate === null || frozen?.rate === undefined ? null : Number(frozen.rate),
      currency: frozen?.currency ?? null,
      hoursPerDayMinutes: hpd,
      unit,
    },
    lines: lines.map((l) => ({
      lineId: l.id,
      position: l.position,
      wording: l.wording ?? "",
      billMinutes: l.bill_minutes,
      bill: Math.round((l.bill_minutes / per) * 100) / 100,
      billText: worded(l.bill_minutes, basis, hpd),
      unit,
      billedAfterCreditMinutes: l.billed_after_credit_minutes,
      documentLinePosition: l.document_line_position,
      proofLabels: proofs.filter((p) => p.line_id === l.id).map((p) => p.label),
      lineKind: "service" as const,
    })),
    message: `${lines.length} billed line${lines.length === 1 ? "" : "s"} of ${r.project_name}'s reconciliation (${r.state}).`,
  }
}

// ── milestone_status_read ───────────────────────────────────────────────────

/**
 * Whether named tasks of a project are done, for a billing plan's milestones: the project's
 * basis and, per task, its title, done state, milestone mark and completion day. Nothing about
 * who did it, how long it took or what happened on it.
 */
export async function milestoneStatusRead(args: {
  tx: Tx
  orgId: string
  input: { projectId: string; taskIds: string[] }
}) {
  const { tx, orgId } = args
  const ids = (args.input.taskIds ?? []).filter((t) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t),
  )
  const project = extractRows<{ id: string; basis: string }>(
    await tx.execute(drizzleSql`
      SELECT p.id::text AS id, coalesce(tp.basis, 'none') AS basis
        FROM ${projectsRel("projects")} p
        LEFT JOIN ${projectsRel("project_time_plan")} tp ON tp.project_id = p.id AND tp.org_id = p.org_id
       WHERE p.id = ${args.input.projectId}::uuid AND p.org_id = ${orgId}::uuid`),
  )[0]
  if (!project) {
    throw new ProjectsServiceError(
      404,
      "not_found",
      `No project ${args.input.projectId} you can read. Nothing was read.`,
    )
  }
  const tz = await orgTimezone(tx, orgId)
  const tasks =
    ids.length === 0
      ? []
      : extractRows<{
          id: string
          title: string
          terminal: boolean
          is_milestone: boolean
          completed_on: string | null
        }>(
          await tx.execute(drizzleSql`
            SELECT t.id::text AS id, t.title, coalesce(s.terminal, false) AS terminal,
                   t.is_milestone,
                   CASE WHEN t.completed_at IS NOT NULL OR s.terminal
                        THEN (coalesce(t.completed_at, t.updated_at) AT TIME ZONE ${tz})::date::text
                   END AS completed_on
              FROM ${projectsRel("tasks")} t
              LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
             WHERE t.org_id = ${orgId}::uuid AND t.project_id = ${project.id}::uuid
               AND t.archived_at IS NULL
               AND t.id IN (${drizzleSql.join(
                 ids.map((i) => drizzleSql`${i}::uuid`),
                 drizzleSql`, `,
               )})`),
        )
  return {
    basis: project.basis,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      terminal: t.terminal,
      isMilestone: t.is_milestone,
      completedOn: t.completed_on,
    })),
  }
}

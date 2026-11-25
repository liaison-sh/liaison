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
import { advisoryXactLock } from "~/db/advisory-lock"
import { cardMinutesNow, type LineMinutes, type LineNow } from "./card-minutes"
import type { Counting } from "./line-minutes"
import { billedHundredths, worded } from "./reconcile-lines"
import { documentsForRef, ISSUED_STATES, type RefDocument } from "./reconcile-sweep"
import { retainerMonthFacts } from "./retainer-month"
import { ProjectsServiceError } from "./statuses"
import { claimMonth } from "./time-ledger"
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

/** The claim kind of a billed line that names no task and no proof: the line itself. */
export const LINE_SOURCE = "line"

interface Source {
  /** A retainer's hours of an earlier month, worked after its invoice. */
  workMonth?: string
  /** The minutes of the task this claim counts; null when its line is not billed by its time. */
  counted?: number | null
  /** Later time of work already claimed: it takes a key of its own. */
  later?: boolean
  lineId: string
  kind: string
  ref: string
  periodKey: string
  label: string
}

interface StoredLine extends LineMinutes {
  name: string | null
  otherProjectId: string | null
}

const idList = (raw: string[] | string | null): string[] =>
  raw === null ? [] : Array.isArray(raw) ? raw : raw.replace(/[{}]/g, "").split(",").filter(Boolean)

async function storedLines(tx: Tx, orgId: string, id: string): Promise<StoredLine[]> {
  return extractRows<{
    id: string
    name: string | null
    drawn_as: string | null
    kind: string | null
    bill_minutes: number
    real_minutes: number | null
    planned_minutes: number | null
    task_ids: string[] | string
    other_project_id: string | null
    work_month: string | null
    counting: Counting | null
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, coalesce(wording, name) AS name, name AS drawn_as, kind,
             bill_minutes, real_minutes, planned_minutes, task_ids::text[] AS task_ids,
             other_project_id::text AS other_project_id, work_month, counting
        FROM ${projectsRel("reconciliation_lines")}
       WHERE reconciliation_id = ${id}::uuid AND org_id = ${orgId}::uuid
       ORDER BY position`),
  ).map((l) => ({
    id: l.id,
    name: l.name,
    drawnAs: l.drawn_as,
    kind: l.kind,
    billMinutes: Number(l.bill_minutes),
    realMinutes: Number(l.real_minutes ?? 0),
    plannedMinutes: l.planned_minutes === null ? null : Number(l.planned_minutes),
    taskIds: idList(l.task_ids),
    otherProjectId: l.other_project_id,
    workMonth: l.work_month,
    counting: l.counting,
  }))
}

/**
 * The sources a reconciliation bills, and the tasks of the lines it leaves at zero, each with the
 * minutes `now` says its line counts.
 */
async function sourcesOf(
  tx: Tx,
  orgId: string,
  r: ReconRow,
  lines: readonly StoredLine[],
  now: ReadonlyMap<string, LineNow>,
  held: ReadonlySet<string>,
): Promise<{ billed: Source[]; leftOff: Source[] }> {
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
  const task = (l: StoredLine, id: string, counted: number | null): Source => ({
    lineId: l.id,
    kind: "task",
    ref: id,
    periodKey: l.workMonth ?? taskKey,
    label: l.name ?? "",
    counted,
    // Minutes no claim of the task counted yet take a key of their own beside the ones that stand.
    ...(now.get(l.id)?.later ||
    (held.has(id) && (now.get(l.id)?.real ?? 0) > 0 && (counted ?? 0) > 0)
      ? { later: true }
      : {}),
    ...(l.workMonth ? { workMonth: l.workMonth } : {}),
  })
  // The tasks a line names, and those under them whose minutes it counts.
  const tasksOf = (l: StoredLine) => {
    const named = [...new Set(l.taskIds)]
    const counted = now.get(l.id)?.counted
    const under = [...(counted ?? [])].filter(([id, m]) => m > 0 && !named.includes(id))
    return [...named.map((id) => [id, counted?.get(id) ?? null] as const), ...under]
  }
  for (const l of lines) {
    if (l.billMinutes <= 0) continue
    const before = billed.length
    const atPlan = now.get(l.id)?.atPlan === true
    for (const [t, m] of tasksOf(l))
      add(billed, task(l, t, atPlan && l.taskIds.includes(t) ? null : m))
    for (const p of proofs) {
      if (p.line_id !== l.id) continue
      // A task proof names a task already claimed through the line's tasks.
      if (p.kind === "task" && l.taskIds.includes(p.ref)) continue
      add(billed, { lineId: l.id, kind: p.kind, ref: p.ref, periodKey: "all", label: p.label })
    }
    // A billed line with no task and no proof is its own source: without a claim it could be
    // billed again, and a card made only of such lines would reserve nothing and never issue.
    if (billed.length === before) {
      add(billed, {
        lineId: l.id,
        kind: LINE_SOURCE,
        ref: l.id,
        periodKey: "all",
        label: l.name ?? "",
      })
    }
  }
  // Left off: the tasks of lines at zero, on this project, that no billed line claims.
  for (const l of lines) {
    if (l.billMinutes > 0 || l.otherProjectId) continue
    for (const [t, m] of tasksOf(l)) {
      const s = task(l, t, m)
      // On another line at some minutes of its own: these are left off all the same.
      if ((m ?? 0) > 0 && billed.some((b) => b.kind === "task" && b.ref === t)) leftOff.push(s)
      else add(leftOff, s)
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

/** A line whose minutes, or bill by default, moved since it was drawn. */
export interface MovedLine {
  lineId: string
  name: string
  was: number
  now: number
  billWas: number
  bill: number
  counting: Counting | null
}

/** Work on a card changed since it was drawn: what it says now, line by line. */
export class CardMinutesMoved extends Error {
  constructor(readonly lines: MovedLine[]) {
    super("card_minutes_moved")
  }
}

/** Whether the card's own reservations are the ones its lines ask for. */
async function ownClaimsStand(
  tx: Tx,
  orgId: string,
  id: string,
  lines: readonly StoredLine[],
  billed: readonly Source[],
): Promise<boolean> {
  const own = extractRows<{ k: string; r: string; p: string; line: string | null }>(
    await tx.execute(drizzleSql`
      SELECT source_kind AS k, source_ref AS r, period_key AS p, line_id::text AS line
        FROM ${projectsRel("billing_claims")}
       WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${id}::uuid
         AND state IN ('reserved', 'billed')`),
  )
  const ids = new Set(lines.map((l) => l.id))
  if (own.length !== billed.length || own.some((c) => c.line === null || !ids.has(c.line)))
    return false
  const key = (k: string, r: string, p: string) => `${k} ${r} ${claimMonth(p)}`
  const held = new Set(own.map((c) => key(c.k, c.r, c.p)))
  return billed.every((s) => held.has(key(s.kind, s.ref, s.periodKey)))
}

/**
 * Reserve a reconciliation's sources at Create, and store the key its draft gets. A retry with
 * the same reconciliation reuses its own live claims. A source another reconciliation holds is
 * answered `already_on`, naming the invoice number or the draft, and nothing is written. A line
 * billed by its time whose minutes moved since it was drawn is refused (`CardMinutesMoved`): what
 * is claimed is always what is counted now, and what the card says. One reservation of a project
 * at a time, so two cards never count the same minutes.
 */
export async function reserveClaims(
  tx: Tx,
  input: {
    orgId: string
    reconciliationId: string
    documentRef: string
    /** The card's revision the caller was shown, when it knows it. */
    revision?: number
    /** A card that bills an earlier month's later hours alone: its own month is not claimed. */
    lateOnly?: boolean
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
    const { project_id: projectId } = await readReconciliation(sp as Tx, orgId, reconciliationId)
    await sp.execute(advisoryXactLock(`projects.claims:${orgId}:${projectId}`))
    const r = await readReconciliation(sp as Tx, orgId, reconciliationId, true)
    if (r.state === "invoiced" || r.state === "credited") {
      throw new ProjectsServiceError(
        409,
        "reconcile_locked",
        `The reconciliation of ${r.project_name} is already ${r.state}. Nothing was reserved.`,
      )
    }
    if (input.revision !== undefined && input.revision !== r.revision) {
      throw new ProjectsServiceError(
        409,
        "card_changed",
        `This card moved on to revision ${r.revision} since it was drawn. Nothing was reserved.`,
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
    const tz = await orgTimezone(sp as Tx, orgId)
    const stored = (await storedLines(sp as Tx, orgId, reconciliationId)).filter(
      (l) => !input.lateOnly || l.workMonth !== null,
    )
    const out = await excludedOf(sp as Tx, orgId, reconciliationId)
    const minutes = await cardMinutesNow(sp as Tx, {
      orgId,
      tz,
      head: r,
      lines: stored,
      excluded: new Set(out),
    })
    const { billed, leftOff } = await sourcesOf(
      sp as Tx,
      orgId,
      r,
      stored,
      minutes.lines,
      minutes.held,
    )
    if (count("reserved") + count("billed") > 0) {
      // Its claims from an earlier try: kept, unless the card was proposed again since and no
      // draft was made from them.
      const stands =
        r.state !== "proposed" ||
        (await ownClaimsStand(sp as Tx, orgId, reconciliationId, stored, billed)) ||
        (await documentsForRef(orgId, documentRef)).length > 0
      if (stands) {
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
    }
    // A fresh reservation: what an earlier try reserved or left off is recorded again below.
    await sp.execute(drizzleSql`
      UPDATE ${projectsRel("billing_claims")} SET state = 'released', updated_at = now()
       WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${reconciliationId}::uuid
         AND state IN ('reserved', 'left_off')`)

    // What another card took since is on that card; any other change of the minutes is shown first.
    const moved: MovedLine[] = []
    for (const l of stored) {
      const is = minutes.lines.get(l.id)
      if (!is?.moved) continue
      for (const t of is.gone) {
        const s: Source = {
          lineId: l.id,
          kind: "task",
          ref: t,
          periodKey: l.workMonth ?? claimPeriodKey(r.basis, r.period_start),
          label: l.name ?? "",
          ...(l.workMonth ? { workMonth: l.workMonth } : {}),
        }
        if (await takenSince(sp as Tx, orgId, s, reconciliationId))
          throw await alreadyOn(sp as Tx, orgId, s, reconciliationId)
      }
      moved.push({
        lineId: l.id,
        name: l.name ?? "",
        was: l.realMinutes,
        now: is.real,
        billWas: is.billWas,
        bill: is.bill,
        counting: is.counting,
      })
    }
    if (moved.length > 0) throw new CardMinutesMoved(moved)

    const lost: Source[] = []
    const back = new Map(stored.map((l) => [l.id, minutes.lines.get(l.id)?.addsBack ?? []]))
    for (const s of billed) {
      const base = s.periodKey
      if (s.kind === "task" && (s.later || r.basis === "retainer")) {
        // Work of a month, or later time of a billed task, whose key a later card holds: the first
        // key no live claim holds. The month's own key, held by another card of the month, is lost.
        const keys = await liveKeys(sp as Tx, orgId, s.ref, base, reconciliationId)
        if (!s.later && keys.some((k) => k.key === base && k.from === r.period_start)) {
          lost.push(s)
          continue
        }
        s.periodKey = freeKey(base, new Set(keys.map((k) => k.key)))
      }
      if (s.kind === "task" && back.get(s.lineId)?.includes(s.ref)) {
        // Left out of a card before, and billed now: it is not left out any more.
        await sp.execute(drizzleSql`
          UPDATE ${projectsRel("billing_claims")} SET state = 'released', updated_at = now()
           WHERE org_id = ${orgId}::uuid AND source_kind = 'task' AND source_ref = ${s.ref}
             AND state = 'left_off'
             AND (period_key = ${base} OR starts_with(period_key, ${`${base}+`}))`)
      }
      const inserted = extractRows<{ id: string }>(
        await sp.execute(drizzleSql`
          INSERT INTO ${projectsRel("billing_claims")}
            (org_id, project_id, reconciliation_id, line_id, source_kind, source_ref, period_key,
             state, counted_minutes)
          VALUES (${orgId}::uuid, ${r.project_id}::uuid, ${reconciliationId}::uuid,
            ${s.lineId}::uuid, ${s.kind}, ${s.ref}, ${s.periodKey}, 'reserved',
            ${s.counted ?? null})
          ON CONFLICT (org_id, source_kind, source_ref, period_key)
            WHERE state IN ('reserved', 'billed') DO NOTHING
          RETURNING id::text AS id`),
      )
      if (inserted.length === 0) lost.push(s)
    }
    if (lost.length > 0) throw await alreadyOn(sp as Tx, orgId, lost[0]!, reconciliationId)
    // Earlier time of the tasks left out as the client's own: it stays out of the next cards.
    const listed = new Set(stored.flatMap((l) => l.taskIds))
    const left: Array<Omit<Source, "lineId" | "label"> & { lineId: string | null }> = [...leftOff]
    for (const id of out.filter((x) => !listed.has(x))) {
      for (const m of minutes.months) {
        const counted = m.offered.get(id) ?? 0
        if (counted > 0)
          left.push({ lineId: null, kind: "task", ref: id, periodKey: m.month, counted })
      }
      const counted = minutes.after.offered.get(id) ?? 0
      if (counted > 0) left.push({ lineId: null, kind: "task", ref: id, periodKey: "all", counted })
    }
    for (const s of left) {
      // Named on a line set to 0: left out again, with all the line shows.
      if (s.lineId && back.get(s.lineId)?.includes(s.ref)) {
        await sp.execute(drizzleSql`
          UPDATE ${projectsRel("billing_claims")} SET state = 'released', updated_at = now()
           WHERE org_id = ${orgId}::uuid AND source_kind = 'task' AND source_ref = ${s.ref}
             AND state = 'left_off' AND reconciliation_id IS DISTINCT FROM ${reconciliationId}::uuid
             AND (period_key = ${s.periodKey} OR starts_with(period_key, ${`${s.periodKey}+`}))`)
      }
      await sp.execute(drizzleSql`
        INSERT INTO ${projectsRel("billing_claims")}
          (org_id, project_id, reconciliation_id, line_id, source_kind, source_ref, period_key,
           state, counted_minutes)
        VALUES (${orgId}::uuid, ${r.project_id}::uuid, ${reconciliationId}::uuid,
          ${s.lineId}::uuid, ${s.kind}, ${s.ref}, ${s.periodKey}, 'left_off',
          ${s.counted ?? null})`)
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

/**
 * Bring a proposed card to the minutes of now: each moved line its new time, and the bill that
 * followed it. A bill a person set stays. The card moves on one revision.
 */
export async function refreshCardMinutes(
  tx: Tx,
  input: { orgId: string; reconciliationId: string; moved: readonly MovedLine[] },
): Promise<void> {
  const { orgId, reconciliationId } = input
  const r = await readReconciliation(tx, orgId, reconciliationId, true)
  if (r.state !== "proposed") return
  for (const m of input.moved) {
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliation_lines")}
         SET real_minutes = ${m.now}, updated_at = now(),
             counting = ${m.counting ? JSON.stringify(m.counting) : null}::jsonb,
             bill_minutes = CASE WHEN bill_minutes = ${m.billWas} THEN ${m.bill}
                                 ELSE bill_minutes END
       WHERE id = ${m.lineId}::uuid AND reconciliation_id = ${reconciliationId}::uuid
         AND org_id = ${orgId}::uuid`)
  }
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("reconciliations")} SET revision = revision + 1, updated_at = now()
     WHERE id = ${reconciliationId}::uuid AND org_id = ${orgId}::uuid AND state = 'proposed'`)
}

/** The tasks a card left out as the client's own work. */
async function excludedOf(tx: Tx, orgId: string, id: string): Promise<string[]> {
  return idList(
    extractRows<{ ids: string[] | string | null }>(
      await tx.execute(drizzleSql`
        SELECT excluded_task_ids::text[] AS ids FROM ${projectsRel("reconciliations")}
         WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`),
    )[0]?.ids ?? null,
  )
}

/** Whether another card claimed this task, under its key or a later one, after the line was drawn. */
async function takenSince(
  tx: Tx,
  orgId: string,
  s: Source,
  reconciliationId: string,
): Promise<boolean> {
  return (
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT c.id::text AS id FROM ${projectsRel("billing_claims")} c
         WHERE c.org_id = ${orgId}::uuid AND c.source_kind = 'task' AND c.source_ref = ${s.ref}
           AND c.state IN ('reserved', 'billed')
           AND (c.period_key = ${s.periodKey} OR starts_with(c.period_key, ${`${s.periodKey}+`}))
           AND c.reconciliation_id IS DISTINCT FROM ${reconciliationId}::uuid
           AND c.created_at > (SELECT l.updated_at FROM ${projectsRel("reconciliation_lines")} l
                                WHERE l.id = ${s.lineId}::uuid AND l.org_id = c.org_id)
         LIMIT 1`),
    ).length > 0
  )
}

/** The live keys of a task under a base key on other cards, with the period of each. */
async function liveKeys(
  tx: Tx,
  orgId: string,
  taskId: string,
  base: string,
  reconciliationId: string,
): Promise<Array<{ key: string; from: string | null }>> {
  return extractRows<{ key: string; from: string | null }>(
    await tx.execute(drizzleSql`
      SELECT c.period_key AS key, r.period_start::text AS "from"
        FROM ${projectsRel("billing_claims")} c
        LEFT JOIN ${projectsRel("reconciliations")} r
          ON r.id = c.reconciliation_id AND r.org_id = c.org_id
       WHERE c.org_id = ${orgId}::uuid AND c.source_kind = 'task' AND c.source_ref = ${taskId}
         AND c.state IN ('reserved', 'billed')
         AND (c.period_key = ${base} OR starts_with(c.period_key, ${`${base}+`}))
         AND c.reconciliation_id IS DISTINCT FROM ${reconciliationId}::uuid`),
  )
}

/** The first key of a base (`2027-01`, then `2027-01+2`) that is not held. */
function freeKey(base: string, held: ReadonlySet<string>): string {
  if (!held.has(base)) return base
  let n = 2
  while (held.has(`${base}+${n}`)) n += 1
  return `${base}+${n}`
}

/** The refusal for a source another reconciliation holds, naming its invoice or draft. */
async function alreadyOn(
  tx: Tx,
  orgId: string,
  s: Source,
  reconciliationId: string,
): Promise<ProjectsServiceError> {
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
         AND (c.period_key = ${s.periodKey} OR starts_with(c.period_key, ${`${s.workMonth ?? s.periodKey}+`}))
         AND c.state IN ('reserved', 'billed')
         AND c.reconciliation_id IS DISTINCT FROM ${reconciliationId}::uuid
       ORDER BY c.created_at DESC
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
  if (back) return { released, state: back.state }
  // A newer card of the same person and period holds the proposed slot: this one gives up its key
  // and its draft, so no reader is shown it again and the sweep deletes it ("superseded").
  const aside = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliations")}
         SET document_id = NULL, document_ref = NULL, drafted_at = NULL, drafted_by = NULL,
             updated_at = now()
       WHERE id = ${reconciliationId}::uuid AND org_id = ${orgId}::uuid AND state = 'drafted'
      RETURNING id::text AS id`),
  )
  if (aside.length > 0) return { released, state: SUPERSEDED }
  const state =
    extractRows<{ state: string }>(
      await tx.execute(drizzleSql`
        SELECT state FROM ${projectsRel("reconciliations")}
         WHERE id = ${reconciliationId}::uuid AND org_id = ${orgId}::uuid`),
    )[0]?.state ?? "gone"
  return { released, state }
}

/**
 * What `releaseReconciliation` answers for a drafted reconciliation set aside: a newer card of the
 * same person and period stands. The row stays `drafted` with no key until the sweep deletes it.
 */
export const SUPERSEDED = "superseded"

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
      out.state === SUPERSEDED
        ? `Released ${out.released} claim${out.released === 1 ? "" : "s"} of ${label}; a newer card of the same person and period stands, so this one is set aside, and its work can be billed again.`
        : `Released ${out.released} claim${out.released === 1 ? "" : "s"} of ${label}; it is ${out.state} again, and its work can be billed again.`,
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
  // The company the invoice goes to: the project's own (never a person).
  const company = extractRows<{ company_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT company_id::text AS company_id FROM ${projectsRel("projects")}
       WHERE id = ${r.project_id}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  const lines = extractRows<{
    id: string
    position: number
    wording: string | null
    bill_minutes: number
    billed_after_credit_minutes: number | null
    document_line_position: number | null
    work_month: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, position, coalesce(wording, name) AS wording, bill_minutes,
             billed_after_credit_minutes, document_line_position, work_month
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
  const claims = extractRows<{ reserved: number; gone: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*) FILTER (WHERE state = 'reserved')::int AS reserved,
             count(*) FILTER (WHERE state IN ('billed', 'credited'))::int AS gone
        FROM ${projectsRel("billing_claims")}
       WHERE org_id = ${orgId}::uuid AND reconciliation_id = ${r.id}::uuid`),
  )[0] ?? { reserved: 0, gone: 0 }
  // The work the draft bills must still be reserved for it. A retainer month's card still drafted
  // that bills no line bills its fee alone: it holds nothing, whatever it left off, set to 0 or gave
  // back before. Any other card with nothing reserved does not issue.
  const feeOnlyRetainer =
    basis === "retainer" && r.state === "drafted" && lines.length === 0 && claims.gone === 0
  const claimsReserved = claims.reserved > 0 || feeOnlyRetainer
  const per = basis === "daily" ? hpd : 60
  const unit = basis === "daily" ? "day" : "hour"
  const retainer =
    basis === "retainer" && r.period_start
      ? await retainerMonthFacts(tx, orgId, r.project_id, r.period_start)
      : null
  return {
    reconciliationId: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    companyId: company?.company_id ?? null,
    basis,
    state: r.state,
    revision: r.revision,
    documentRef: r.document_ref,
    claimsReserved,
    period: { from: r.period_start, to: r.period_end },
    ...(retainer ? { timeboxMinutes: retainer.timeboxMinutes } : {}),
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
      ...(l.work_month ? { workMonth: l.work_month } : {}),
      bill: billedHundredths(l.bill_minutes, per) / 100,
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
 * basis and client company and, per task, its title, done state, milestone mark and completion day. Nothing about
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
  const project = extractRows<{ id: string; basis: string; company_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT p.id::text AS id, coalesce(tp.basis, 'none') AS basis,
             p.company_id::text AS company_id
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
          terminal: boolean
          is_milestone: boolean
          completed_on: string | null
        }>(
          await tx.execute(drizzleSql`
            SELECT t.id::text AS id, coalesce(s.terminal, false) AS terminal,
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
    // The client company the project is for: an invoice billing the project is made out to it
    // when its contact has no company on file.
    companyId: project.company_id,
    // No title: the read runs in another app's call with that app's wide row access, so a title
    // would name work in a project the person may not open. The step's own label names it.
    tasks: tasks.map((t) => ({
      id: t.id,
      terminal: t.terminal,
      isMilestone: t.is_milestone,
      completedOn: t.completed_on,
    })),
  }
}

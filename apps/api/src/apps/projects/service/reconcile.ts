// SPDX-License-Identifier: FSL-1.1-ALv2
// Reconcile: one project and one period, planned against done. `reconcileFacts` gives the agent
// the deterministic part (the period's tasks with their planned and real time, the client's
// markers, what is already billed); the agent then reads its traces itself, with its own tools in
// the asker's turn, and `reconcilePropose` stores the card. Every figure on a line is the
// server's: the agent supplies grouping, wording and proof references only.
//
// Everything here runs under the asker's own row security. Nothing is read on anyone's behalf:
// no other app is called and no privileged handle is opened, so the card holds only what the
// asker could read. No user id, assignee or per-person figure appears in any result.
import { parseDuration } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { getEnabledApps } from "~/modules/apps/enabled-apps"
import { hasScope } from "~/modules/permissions/permissions"
import { LINE_SOURCE } from "./claims"
import { type BudgetTask, coverageOf, liveTasks, plannedByTask } from "./coverage"
import {
  type BilledCard,
  billedCards,
  coveredByCard,
  feeMonths,
  inRetainerMonth,
  lateClosedTasks,
  lateMonths,
  laterTime,
  type MonthMinutes,
} from "./late-work"
import { type Counting, takeSpare } from "./line-minutes"
import { linesForViewer, reconcileCardFields, reconcileCodingAgentText } from "./reconcile-card"
import {
  amountMinor,
  type ComputedLine,
  type ComputedProof,
  computeLines,
  countingSaid,
  cutText,
  defaultBill,
  earlyNote,
  keptProofUrl,
  LATE_CREDITED_LINE_NAME,
  LATE_GAP_LINE_NAME,
  LATE_GAP_UNPLANNED_LINE_NAME,
  LATE_LEFT_LINE_NAME,
  LATE_LINE_NAME,
  LATE_RELATED_LINE_NAME,
  LATE_TIME_LINE_NAME,
  LATE_UNPLANNED_LINE_NAME,
  LINE_NAME_MAX,
  type LineKind,
  lateMonthLineName,
  lateNote,
  linesAmountMinor,
  NOT_EVERYTHING_SEEN,
  namedMember,
  type Period,
  type ProofKind,
  type ProposedLine,
  proofLabel,
  readProposedLines,
  repoHostsOf,
  resolvePeriod,
  unnamedProofLabel,
  worded,
} from "./reconcile-lines"
import { resolveProjectId } from "./resolve"
import { ProjectsServiceError } from "./statuses"
import { taskMinutes } from "./task-minutes"
import { shareOf, spares, type TimeLedger, timeLedger } from "./time-ledger"
import {
  type Basis,
  hoursPerDayMinutes,
  loadPlanningProject,
  orgTimezone,
  requirePlanning,
} from "./time-plan"
import { todayIn } from "./took"

type Tx = RlsClient

export const MONEY_READ_SCOPE = "projects:money:read"

interface TaskRow {
  id: string
  key: string | null
  parent_id: string | null
  title: string
  status: string
  terminal: boolean
  position: number
  number: number
  timebox_minutes: number | null
  is_milestone: boolean
  archived: boolean
  closed: boolean
  started: boolean
  completed_on: string | null
  completed_at: string | null
}

interface Context {
  project: { id: string; key: string | null; name: string; companyId: string | null }
  basis: Basis
  hpd: number
  tz: string
  today: string
  period: Period
  rows: TaskRow[]
  live: BudgetTask[]
  ownReal: Map<string, number>
  hasEntries: Set<string>
  /** The project's cards that are on an invoice or its draft. */
  cards: BilledCard[]
  /** What the project's claims left to count. */
  ledger: TimeLedger
  /** Earlier work no invoice holds, for this card. */
  late: LateWork
  /** The period's tasks: closed in it, and on a retainer also those with time in it. */
  inPeriod: TaskRow[]
  rateMinor: number | null
  currency: string | null
  sourceRepos: Array<{ provider: string; repo: string }>
  /** Agreements is on for the org: a line not in the plan can be offered as a change request. */
  changeRequests: boolean
}

/**
 * The project an ask names: its id, its key (ATLAS), its name, or the name of its client when
 * that client has exactly one project.
 */
async function resolveReconcileProject(tx: Tx, orgId: string, ref: string): Promise<string> {
  const text = ref.trim()
  if (!text) {
    throw new ProjectsServiceError(400, "project_required", "Name the project to reconcile.", {
      next: "Ask which project or client the person means.",
    })
  }
  const byKey = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${projectsRel("projects")}
       WHERE org_id = ${orgId}::uuid AND archived_at IS NULL AND lower(key) = lower(${text})`),
  )
  if (byKey.length === 1) return byKey[0]!.id
  try {
    return await resolveProjectId(tx as never, orgId, { projectId: text })
  } catch (err) {
    if (!(err instanceof ProjectsServiceError) || err.code !== "project_required") throw err
  }
  const byClient = extractRows<{ id: string; name: string }>(
    await tx.execute(drizzleSql`
      SELECT p.id::text AS id, p.name FROM ${projectsRel("projects")} p
        JOIN ${kernelRel("companies")} c ON c.id = p.company_id AND c.org_id = p.org_id
       WHERE p.org_id = ${orgId}::uuid AND p.archived_at IS NULL AND p.kind = 'work'
         AND lower(c.name) = lower(${text})`),
  )
  if (byClient.length === 1) return byClient[0]!.id
  if (byClient.length > 1) {
    throw new ProjectsServiceError(409, "project_ambiguous", `${text} has several projects.`, {
      candidates: byClient.map((p) => ({ id: p.id, name: p.name })),
      next: "Ask which of these projects the person means.",
    })
  }
  throw new ProjectsServiceError(400, "project_required", `No project or client named ${text}.`, {
    next: "Ask which project the person means.",
  })
}

async function loadContext(args: {
  tx: Tx
  orgId: string
  scopes: readonly string[]
  project: string
  month?: string
  from?: string
  to?: string
  now?: Date
}): Promise<Context> {
  const { tx, orgId, scopes } = args
  const projectId = await resolveReconcileProject(tx, orgId, args.project)
  const planning = await loadPlanningProject(tx, orgId, projectId)
  requirePlanning(orgId, planning, scopes)
  const tz = await orgTimezone(tx, orgId)
  const today = todayIn(tz, args.now)
  const period = resolvePeriod(
    {
      ...(args.month !== undefined ? { month: args.month } : {}),
      ...(args.from !== undefined ? { from: args.from } : {}),
      ...(args.to !== undefined ? { to: args.to } : {}),
    },
    today,
  )
  const hpd = await hoursPerDayMinutes(tx, orgId)

  const plan = extractRows<{
    basis: Basis
    company_id: string | null
    source_repos: Array<{ provider: string; repo: string }> | null
  }>(
    await tx.execute(drizzleSql`
      SELECT coalesce(tp.basis, 'none') AS basis, p.company_id::text AS company_id,
             tp.source_repos
        FROM ${projectsRel("projects")} p
        LEFT JOIN ${projectsRel("project_time_plan")} tp ON tp.project_id = p.id
       WHERE p.id = ${projectId}::uuid AND p.org_id = ${orgId}::uuid`),
  )[0]
  const basis = plan?.basis ?? "none"

  // Closed is a done column or a completion date, never a cancelled column; the day it closed
  // is read in the org's zone, so a task closed at 00:30 on the 1st belongs to the new month.
  const rows = extractRows<TaskRow>(
    await tx.execute(drizzleSql`
      SELECT t.id::text AS id,
             CASE WHEN p.key IS NOT NULL THEN p.key || '-' || t.number::text END AS key,
             t.parent_task_id::text AS parent_id, t.title, s.label AS status, s.terminal,
             t.position, t.number, t.timebox_minutes, t.is_milestone,
             t.archived_at IS NOT NULL AS archived,
             (NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal)) AS closed,
             (NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal
              OR s."order" > (SELECT min(s2."order") FROM ${projectsRel("project_statuses")} s2
                               WHERE s2.project_id = t.project_id))) AS started,
             CASE WHEN NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal)
                  THEN (coalesce(t.completed_at, t.updated_at) AT TIME ZONE ${tz})::date::text
             END AS completed_on,
             CASE WHEN NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal)
                  THEN coalesce(t.completed_at, t.updated_at)::text END AS completed_at
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
        JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
        CROSS JOIN LATERAL (SELECT lower(s.label) IN ('cancelled', 'canceled') AS is) cancelled
       WHERE t.project_id = ${projectId}::uuid AND t.org_id = ${orgId}::uuid
       ORDER BY t.position, t.number`),
  )
  const live = liveTasks(
    rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.title,
      position: r.position,
      number: r.number,
      timebox: r.timebox_minutes,
      isMilestone: r.is_milestone,
      archived: r.archived,
      closed: r.closed,
      started: r.started,
    })),
  )
  const liveIds = new Set(live.map((t) => t.id))

  // A retainer counts the period's time; any other basis a task's whole real time.
  const retainer = basis === "retainer"
  const totals = extractRows<{ task_id: string; minutes: string | number; has_entries: boolean }>(
    await tx.execute(drizzleSql`
      SELECT task_id::text AS task_id, minutes, has_entries
        FROM ${projectsRel("task_time_totals")}(${projectId}::uuid,
          ${retainer ? drizzleSql`${period.from}::date` : drizzleSql`NULL::date`},
          ${retainer ? drizzleSql`${period.to}::date` : drizzleSql`NULL::date`})`),
  )
  const ownReal = new Map<string, number>()
  const hasEntries = new Set<string>()
  // Not this card's minutes: on a retainer, what a later month's card counted of this month; by the
  // day or the hour, the time inside a month the retainer was invoiced for.
  const cards = await billedCards(tx, orgId, projectId, tz)
  const ledger = await timeLedger(tx, {
    orgId,
    projectId,
    tz,
    fee: feeMonths(cards),
    ...(retainer ? { own: { from: period.from, to: period.to } } : {}),
    notProposedFor: period.from,
  })
  const own = retainer ? ledger.months.get(period.from.slice(0, 7)) : undefined
  for (const t of totals) {
    if (!liveIds.has(t.task_id)) continue
    const m = own
      ? (own.open.get(t.task_id) ?? 0)
      : Number(t.minutes) - (ledger.inFee.get(t.task_id) ?? 0)
    if (m > 0) ownReal.set(t.task_id, m)
    if (t.has_entries) hasEntries.add(t.task_id)
  }

  const inPeriod = rows.filter(
    (r) =>
      !r.archived &&
      ((r.completed_on !== null && r.completed_on >= period.from && r.completed_on <= period.to) ||
        (retainer && hasEntries.has(r.id))),
  )

  let rateMinor: number | null = null
  let currency: string | null = null
  if (hasScope(MONEY_READ_SCOPE, [...scopes])) {
    const terms = extractRows<{ rate: string | number | null; currency: string | null }>(
      await tx.execute(drizzleSql`
        SELECT rate_minor AS rate, currency FROM ${projectsRel("project_billing_terms")}
         WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid`),
    )[0]
    if (terms?.rate !== null && terms?.rate !== undefined) rateMinor = Number(terms.rate)
    currency = terms?.currency ?? null
  }

  const context: Omit<Context, "late"> = {
    project: {
      id: projectId,
      key: planning.key,
      name: planning.name,
      companyId: plan?.company_id ?? null,
    },
    basis,
    hpd,
    tz,
    today,
    period,
    rows,
    live,
    ownReal,
    hasEntries,
    cards,
    ledger,
    inPeriod,
    rateMinor,
    currency,
    sourceRepos: Array.isArray(plan?.source_repos) ? plan.source_repos : [],
    changeRequests: (await getEnabledApps(orgId)).includes("agreements"),
  }
  return { ...context, late: await lateWorkOf(tx, orgId, context) }
}

/** The asker's own proposed card for this project and period, if they have one. */
async function ownProposal(tx: Tx, orgId: string, userId: string, c: Context) {
  return extractRows<{ id: string; revision: number }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, revision FROM ${projectsRel("reconciliations")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${c.project.id}::uuid
         AND period_start = ${c.period.from}::date AND created_by = ${userId}::uuid
         AND state = 'proposed'
       LIMIT 1`),
  )[0]
}

/** Work of invoiced periods that their invoices do not hold, for the card being asked. */
interface LateWork {
  /** Closed tasks, on a project billed by the day or the hour. */
  closed: string[]
  /** Closed tasks of periods billed by the day or the hour that this card cannot bill. */
  closedElsewhere: string[]
  /** Hours of invoiced retainer months, per task, oldest month first. */
  months: Array<{ month: string } & MonthMinutes>
  /** Time entered on tasks a card counted by their time, since that card. */
  after: MonthMinutes
  /** The tasks an earlier card counted by their time: never billed again as their own line. */
  byTime: ReadonlySet<string>
  /** Minutes of days outside the retainer's months that no card bills, per task. */
  outside: ReadonlyMap<string, number>
}

async function lateWorkOf(tx: Tx, orgId: string, c: Omit<Context, "late">): Promise<LateWork> {
  const { ledger } = c
  const earlier = c.cards.filter((b) => b.to < c.period.from)
  const months = lateMonths(ledger, earlier)
  const closed = lateClosedTasks(c.cards, c.rows, ledger.claimed, c.period.from)
  const after = laterTime(ledger, c.period.from)
  if (c.basis === "daily" || c.basis === "hourly") {
    const byTime = new Set(
      [...ledger.rest.byTime].filter((id) => (ledger.billedTo.get(id) ?? "") < c.period.from),
    )
    return { closed, closedElsewhere: [], months, after, byTime, outside: closedInFee(c) }
  }
  return {
    closed: [],
    closedElsewhere: [...new Set([...closed, ...after.offered.keys()])],
    months,
    after: { offered: new Map(), leftOut: new Map() },
    byTime: new Set(),
    outside: c.basis === "retainer" ? await beforeRetainer(tx, orgId, c) : new Map(),
  }
}

/**
 * The open minutes of tasks closed inside a retainer month, entered for days outside these months:
 * the task is the retainer's, so no card by the day or the hour lists it.
 */
function closedInFee(c: Omit<Context, "late">): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of c.rows) {
    if (r.completed_on === null || r.completed_on >= c.period.from) continue
    if (!inRetainerMonth(c.cards, r.completed_on) || c.ledger.rest.touched.has(r.id)) continue
    if (c.ledger.inPrice.has(r.id) || c.cards.some((b) => b.excluded.has(r.id))) continue
    const open = c.ledger.rest.open.get(r.id) ?? 0
    if (open > 0) out.set(r.id, open)
  }
  return out
}

/**
 * The open minutes of the days before a retainer's card that are in no month of a retainer: another
 * way of billing the project had, or none. No retainer card bills them.
 */
async function beforeRetainer(
  tx: Tx,
  orgId: string,
  c: Omit<Context, "late">,
): Promise<Map<string, number>> {
  const [y, m, d] = c.period.from.split("-").map(Number) as [number, number, number]
  const eve = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
  const dated = await taskMinutes(tx, c.project.id, "1970-01-01", eve)
  const boxes = extractRows<{ from: string; to: string }>(
    await tx.execute(drizzleSql`
      SELECT period_start::text AS "from", period_end::text AS "to"
        FROM ${projectsRel("project_timeboxes")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${c.project.id}::uuid
         AND source = 'retainer' AND period_start < ${c.period.from}::date`),
  )
  const spans = new Map(
    [...feeMonths(c.cards), ...boxes]
      .filter((b) => b.from < c.period.from)
      .map((b) => [b.from.slice(0, 7), b]),
  )
  for (const span of spans.values())
    for (const [id, minutes] of await taskMinutes(tx, c.project.id, span.from, span.to))
      dated.set(id, (dated.get(id) ?? 0) - minutes)
  const out = new Map<string, number>()
  for (const [id, minutes] of dated) {
    if (c.ledger.inPrice.has(id) || c.cards.some((b) => b.excluded.has(id))) continue
    const open = Math.min(minutes, c.ledger.rest.open.get(id) ?? 0)
    if (open > 0) out.set(id, open)
  }
  return out
}

// ── reconcile_facts ─────────────────────────────────────────────────────────

export interface FactsTask {
  id: string
  key: string | null
  title: string
  status: string
  terminal: boolean
  completedAt: string | null
  parentId: string | null
  isMilestone: boolean
  plannedMinutes: number | null
  realMinutes: number
  /** The same figures in the project's own unit ("1.5 d", "3 h"), as the card and the budget say them. */
  planned: string | null
  real: string
  hasEntries: boolean
  claim: { state: string; documentNumber: string | null } | null
}

export async function reconcileFacts(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  input: { project: string; month?: string; from?: string; to?: string }
  now?: Date
}) {
  const { tx, orgId, userId } = args
  const c = await loadContext({ ...args, ...args.input })
  const planned = plannedByTask(c.live)

  // What is already reserved or billed, by source.
  const claims = extractRows<{
    source_kind: string
    source_ref: string
    state: string
    document_number: string | null
    line_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT c.source_kind, c.source_ref, c.state, c.document_number, c.line_id::text AS line_id
        FROM ${projectsRel("billing_claims")} c
        LEFT JOIN ${projectsRel("reconciliations")} r
          ON r.id = c.reconciliation_id AND r.org_id = c.org_id
       WHERE c.org_id = ${orgId}::uuid AND c.project_id = ${c.project.id}::uuid
         AND c.state IN ('reserved', 'billed', 'left_off')
         AND r.state IS DISTINCT FROM 'credited'
       ORDER BY c.state = 'left_off' DESC`),
  )
  const taskClaim = new Map<string, { state: string; documentNumber: string | null }>()
  for (const cl of claims) {
    if (cl.source_kind === "task") {
      taskClaim.set(cl.source_ref, { state: cl.state, documentNumber: cl.document_number })
    }
  }

  const shape = (r: TaskRow): FactsTask => ({
    id: r.id,
    key: r.key,
    title: r.title,
    status: r.status,
    terminal: r.terminal,
    completedAt: r.completed_at,
    parentId: r.parent_id,
    isMilestone: r.is_milestone,
    plannedMinutes: (planned.get(r.id) ?? 0) > 0 ? (planned.get(r.id) as number) : null,
    realMinutes: c.ownReal.get(r.id) ?? 0,
    planned:
      (planned.get(r.id) ?? 0) > 0 ? worded(planned.get(r.id) as number, c.basis, c.hpd) : null,
    real: worded(c.ownReal.get(r.id) ?? 0, c.basis, c.hpd),
    hasEntries: c.hasEntries.has(r.id),
    claim: taskClaim.get(r.id) ?? null,
  })

  // Earlier work not yet on any document: closed after the last period a document covered and
  // before this one. With no document yet there is no earlier baseline, so nothing is listed.
  const lastBilled = extractRows<{ end: string | null }>(
    await tx.execute(drizzleSql`
      SELECT max(period_end)::text AS "end" FROM ${projectsRel("reconciliations")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${c.project.id}::uuid
         AND (state = 'invoiced' OR (state = 'drafted' AND document_ref IS NOT NULL))`),
  )[0]?.end
  const { late } = c
  const closedLate = new Set(late.closed)
  const unbilledEarlier = lastBilled
    ? c.rows.filter(
        (r) =>
          closedLate.has(r.id) ||
          (!r.archived &&
            r.completed_on !== null &&
            r.completed_on > lastBilled &&
            r.completed_on < c.period.from &&
            !taskClaim.has(r.id)),
      )
    : []
  // Hours of an invoiced retainer month its invoice did not count, month by month, and the time
  // entered after its invoice on a task billed by its time.
  const asLate = (minutesOf: ReadonlyMap<string, number>, month?: string) =>
    [...minutesOf].flatMap(([id, minutes]) => {
      const r = c.rows.find((x) => x.id === id)
      return r
        ? [
            {
              ...shape(r),
              realMinutes: minutes,
              real: worded(minutes, c.basis, c.hpd),
              ...(month ? { workMonth: month } : { afterInvoice: true as const }),
            },
          ]
        : []
    })
  const lateHours = [
    ...late.months.flatMap((m) => asLate(m.offered, m.month)),
    ...asLate(late.after.offered),
  ]
  const byHand = byHandNote(c)
  const lateCount = closedLate.size + lateHours.length

  const inScope = c.live.filter((t) => c.inPeriod.some((r) => r.id === t.id))
  const coverage = coverageOf(
    inScope.map((t) => ({ ...t, parentId: null })),
    c.hasEntries,
  )

  // The client's own people, so the agent can leave their work out.
  const markers = c.project.companyId
    ? extractRows<{ domain: string | null; email: string | null }>(
        await tx.execute(drizzleSql`
          SELECT c.domain, NULL::text AS email FROM ${kernelRel("companies")} c
           WHERE c.id = ${c.project.companyId}::uuid AND c.org_id = ${orgId}::uuid
          UNION ALL
          SELECT NULL::text, ct.email FROM ${kernelRel("contacts")} ct
           WHERE ct.company_id = ${c.project.companyId}::uuid AND ct.org_id = ${orgId}::uuid
             AND ct.email IS NOT NULL
           LIMIT 200`),
      )
    : []
  const company = c.project.companyId
    ? (extractRows<{ id: string; name: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, name FROM ${kernelRel("companies")}
           WHERE id = ${c.project.companyId}::uuid AND org_id = ${orgId}::uuid`),
      )[0] ?? null)
    : null

  const latest = await ownProposal(tx, orgId, userId, c)
  const isLate = c.today > c.period.to
  const unit = c.basis === "daily" ? "day" : "hour"
  const timeboxRow = extractRows<{ minutes: number | null }>(
    await tx.execute(drizzleSql`
      SELECT coalesce(
        (SELECT minutes FROM ${projectsRel("project_timeboxes")}
          WHERE project_id = ${c.project.id}::uuid AND org_id = ${orgId}::uuid
            AND period_start <= ${c.period.to}::date AND period_end >= ${c.period.from}::date
          ORDER BY period_start DESC LIMIT 1),
        (SELECT timebox_minutes FROM ${projectsRel("project_time_plan")}
          WHERE project_id = ${c.project.id}::uuid AND org_id = ${orgId}::uuid)) AS minutes`),
  )[0]

  const tasks = c.inPeriod.map(shape)
  // A retainer bills its month whatever was done: a month with no work still has its card.
  const quietRetainer = c.basis === "retainer" && tasks.length === 0
  return {
    project: {
      id: c.project.id,
      key: c.project.key,
      name: c.project.name,
      basis: c.basis,
      company,
    },
    period: { from: c.period.from, to: c.period.to, label: c.period.label },
    terms: c.rateMinor !== null ? { rate: c.rateMinor / 100, currency: c.currency, unit } : null,
    timebox: timeboxRow?.minutes
      ? {
          minutes: timeboxRow.minutes,
          text: worded(timeboxRow.minutes, c.basis, c.hpd),
          source: "plan",
        }
      : null,
    tasks,
    unbilledEarlier: [
      ...unbilledEarlier.filter((r) => !lateHours.some((l) => l.id === r.id)).map(shape),
      ...lateHours,
    ],
    leftOff: claims
      .filter((cl) => cl.source_kind === "task" && cl.state === "left_off" && cl.line_id !== null)
      .map((cl) => c.rows.find((r) => r.id === cl.source_ref))
      .filter((r): r is TaskRow => Boolean(r))
      .map((r) => ({ key: r.key, title: r.title })),
    coverage,
    // A repository is named only to a reader of its host: to anyone else it is
    // part of what they cannot read, which the card says without naming it.
    sourceRepos: readableSourceRepos(c.sourceRepos, args.scopes),
    clientMarkers: {
      domains: [...new Set(markers.map((m) => m.domain).filter((d): d is string => !!d))],
      contactEmails: [...new Set(markers.map((m) => m.email).filter((e): e is string => !!e))],
    },
    billedRefs: claims
      .filter(
        (cl) =>
          cl.source_kind !== "task" && cl.source_kind !== LINE_SOURCE && cl.state === "billed",
      )
      .map((cl) => ({
        kind: cl.source_kind,
        ref: cl.source_ref,
        documentNumber: cl.document_number,
      })),
    latestProposal: latest ? { id: latest.id, revision: latest.revision } : null,
    late: isLate,
    ...(c.today <= c.period.to ? { notOver: earlyNote(c.period) } : {}),
    ...(byHand ? { billByHand: byHand } : {}),
    message:
      `${tasks.length} task${tasks.length === 1 ? "" : "s"} of ${c.project.name} closed in ${c.period.label}; real time is entered on ${coverage.withEntries} of ${coverage.total}. Nothing was saved.` +
      (c.today <= c.period.to ? ` ${earlyNote(c.period)}` : "") +
      (lateCount > 0
        ? ` ${lateCount} earlier task${lateCount === 1 ? "" : "s"} (unbilledEarlier) had work done after the invoice of ${lateCount === 1 ? "its" : "their"} period: the card lists ${lateCount === 1 ? "it" : "them"} by itself, or on a line of yours that names ${lateCount === 1 ? "it" : "them"}.`
        : "") +
      (byHand ? ` ${byHand}` : "") +
      (quietRetainer
        ? ` A retainer month still has its invoice with no work in it: its monthly fee, less an advance already invoiced for it.`
        : ""),
    next: quietRetainer
      ? "Call reconcile_propose with no lines (lines: []) to save the month's card; Create invoice on it drafts the month's invoice."
      : "Read this period's traces with your own tools (commits, meetings, notes, mail), then call reconcile_propose with the lines. Every figure is worked out by the server.",
  }
}

// ── reconcile_propose ───────────────────────────────────────────────────────

export interface ProposeInput {
  project: string
  month?: string
  from?: string
  to?: string
  lines: unknown
  excluded?: unknown
  notSeen?: unknown
  sources?: unknown
}

interface StoredShape {
  lines: Array<
    Omit<ComputedLine, "proofs"> & {
      proofs: ComputedProof[]
      /** The stored line's id and the person's own changes, absent on a line not yet stored. */
      id?: string
      wording?: string | null
      realNoteMinutes?: number | null
      /** The other project's key, as the asker reads it now: the card's "Move it to" label. */
      otherProjectKey?: string | null
    }
  >
  notSeen: Array<{ source: string; why: string }>
  excludedCount: number
}

/** The trace sources a reconcile reads, and the scope that reads each one. */
export const TRACE_SOURCES: ReadonlyArray<{ source: string; scope: string }> = [
  { source: "GitHub", scope: "github:repo:read" },
  { source: "GitLab", scope: "gitlab:repo:read" },
  { source: "Calendar", scope: "calendar:events:read" },
  { source: "Knowledge", scope: "knowledge:documents:read" },
]
export const NOT_YOURS_TO_READ = "you cannot read it here"
/** Why a meeting or a document cited as proof was dropped: the asker cannot open that record. */
export const RECORD_NOT_YOURS = "a record cited as proof is not one you can open"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The records a proof may cite that belong to someone: a calendar event (a person's own calendar
 * is theirs alone) and a knowledge document (one shared with named people only). Each is read
 * again under the asker's own rows, like a task, so a proof naming one they cannot open never
 * reaches the card.
 */
const OWNED_PROOFS: ReadonlyArray<{
  kind: ProofKind
  source: string
  schema: string
  table: string
}> = [
  { kind: "calendar_event", source: "Calendar", schema: "app_calendar", table: "events" },
  { kind: "knowledge_doc", source: "Knowledge", schema: "app_knowledge", table: "documents" },
]

/** The cited record ids the asker can open, per proof kind; a kind whose app is absent reads none. */
async function readableProofRefs(
  tx: Tx,
  orgId: string,
  lines: readonly ProposedLine[],
): Promise<Map<ProofKind, Set<string>>> {
  const out = new Map<ProofKind, Set<string>>()
  for (const owned of OWNED_PROOFS) {
    const ids = [
      ...new Set(
        lines.flatMap((l) =>
          l.proofs.filter((p) => p.kind === owned.kind && UUID_RE.test(p.ref)).map((p) => p.ref),
        ),
      ),
    ]
    const seen = new Set<string>()
    out.set(owned.kind, seen)
    if (ids.length === 0) continue
    const rel = `${schemaRef(owned.schema)}.${owned.table}`
    const present = extractRows<{ t: string | null }>(
      await tx.execute(drizzleSql`SELECT to_regclass(${rel})::text AS t`),
    )[0]?.t
    if (!present) continue
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${drizzleSql.raw(rel)}
         WHERE org_id = ${orgId}::uuid AND id = ANY(${`{${ids.join(",")}}`}::uuid[])`),
    )
    for (const r of rows) seen.add(r.id.toLowerCase())
  }
  return out
}

/** The project's source repositories on a host whose trace scope the caller holds. */
export function readableSourceRepos(
  repos: ReadonlyArray<{ provider: string; repo: string }>,
  scopes: readonly string[],
): Array<{ provider: string; repo: string }> {
  return repos.filter((r) => {
    const host = TRACE_SOURCES.find((t) => t.source.toLowerCase() === r.provider.toLowerCase())
    return !!host && hasScope(host.scope, [...scopes])
  })
}

/**
 * What the agent said it did not see, plus every trace source the caller's scopes for this call
 * cannot read (a person's own, or narrowed by the agent they talk to): the card says so even when
 * the agent did not notice the tool was missing.
 */
function withUnreadable(
  notSeen: Array<{ source: string; why: string }>,
  scopes: readonly string[],
): Array<{ source: string; why: string }> {
  const out = [...notSeen]
  for (const t of TRACE_SOURCES) {
    if (hasScope(t.scope, [...scopes])) continue
    if (out.some((n) => n.source.toLowerCase() === t.source.toLowerCase())) continue
    out.push({ source: t.source, why: NOT_YOURS_TO_READ })
  }
  return out
}

function readNotSeen(raw: unknown): Array<{ source: string; why: string }> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new ProjectsServiceError(400, "invalid_params", "notSeen is a list of {source, why}.")
  }
  return raw
    .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
    .map((n) => ({
      source: String(n.source ?? "").slice(0, 60),
      why: String(n.why ?? "").slice(0, 200),
    }))
    .filter((n) => n.source !== "")
}

function readExcluded(raw: unknown): Array<{ taskId: string; reason: "client_own" }> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new ProjectsServiceError(400, "invalid_params", "excluded is a list of {taskId, reason}.")
  }
  return raw.map((e, i) => {
    const r = e as Record<string, unknown>
    if (!r || typeof r.taskId !== "string" || r.reason !== "client_own") {
      throw new ProjectsServiceError(
        400,
        "invalid_params",
        `excluded ${i + 1}: a task is left out only as the client's own work (reason client_own).`,
      )
    }
    return { taskId: r.taskId, reason: "client_own" as const }
  })
}

/** Two cards say the same: the tag is worked out again, and proofs compare in one order. */
function sameShape(a: StoredShape, b: StoredShape): boolean {
  const canon = (s: StoredShape) =>
    JSON.stringify({
      notSeen: s.notSeen,
      excludedCount: s.excludedCount,
      lines: s.lines.map((l) => [
        l.position,
        l.name,
        l.why ?? null,
        l.kind,
        l.reason ?? null,
        l.taskIds,
        l.plannedMinutes,
        l.realMinutes,
        l.traceEstimateMinutes,
        l.billMinutes,
        l.otherProjectId ?? null,
        l.workMonth ?? null,
        Object.entries(l.counting ?? {}).sort(([x], [y]) => x.localeCompare(y)),
        [...l.proofs]
          .sort((x, y) =>
            `${x.kind}|${x.ref}|${x.label}`.localeCompare(`${y.kind}|${y.ref}|${y.label}`),
          )
          .map((p) => [p.kind, p.ref, p.label, p.url ?? null, p.occurredOn ?? null]),
      ]),
    })
  return canon(a) === canon(b)
}

async function readStored(tx: Tx, orgId: string, id: string): Promise<StoredShape> {
  const head = extractRows<{
    not_seen: StoredShape["notSeen"]
    excluded_count: number
    basis: Basis
  }>(
    await tx.execute(drizzleSql`
      SELECT not_seen, excluded_count, basis FROM ${projectsRel("reconciliations")}
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  const lines = extractRows<{
    id: string
    position: number
    name: string
    why: string | null
    kind: ComputedLine["kind"]
    reason: ComputedLine["reason"] | null
    task_ids: string[]
    planned_minutes: number | null
    real_minutes: number | null
    trace_estimate_minutes: number | null
    bill_minutes: number
    wording: string | null
    real_note_minutes: number | null
    other_project_id: string | null
    other_project_key: string | null
    work_month: string | null
    counting: Counting | null
  }>(
    await tx.execute(drizzleSql`
      SELECT l.id::text AS id, l.position, l.name, l.why, l.kind, l.reason,
             l.task_ids::text[] AS task_ids, l.planned_minutes, l.real_minutes,
             l.trace_estimate_minutes, l.bill_minutes, l.wording, l.real_note_minutes,
             l.other_project_id::text AS other_project_id, op.key AS other_project_key,
             l.work_month, l.counting
        FROM ${projectsRel("reconciliation_lines")} l
        LEFT JOIN ${projectsRel("projects")} op
          ON op.id = l.other_project_id AND op.org_id = l.org_id AND op.archived_at IS NULL
       WHERE l.reconciliation_id = ${id}::uuid AND l.org_id = ${orgId}::uuid
       ORDER BY l.position`),
  )
  const proofs = extractRows<{
    line_id: string
    kind: ComputedProof["kind"]
    ref: string
    label: string
    url: string | null
    occurred_on: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT p.line_id::text AS line_id, p.kind, p.ref, p.label, p.url,
             p.occurred_on::text AS occurred_on
        FROM ${projectsRel("reconciliation_proofs")} p
        JOIN ${projectsRel("reconciliation_lines")} l ON l.id = p.line_id
       WHERE l.reconciliation_id = ${id}::uuid AND p.org_id = ${orgId}::uuid
       ORDER BY p.created_at, p.id`),
  )
  // The period had a plan when any stored line carries planned time.
  const periodPlanned = lines.some((l) => (l.planned_minutes ?? 0) > 0)
  return {
    lines: lines.map((l) => ({
      id: l.id,
      ...(l.wording !== null ? { wording: l.wording } : {}),
      ...(l.real_note_minutes !== null ? { realNoteMinutes: l.real_note_minutes } : {}),
      position: l.position,
      name: l.name,
      ...(l.why ? { why: l.why } : {}),
      kind: l.kind,
      ...(l.reason ? { reason: l.reason } : {}),
      // The one tag a line carries is worked out from its figures, as when it was computed.
      ...(head
        ? (() => {
            const { tag } = defaultBill(
              head.basis,
              l.kind as LineKind,
              l.planned_minutes,
              l.real_minutes ?? 0,
              periodPlanned,
            )
            return tag && l.bill_minutes === 0 ? { tag } : {}
          })()
        : {}),
      taskIds: l.task_ids,
      plannedMinutes: l.planned_minutes,
      realMinutes: l.real_minutes ?? 0,
      traceEstimateMinutes: l.trace_estimate_minutes,
      billMinutes: l.bill_minutes,
      ...(l.other_project_id ? { otherProjectId: l.other_project_id } : {}),
      ...(l.other_project_key ? { otherProjectKey: l.other_project_key } : {}),
      ...(l.work_month ? { workMonth: l.work_month } : {}),
      ...(l.counting ? { counting: l.counting } : {}),
      proofs: proofs
        .filter((p) => p.line_id === l.id)
        .map((p) => ({
          kind: p.kind,
          ref: p.ref,
          label: p.label,
          ...(p.url ? { url: p.url } : {}),
          ...(p.occurred_on ? { occurredOn: p.occurred_on } : {}),
        })),
    })),
    // jsonb keeps its keys in its own order: read each entry back in the shape it was written.
    notSeen: (head?.not_seen ?? []).map((n) => ({ source: n.source, why: n.why })),
    excludedCount: head?.excluded_count ?? 0,
  }
}

/** A uuid[] literal of ids read from the database. */
function uuidList(ids: readonly string[]): string {
  return `{${ids.filter((id) => UUID_RE.test(id)).join(",")}}`
}

async function writeLines(tx: Tx, orgId: string, id: string, lines: StoredShape["lines"]) {
  for (const l of lines) {
    const inserted = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("reconciliation_lines")}
          (org_id, reconciliation_id, position, name, why, kind, reason, task_ids,
           planned_minutes, real_minutes, trace_estimate_minutes, bill_minutes, other_project_id,
           work_month, counting)
        VALUES (${orgId}::uuid, ${id}::uuid, ${l.position}, ${l.name}, ${l.why ?? null},
          ${l.kind}, ${l.reason ?? null},
          ${`{${l.taskIds.join(",")}}`}::uuid[], ${l.plannedMinutes}, ${l.realMinutes},
          ${l.traceEstimateMinutes}, ${l.billMinutes}, ${l.otherProjectId ?? null}::uuid,
          ${l.workMonth ?? null}, ${l.counting ? JSON.stringify(l.counting) : null}::jsonb)
        RETURNING id::text AS id`),
    )
    const lineId = inserted[0]!.id
    for (const p of l.proofs) {
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("reconciliation_proofs")}
          (org_id, line_id, kind, ref, label, url, occurred_on)
        VALUES (${orgId}::uuid, ${lineId}::uuid, ${p.kind}, ${p.ref}, ${p.label},
          ${p.url ?? null}, ${p.occurredOn ?? null}::date)`)
    }
  }
}

/**
 * The projects the lines say their work belongs to, by key or id, read under the asker's own
 * rows. A project the asker cannot read, an archived one or this one is refused, so a card never
 * offers a move it cannot make.
 */
async function resolveOtherProjects(
  tx: Tx,
  orgId: string,
  ownProjectId: string,
  lines: readonly ProposedLine[],
): Promise<Map<string, string>> {
  const refs = [
    ...new Set(
      lines
        .map((l) => l.otherProjectKey?.trim().toLowerCase())
        .filter((r): r is string => Boolean(r)),
    ),
  ]
  const out = new Map<string, string>()
  if (refs.length === 0) return out
  // A text[] literal: each ref quoted, with the two characters a quoted element escapes.
  const list = `{${refs.map((r) => `"${r.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`).join(",")}}`
  const rows = extractRows<{ id: string; key: string | null }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, key FROM ${projectsRel("projects")}
       WHERE org_id = ${orgId}::uuid AND archived_at IS NULL
         AND (lower(key) = ANY(${list}::text[]) OR id::text = ANY(${list}::text[]))`),
  )
  for (const r of rows) {
    if (r.key) out.set(r.key.toLowerCase(), r.id)
    out.set(r.id.toLowerCase(), r.id)
  }
  const missing = refs.filter((r) => !out.has(r))
  if (missing.length > 0) {
    throw new ProjectsServiceError(
      400,
      "project_not_found",
      `No project ${missing.join(", ")} you can read, so no line can be moved there. Nothing was saved.`,
      {
        projects: missing,
        next: "Send the line again with the key of a project the person can open, or without otherProjectKey.",
      },
    )
  }
  const own = refs.filter((r) => out.get(r) === ownProjectId)
  if (own.length > 0) {
    throw new ProjectsServiceError(
      400,
      "invalid_params",
      `${own.join(", ")} is the project being reconciled; otherProjectKey names another one. Nothing was saved.`,
      {
        next: "Send the line again without otherProjectKey, or with the project the work belongs to.",
      },
    )
  }
  return out
}

export async function reconcilePropose(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  threadId?: string
  input: ProposeInput
  now?: Date
  /** Where the call came from: a coding agent's call also gets the card as terminal text. */
  origin?: string
}) {
  const { tx, orgId, userId, input } = args
  // The shape first: a line carrying a figure is refused before anything is read.
  const proposed = readProposedLines(input.lines)
  const excluded = readExcluded(input.excluded)
  const notSeen = withUnreadable(readNotSeen(input.notSeen), args.scopes)
  const c = await loadContext({
    tx,
    orgId,
    scopes: args.scopes,
    project: input.project,
    ...(input.month !== undefined ? { month: input.month } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(args.now ? { now: args.now } : {}),
  })

  // No member of the team is named on a line; a client's contact may be.
  const members = extractRows<{ name: string | null; email: string | null }>(
    await tx.execute(drizzleSql`
      SELECT name, email FROM ${kernelRel("users")}
       WHERE org_id = ${orgId}::uuid AND status = 'active'`),
  )
  for (const line of proposed) {
    const hit = namedMember(`${line.name}\n${line.why ?? ""}`, members)
    if (hit) {
      throw new ProjectsServiceError(
        400,
        "names_a_person",
        `"${line.name}" names someone on the team. A line says what was done, never who did it. Nothing was saved.`,
        {
          line: line.name,
          next: "Send the line again worded by the work alone. A client's own contact may be named.",
        },
      )
    }
  }

  // Task references are re-read under the asker's own rows: an id or a key of this project.
  const byRef = new Map<string, TaskRow>()
  for (const r of c.rows) {
    if (r.archived) continue
    byRef.set(r.id, r)
    if (r.key) byRef.set(r.key.toLowerCase(), r)
  }
  const resolve = (ref: string) => byRef.get(ref) ?? byRef.get(ref.toLowerCase())
  const unknown: string[] = []
  const repoHosts = repoHostsOf(c.sourceRepos)
  const otherProjects = await resolveOtherProjects(tx, orgId, c.project.id, proposed)
  const readable = await readableProofRefs(tx, orgId, proposed)
  const unreadable = new Set<string>()
  const linesIn = proposed.map((line: ProposedLine) => {
    const resolvedTaskIds: string[] = []
    for (const ref of line.taskIds) {
      const t = resolve(ref)
      if (t) {
        if (!resolvedTaskIds.includes(t.id)) resolvedTaskIds.push(t.id)
      } else unknown.push(ref)
    }
    const proofsOut: ComputedProof[] = []
    for (const p of line.proofs) {
      if (p.kind === "task") {
        const t = resolve(p.ref)
        if (!t) continue
        proofsOut.push({
          kind: "task",
          ref: t.id,
          label: unnamedProofLabel(
            proofLabel({ ...p, label: t.key ?? t.title }),
            { ...p, ref: t.key ?? "Task" },
            members,
          ),
        })
        continue
      }
      const owned = OWNED_PROOFS.find((o) => o.kind === p.kind)
      if (owned && UUID_RE.test(p.ref) && !readable.get(owned.kind)?.has(p.ref.toLowerCase())) {
        unreadable.add(owned.source)
        continue
      }
      const url = keptProofUrl(p, repoHosts)
      proofsOut.push({
        kind: p.kind,
        ref: p.ref,
        label: unnamedProofLabel(proofLabel(p), p, members),
        ...(url ? { url } : {}),
        ...(p.occurredOn ? { occurredOn: p.occurredOn } : {}),
      })
    }
    const otherProjectId = line.otherProjectKey
      ? otherProjects.get(line.otherProjectKey.trim().toLowerCase())
      : undefined
    return { ...line, resolvedTaskIds, proofsOut, ...(otherProjectId ? { otherProjectId } : {}) }
  })
  if (unknown.length > 0) {
    throw new ProjectsServiceError(
      400,
      "task_not_found",
      `No task ${unknown.join(", ")} in ${c.project.name}. Nothing was saved.`,
      { tasks: unknown, next: "Use the task ids or keys reconcile_facts returned." },
    )
  }

  // Every task of the period is on the card: what no line lists goes to "Other closed tasks",
  // unless it was left out as the client's own work.
  const listed = new Set(linesIn.flatMap((l) => l.resolvedTaskIds))
  const excludedIds = new Set(
    excluded.map((e) => resolve(e.taskId)?.id).filter((id): id is string => Boolean(id)),
  )
  const { late } = c
  const unlisted = c.inPeriod
    .map((r) => r.id)
    .filter((id) => !listed.has(id) && !excludedIds.has(id) && !late.byTime.has(id))

  // Work of an invoiced period done after its invoice is on the card too: on a line that names its
  // tasks, else on one of its own.
  const lateClosed = late.closed.filter((id) => !listed.has(id) && !excludedIds.has(id))
  const inPeriodIds = new Set(c.inPeriod.map((r) => r.id))
  const plannedNow = plannedByTask(c.live)
  // A task of work in the plan above or under work billed, or on this card, may already be inside
  // what that bills: it is listed at 0, for a person to set. Without a plan its minutes say it.
  const parentOf = new Map(c.rows.map((r) => [r.id, r.parent_id]))
  const above = (id: string): string[] => {
    const out: string[] = []
    for (let p = parentOf.get(id); p && !out.includes(p); p = parentOf.get(p)) out.push(p)
    return out
  }
  const counted = [...c.ledger.claimed, ...listed, ...inPeriodIds]
  const aboveCounted = new Set(counted.flatMap(above))
  const isCounted = new Set(counted)
  const completedOn = new Map(c.rows.map((r) => [r.id, r.completed_on ?? ""]))
  const inPlan = (id: string) => (plannedNow.get(id) ?? 0) > 0
  const related = (id: string) =>
    (aboveCounted.has(id) || above(id).some((p) => isCounted.has(p))) &&
    (c.ledger.inPrice.has(id) || [id, ...above(id)].some(inPlan))
  const inGap = (id: string) => !coveredByCard(c.cards, completedOn.get(id) ?? "")
  const lateGroups = [
    { name: LATE_LINE_NAME, keep: (id: string) => inPlan(id) && !inGap(id) },
    { name: LATE_UNPLANNED_LINE_NAME, keep: (id: string) => !inPlan(id) && !inGap(id) },
    { name: LATE_GAP_LINE_NAME, keep: (id: string) => inPlan(id) && inGap(id) },
    { name: LATE_GAP_UNPLANNED_LINE_NAME, keep: (id: string) => !inPlan(id) && inGap(id) },
  ]
    .map((g) => ({ name: g.name, ids: lateClosed.filter((id) => !related(id) && g.keep(id)) }))
    .concat([{ name: LATE_RELATED_LINE_NAME, ids: lateClosed.filter(related) }])
    .filter((g) => g.ids.length > 0)
    .map((g) => ({
      name: g.name,
      taskIds: g.ids,
      proofs: [],
      resolvedTaskIds: g.ids,
      proofsOut: [] as ComputedProof[],
    }))
  const named = new Set<string>()
  // What a line that names a task bills of its later time: what a card left out of it comes back.
  const withLeftOut = (m: MonthMinutes, id: string) =>
    (m.offered.get(id) ?? 0) + (m.leftOut.get(id) ?? 0)
  // A line of late tasks alone is their month's hours, or the time entered after their invoice;
  // its tasks' own time of this period is this card's other lines.
  const lateMonthOf = (ids: readonly string[]) =>
    ids.length > 0 && ids.every((id) => !inPeriodIds.has(id))
      ? late.months.find((m) =>
          ids.every((id) => withLeftOut(m, id) > 0 && !named.has(`${m.month} ${id}`)),
        )
      : undefined
  // A planned task only left out of a card is billed at its plan when a line names it.
  const isAfter = (ids: readonly string[]) =>
    ids.length > 0 &&
    ids.every(
      (id) =>
        late.byTime.has(id) &&
        withLeftOut(late.after, id) > 0 &&
        !named.has(` ${id}`) &&
        (c.ledger.rest.held.has(id) || !inPlan(id)),
    )
  const ownLines: typeof linesIn = []
  const lateLines: Array<Omit<ComputedLine, "position">> = []
  const lateLine = (
    month: string | null,
    name: string,
    ids: string[],
    minutesOf: (id: string) => number,
    extra: Pick<ComputedLine, "why" | "proofs">,
    auto = false,
  ) => {
    const real = ids.reduce((a, id) => a + minutesOf(id), 0)
    for (const id of ids) named.add(`${month ?? ""} ${id}`)
    lateLines.push({
      name,
      kind: "unplanned",
      taskIds: ids,
      plannedMinutes: null,
      realMinutes: real,
      traceEstimateMinutes: null,
      billMinutes: real,
      ...(month ? { workMonth: month } : {}),
      counting: { later: true, ...(auto ? { auto: true as const } : {}) },
      ...extra,
    })
  }
  for (const line of linesIn) {
    const ids = line.resolvedTaskIds
    const m = lateMonthOf(ids)
    const extra = { ...(line.why ? { why: line.why } : {}), proofs: line.proofsOut }
    if (m) lateLine(m.month, line.name, ids, (id) => withLeftOut(m, id), extra)
    else if (isAfter(ids))
      lateLine(null, line.name, ids, (id) => withLeftOut(late.after, id), extra)
    else ownLines.push(line)
  }
  // A fixed price, or no basis at all, makes no invoice from its card: what is owed is said.
  const billable = c.basis !== "fixed" && c.basis !== "none"
  for (const m of billable ? late.months : []) {
    const ids = [...m.offered.keys()].filter(
      (id) => !named.has(`${m.month} ${id}`) && !excludedIds.has(id),
    )
    if (ids.length > 0)
      lateLine(
        m.month,
        lateMonthLineName(m.month),
        ids,
        (id) => m.offered.get(id) ?? 0,
        { proofs: [] },
        true,
      )
  }
  const afterIds = [...late.after.offered.keys()].filter(
    (id) => !named.has(` ${id}`) && !excludedIds.has(id) && !listed.has(id),
  )
  // A task its card left off has no invoice to say; one whose invoice was credited has none left.
  const afterGroup = (id: string) =>
    c.ledger.credited.has(id)
      ? LATE_CREDITED_LINE_NAME
      : c.ledger.rest.held.has(id)
        ? LATE_TIME_LINE_NAME
        : LATE_LEFT_LINE_NAME
  for (const name of [LATE_TIME_LINE_NAME, LATE_LEFT_LINE_NAME, LATE_CREDITED_LINE_NAME]) {
    const ids = afterIds.filter((id) => afterGroup(id) === name)
    if (ids.length > 0)
      lateLine(null, name, ids, (id) => late.after.offered.get(id) ?? 0, { proofs: [] }, true)
  }
  const ownMonth = c.basis === "retainer" ? c.period.from.slice(0, 7) : null
  const computed: ComputedLine[] = computeLines({
    basis: c.basis,
    hoursPerDayMinutes: c.hpd,
    projectTasks: c.live,
    ownReal: c.ownReal,
    ...(billable ? { share: shareOf(c.ledger, ownMonth, excludedIds) } : {}),
    lines: [...ownLines, ...lateGroups],
    unlisted,
  })
  for (const l of computed) if (l.name === LATE_RELATED_LINE_NAME) l.billMinutes = 0
  for (const l of lateLines) computed.push({ ...l, position: computed.length })
  // What was billed and taken off its task since comes off what this card bills of the same month,
  // or project, in the card's order.
  if (billable) {
    const spareOf = spares(c.ledger, ownMonth)
    for (const l of computed) {
      const spare = spareOf(l.workMonth ?? null)
      if (!spare || (l.plannedMinutes ?? 0) > 0 || l.name === LATE_RELATED_LINE_NAME) continue
      const counting = { ...l.counting }
      l.billMinutes = takeSpare(spare, l.billMinutes, counting)
      if (counting.netted) l.counting = counting
    }
  }
  const shape: StoredShape = {
    lines: computed,
    // A cited meeting or document the asker cannot open is said, never shown.
    notSeen: [
      ...notSeen,
      ...[...unreadable]
        .filter((source) => !notSeen.some((n) => n.source.toLowerCase() === source.toLowerCase()))
        .map((source) => ({ source, why: RECORD_NOT_YOURS })),
    ],
    excludedCount: [...excludedIds].filter((id) => c.inPeriod.some((r) => r.id === id)).length,
  }

  // A period already on a draft or an invoice is not proposed again: whoever can read that card
  // gets it, as stored, until the draft is issued or released (no second row for the period).
  const onInvoice = extractRows<{
    id: string
    revision: number
    state: StoredHead["state"]
    created_by: string
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, revision, state, created_by::text AS created_by
        FROM ${projectsRel("reconciliations")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${c.project.id}::uuid
         AND period_start = ${c.period.from}::date
         AND (state = 'invoiced' OR (state = 'drafted' AND document_ref IS NOT NULL))
       ORDER BY updated_at DESC
       LIMIT 1`),
  )[0]
  if (onInvoice) {
    return cardData({
      c,
      id: onInvoice.id,
      revision: onInvoice.revision,
      outcome: "unchanged",
      state: onInvoice.state,
      shape: await readStored(tx, orgId, onInvoice.id),
      viewerId: userId,
      createdBy: onInvoice.created_by,
      said:
        onInvoice.state === "drafted"
          ? "This period is already on an invoice draft, so its card is returned as stored; nothing new was saved."
          : "This period is already invoiced, so its card is returned as stored; nothing new was saved.",
      ...(args.origin ? { origin: args.origin } : {}),
    })
  }

  // One proposed card per asker, project and period: asked again unchanged, the same row and
  // revision come back; changed, its lines are replaced and the revision moves on.
  const existing = await ownProposal(tx, orgId, userId, c)
  let id: string
  let revision: number
  let outcome: "created" | "unchanged" | "revised"
  if (existing && sameShape(await readStored(tx, orgId, existing.id), shape)) {
    id = existing.id
    revision = existing.revision
    outcome = "unchanged"
  } else if (existing) {
    id = existing.id
    revision = existing.revision + 1
    outcome = "revised"
    await tx.execute(drizzleSql`
      DELETE FROM ${projectsRel("reconciliation_lines")}
       WHERE reconciliation_id = ${id}::uuid AND org_id = ${orgId}::uuid`)
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliations")}
         SET revision = ${revision}, not_seen = ${JSON.stringify(shape.notSeen)}::jsonb,
             excluded_count = ${shape.excludedCount}, excluded_task_ids = ${uuidList([...excludedIds])}::uuid[],
             basis = ${c.basis},
             period_end = ${c.period.to}::date,
             thread_id = coalesce(${args.threadId ?? null}::uuid, thread_id), updated_at = now()
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`)
    await writeLines(tx, orgId, id, computed)
  } else {
    id = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("reconciliations")}
          (org_id, project_id, period_start, period_end, basis, state, created_by, thread_id,
           not_seen, excluded_count, excluded_task_ids)
        VALUES (${orgId}::uuid, ${c.project.id}::uuid, ${c.period.from}::date,
          ${c.period.to}::date, ${c.basis}, 'proposed', ${userId}::uuid,
          ${args.threadId ?? null}::uuid, ${JSON.stringify(shape.notSeen)}::jsonb,
          ${shape.excludedCount}, ${uuidList([...excludedIds])}::uuid[])
        RETURNING id::text AS id`),
    )[0]!.id
    revision = 1
    outcome = "created"
    await writeLines(tx, orgId, id, computed)
  }
  if (outcome !== "unchanged") {
    // No minutes, names or trace text in the event: which card, and its revision.
    await tx.queueEvent({
      app: "projects",
      entity: "reconciliation",
      action: "proposed",
      entityId: id,
      data: { reconciliationId: id, projectId: c.project.id, revision },
      actorId: userId,
      actorType: "user",
      orgId,
    })
  }

  return cardData({
    c,
    id,
    revision,
    outcome,
    shape: await readStored(tx, orgId, id),
    ...(args.origin ? { origin: args.origin } : {}),
    ...(args.origin === "mcp" ? { link: await cardLink(orgId, id) } : {}),
  })
}

/** The card's data: what the `reconcile` card draws, worded in the project's unit. */
function cardData(args: {
  c: Context
  id: string
  revision: number
  outcome: "created" | "unchanged" | "revised" | "edited"
  shape: StoredShape
  state?: "proposed" | "drafted" | "invoiced" | "credited"
  said?: string
  origin?: string
  /** Where a person opens the card in Liaison: told to a coding agent, which cannot press Create. */
  link?: string | null
  /** Who reads the card and who made it: past proposed, a time-spent note is its author's alone. */
  viewerId?: string
  createdBy?: string
}) {
  const { c, id, revision, outcome } = args
  const state = args.state ?? "proposed"
  const shape = {
    ...args.shape,
    lines: linesForViewer(args.shape.lines, state, args.viewerId, args.createdBy),
  }
  const q = (m: number) => worded(m, c.basis, c.hpd)
  const whyOf = (l: { why?: string; counting?: Counting }) =>
    [l.why, countingSaid(l.counting, c.basis, c.hpd)].filter(Boolean).join(" ")
  const money =
    c.rateMinor !== null && (c.basis === "daily" || c.basis === "hourly" || c.basis === "retainer")
  const amount = (m: number) => {
    const a = amountMinor(m, c.basis, c.rateMinor, c.hpd)
    return a === null ? null : a / 100
  }
  const lines = shape.lines.map((l) => ({
    ...(l.id ? { lineId: l.id } : {}),
    position: l.position,
    name: l.wording?.trim() ? l.wording : l.name,
    ...(whyOf(l) ? { why: whyOf(l) } : {}),
    kind: l.kind,
    ...(l.reason ? { reason: l.reason } : {}),
    ...(l.tag ? { tag: l.tag } : {}),
    taskIds: l.taskIds,
    ...(l.workMonth ? { workMonth: l.workMonth } : {}),
    ...(l.otherProjectKey ? { otherProject: l.otherProjectKey } : {}),
    plannedMinutes: l.plannedMinutes,
    realMinutes: l.realMinutes,
    traceEstimateMinutes: l.traceEstimateMinutes,
    billMinutes: l.billMinutes,
    planned: l.plannedMinutes !== null ? q(l.plannedMinutes) : null,
    real:
      l.realNoteMinutes !== null && l.realNoteMinutes !== undefined
        ? q(l.realNoteMinutes)
        : l.realMinutes > 0
          ? q(l.realMinutes)
          : l.traceEstimateMinutes !== null
            ? `~${q(l.traceEstimateMinutes)}`
            : null,
    bill: q(l.billMinutes),
    // A retainer's time lines carry no amount: the month bills its fee and the hours above it.
    ...(money && c.basis !== "retainer" ? { amount: amount(l.billMinutes) } : {}),
    proofs: l.proofs.map((p) => ({
      kind: p.kind,
      label: p.label,
      ...(p.url ? { url: p.url } : {}),
    })),
  }))
  const billMinutes = shape.lines.reduce((s, l) => s + l.billMinutes, 0)
  const inScope = c.live.filter((t) => c.inPeriod.some((r) => r.id === t.id))
  const coverage = coverageOf(
    inScope.map((t) => ({ ...t, parentId: null })),
    c.hasEntries,
  )
  const unplannedAtZero = shape.lines.filter((l) => l.kind === "unplanned" && l.billMinutes === 0)
  const late = c.today > c.period.to ? lateNote(c.period) : null
  // A period still running may be invoiced, and the card says so: while it can be, and once it is.
  const early = c.today <= c.period.to ? earlyNote(c.period) : null
  const notes: string[] = []
  if (late) notes.push(late)
  if (early) notes.push(early)
  const byHand = state === "proposed" ? byHandNote(c) : null
  if (byHand) notes.push(byHand)
  if (shape.notSeen.length > 0 || coverage.total === 0) notes.push(NOT_EVERYTHING_SEEN)
  // The sum of the lines as priced one by one, as the invoice adds them up.
  const linesMinor =
    money && c.basis !== "retainer"
      ? linesAmountMinor(
          shape.lines.map((l) => l.billMinutes),
          c.basis,
          c.rateMinor,
          c.hpd,
        )
      : null
  const totalAmount = linesMinor === null ? null : linesMinor / 100
  const said =
    args.said ??
    (outcome === "unchanged"
      ? `Nothing changed since revision ${revision}; the same card is returned.`
      : outcome === "revised"
        ? `The card was updated to revision ${revision}.`
        : "The card was saved; only you can see it.")
  const card = reconcileCardFields({
    state,
    basis: c.basis,
    hoursPerDayMinutes: c.hpd,
    projectName: c.project.name,
    periodLabel: c.period.label,
    lines: shape.lines.map((l, i) => ({
      id: l.id ?? `line-${i}`,
      position: l.position,
      name: l.name,
      ...(l.wording !== undefined ? { wording: l.wording } : {}),
      ...(whyOf(l) ? { why: whyOf(l) } : {}),
      kind: l.kind,
      ...(l.tag ? { tag: l.tag } : {}),
      plannedMinutes: l.plannedMinutes,
      realMinutes: l.realMinutes,
      ...(l.realNoteMinutes !== undefined ? { realNoteMinutes: l.realNoteMinutes } : {}),
      traceEstimateMinutes: l.traceEstimateMinutes,
      billMinutes: l.billMinutes,
      taskIds: l.taskIds,
      ...(l.otherProjectId && l.otherProjectKey
        ? { moveTo: { projectId: l.otherProjectId, key: l.otherProjectKey } }
        : {}),
      proofs: l.proofs.map((p) => ({ label: p.label, ...(p.url ? { url: p.url } : {}) })),
    })),
    rateMinor: money ? c.rateMinor : null,
    currency: c.currency,
    changeRequests: c.changeRequests,
    coverage,
    notSeen: shape.notSeen,
    excludedCount: shape.excludedCount,
    late: late ?? early,
    byHand,
  })
  const coverageText = `Real time entered on ${coverage.withEntries} of ${coverage.total} tasks`
  const amountText =
    totalAmount !== null ? `${totalAmount.toFixed(2)} ${c.currency ?? ""}`.trim() : null
  return {
    reconciliationId: id,
    revision,
    state,
    outcome,
    project: { id: c.project.id, key: c.project.key, name: c.project.name, basis: c.basis },
    period: { from: c.period.from, to: c.period.to, label: c.period.label },
    late: c.today > c.period.to,
    lines,
    totals: {
      billMinutes,
      bill: q(billMinutes),
      ...(totalAmount !== null ? { amountExclVat: totalAmount, currency: c.currency } : {}),
    },
    coverage,
    coverageText,
    notSeen: shape.notSeen,
    excludedCount: shape.excludedCount,
    ...card,
    // The card's notes are its own; the tool's notes list what the agent says.
    notes,
    cardNotes: card.notes,
    ...(args.origin === "mcp"
      ? {
          text: reconcileCodingAgentText({
            title: card.title,
            lines: card.groups.flatMap((g) => g.rows),
            billText: q(billMinutes),
            amountText,
            coverageText,
            notSeen: shape.notSeen,
            link: args.link ?? null,
          }),
        }
      : {}),
    // The card's money state. Create invoice is added by the handler once invoicing has priced
    // the lines and found nothing missing; every key is present, null when it does not apply.
    createInvoice: null as "yes" | null,
    /** A retainer month above its hours: the card also offers Create without the overage. */
    waiveOverage: null as true | null,
    summary: state === "drafted" ? `On draft: ${draftTitle(c)}.` : null,
    undo: state === "drafted" ? ("yes" as const) : null,
    locked: state === "invoiced" ? ("yes" as const) : null,
    ...(early ? { notOver: early } : {}),
    message: `${c.project.name}, ${c.period.label}: ${lines.length} line${lines.length === 1 ? "" : "s"}, ${q(billMinutes)} to bill${amountText ? ` (${amountText} excluding VAT)` : ""}${unplannedAtZero.length > 0 ? `, ${unplannedAtZero.length} not in the plan left off the bill` : ""}. ${said} ${STATE_SAID[state]}${early ? ` ${early}` : ""}`,
    next:
      state !== "proposed"
        ? STATE_NEXT[state]
        : args.origin === "mcp"
          ? CODING_AGENT_CARD_NEXT
          : CARD_NEXT,
  }
}

/**
 * What was done after an invoice that this card cannot bill, in words: how much, and how to bill it
 * by hand. Null when there is none, or the card bills it itself.
 */
function byHandNote(c: Context): string | null {
  const said: string[] = []
  if (c.basis === "fixed" || c.basis === "none") {
    for (const m of c.late.months) {
      const minutes = [...m.offered.values()].reduce((a, b) => a + b, 0)
      if (minutes > 0)
        said.push(
          `${worded(minutes, "hourly", c.hpd)} of ${m.month}, a month of the retainer, were entered after its invoice`,
        )
    }
  }
  const closed = c.late.closedElsewhere
    .map((id) => c.rows.find((r) => r.id === id)?.title)
    .filter((t): t is string => Boolean(t))
  if (closed.length > 0) {
    const names = closed
      .slice(0, 3)
      .map((t) => `"${cutText(t, 40)}"`)
      .join(", ")
    said.push(
      `${closed.length} task${closed.length === 1 ? "" : "s"} (${names}${closed.length > 3 ? ", ..." : ""}) closed, or had time entered, after the invoice of a period billed by its tasks`,
    )
  }
  const outside = [...c.late.outside.values()].reduce((a, b) => a + b, 0)
  if (outside > 0) {
    const names = [...c.late.outside.keys()]
      .map((id) => c.rows.find((r) => r.id === id)?.title)
      .filter((t): t is string => Boolean(t))
    said.push(
      `${worded(outside, "hourly", c.hpd)} were entered on ${names
        .slice(0, 3)
        .map((t) => `"${cutText(t, 40)}"`)
        .join(", ")}${names.length > 3 ? ", ..." : ""} for days outside the retainer's months`,
    )
  }
  if (said.length === 0) return null
  return `Not billed by this card: ${said.join("; ")}. This project is not billed that way any more, so bill it by hand: make an invoice for it in Invoicing.`
}

/** The title invoicing gives the draft a card makes, so the card can name it. */
export function draftTitle(c: { project: { name: string }; period: { from: string; to: string } }) {
  return `Invoice draft for ${c.project.name}, ${c.period.from} to ${c.period.to}`
}

/** What the message says of the card's invoice, by its state. */
const STATE_SAID: Record<"proposed" | "drafted" | "invoiced" | "credited", string> = {
  proposed: "No invoice was created.",
  drafted: "Its invoice draft exists; it has no number until a person issues it.",
  invoiced:
    "It is invoiced: its billed lines are locked, and work of this period done since goes on the next card.",
  credited: "Its invoice was credited in full; that work can be billed again on a new card.",
}

const STATE_NEXT: Record<"drafted" | "invoiced" | "credited", string> = {
  drafted:
    "Show the card. A person issues the draft from its approval; Undo on the card discards the draft and brings the card back.",
  invoiced: "To change a billed line, offer a credit note.",
  credited: "Reconcile the period again to bill that work on a new card.",
}

/**
 * What the model is told to do with a saved card. The card lives in this conversation (reconcile_get
 * reopens it); its Create invoice drafts the invoice, and a person issues it.
 */
export const CARD_NEXT =
  "Show the person the card here: it lives in this conversation, and reconcile_get opens it again. They change a line by telling you or on the card. The card's Create invoice drafts the invoice; a person issues it."

/** A coding agent cannot show the card: it gives the person the card's page link. */
const CODING_AGENT_CARD_NEXT =
  "Give the person the card's link from the text: the card lives on its own page in Liaison, where a person presses Create invoice."

// ── reconcile_line_update and reconcile_get ─────────────────────────────────

interface StoredHead {
  id: string
  project_id: string
  period_start: string | null
  period_end: string | null
  revision: number
  state: "proposed" | "drafted" | "invoiced" | "credited"
  basis: Basis
  created_by: string
  document_id: string | null
  /** The conversation the card lives in, when it was made in one. */
  thread_id?: string | null
}

async function readHead(tx: Tx, orgId: string, id: string): Promise<StoredHead> {
  const uuid = /^[0-9a-f-]{36}$/i.test(id.trim()) ? id.trim() : null
  const head = uuid
    ? extractRows<StoredHead>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, project_id::text AS project_id,
                 period_start::text AS period_start, period_end::text AS period_end,
                 revision, state, basis, created_by::text AS created_by,
                 document_id::text AS document_id, thread_id::text AS thread_id
            FROM ${projectsRel("reconciliations")}
           WHERE id = ${uuid}::uuid AND org_id = ${orgId}::uuid`),
      )[0]
    : undefined
  if (!head) {
    throw new ProjectsServiceError(404, "reconciliation_not_found", `No reconcile card ${id}.`, {
      next: "Use the reconciliationId the card returned, or reconcile the period again.",
    })
  }
  return head
}

/** The period a stored card covers, as its first ask named it. */
function periodInput(head: StoredHead): { month: string } | { from: string; to: string } {
  const from = head.period_start ?? ""
  const to = head.period_end ?? ""
  const [y, m] = from.split("-").map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  if (from.endsWith("-01") && to === `${from.slice(0, 8)}${String(last).padStart(2, "0")}`) {
    return { month: from.slice(0, 7) }
  }
  return { from, to }
}

/** A quantity a person typed or said: a number in the card's unit, or a duration. */
function quantityMinutes(raw: unknown, basis: Basis, hpd: number, field: string): number | null {
  if (raw === null) return null
  const per = basis === "daily" ? hpd : 60
  const unit = basis === "daily" ? "days" : "hours"
  let minutes: number | null = null
  if (typeof raw === "number" && Number.isFinite(raw)) minutes = Math.round(raw * per)
  else if (typeof raw === "string") {
    const text = raw.trim().replace(",", ".")
    minutes = /^\d+(\.\d+)?$/.test(text) ? Math.round(Number(text) * per) : parseDuration(text, hpd)
  }
  if (minutes === null || minutes < 0) {
    throw new ProjectsServiceError(
      400,
      "invalid_quantity",
      `${field} "${String(raw)}" is not a quantity. Give a number of ${unit}, or a duration such as 3.5 days or 4 h. Nothing was saved.`,
      { field },
    )
  }
  return minutes
}

export interface LineUpdateInput {
  reconciliationId: string
  revision: number
  lineId: string
  bill?: unknown
  wording?: unknown
  realNote?: unknown
}

export async function reconcileLineUpdate(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  input: LineUpdateInput
  now?: Date
  origin?: string
}) {
  const { tx, orgId, input } = args
  const head = await readHead(tx, orgId, String(input.reconciliationId ?? ""))
  if (head.state !== "proposed") {
    throw new ProjectsServiceError(
      409,
      "reconcile_locked",
      "Billed lines lock with the invoice; this card is no longer a proposal. Nothing was changed.",
      { state: head.state, next: "To change a billed line, offer a credit note." },
    )
  }
  const c = await loadContext({
    tx,
    orgId,
    scopes: args.scopes,
    project: head.project_id,
    ...periodInput(head),
    ...(args.now ? { now: args.now } : {}),
  })
  const latest = () =>
    readStored(tx, orgId, head.id).then((shape) =>
      cardData({ c, id: head.id, revision: head.revision, outcome: "unchanged", shape }),
    )
  if (Number(input.revision) !== head.revision) {
    throw new ProjectsServiceError(
      409,
      "card_changed",
      `This card moved on to revision ${head.revision} since it was drawn. Nothing was changed.`,
      { latest: await latest(), next: "Show the latest card and apply the change to it." },
    )
  }
  const has = (k: "bill" | "wording" | "realNote") => Object.hasOwn(input, k)
  if (!has("bill") && !has("wording") && !has("realNote")) {
    throw new ProjectsServiceError(
      400,
      "invalid_params",
      "Say what to change on the line: bill, wording or realNote. Nothing was changed.",
    )
  }
  const shape = await readStored(tx, orgId, head.id)
  const ref = String(input.lineId ?? "").trim()
  const line =
    shape.lines.find((l) => l.id === ref) ??
    shape.lines.find((l) => (l.wording ?? l.name).toLowerCase() === ref.toLowerCase())
  if (!line?.id) {
    throw new ProjectsServiceError(404, "line_not_found", `No line ${ref} on this card.`, {
      lines: shape.lines.map((l) => ({ lineId: l.id, name: l.wording ?? l.name })),
      next: "Use a lineId from the card.",
    })
  }
  const changes: string[] = []
  let bill = line.billMinutes
  if (has("bill")) {
    if (c.basis === "fixed") {
      throw new ProjectsServiceError(
        400,
        "fixed_price_no_bill",
        `${c.project.name} has a fixed price, so its card bills nothing. Nothing was changed.`,
        { next: "Milestones bill from the quote." },
      )
    }
    bill = quantityMinutes(input.bill, c.basis, c.hpd, "bill") ?? 0
    changes.push(`bills ${worded(bill, c.basis, c.hpd)}`)
  }
  let wording = line.wording ?? null
  if (has("wording")) {
    const text =
      typeof input.wording === "string" ? cutText(input.wording.trim(), LINE_NAME_MAX) : ""
    const members = extractRows<{ name: string | null; email: string | null }>(
      await tx.execute(drizzleSql`
        SELECT name, email FROM ${kernelRel("users")}
         WHERE org_id = ${orgId}::uuid AND status = 'active'`),
    )
    if (text && namedMember(text, members)) {
      throw new ProjectsServiceError(
        400,
        "names_a_person",
        `"${text}" names someone on the team. A line says what was done, never who did it. Nothing was changed.`,
        { next: "Word the line by the work alone. A client's own contact may be named." },
      )
    }
    wording = text || null
    changes.push(wording ? `reads "${wording}"` : "is back to its first wording")
  }
  let realNote = line.realNoteMinutes ?? null
  if (has("realNote")) {
    realNote = quantityMinutes(input.realNote, c.basis, c.hpd, "realNote")
    changes.push(
      realNote === null
        ? "has no time-spent note"
        : `notes ${worded(realNote, c.basis, c.hpd)} spent, for you only`,
    )
  }
  const moved = extractRows<{ revision: number }>(
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("reconciliations")}
         SET revision = revision + 1, updated_at = now()
       WHERE id = ${head.id}::uuid AND org_id = ${orgId}::uuid AND revision = ${head.revision}
         AND state = 'proposed'
       RETURNING revision`),
  )[0]
  if (!moved) {
    throw new ProjectsServiceError(
      409,
      "card_changed",
      "This card moved on since it was drawn. Nothing was changed.",
      { latest: await latest(), next: "Show the latest card and apply the change to it." },
    )
  }
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("reconciliation_lines")}
       SET bill_minutes = ${bill}, wording = ${wording}, real_note_minutes = ${realNote},
           updated_at = now()
     WHERE id = ${line.id}::uuid AND reconciliation_id = ${head.id}::uuid
       AND org_id = ${orgId}::uuid`)
  return cardData({
    c,
    id: head.id,
    revision: moved.revision,
    outcome: "edited",
    shape: await readStored(tx, orgId, head.id),
    said: `"${wording ?? line.name}" now ${changes.join(" and ")}; the card is at revision ${moved.revision}.`,
    ...(args.origin ? { origin: args.origin } : {}),
  })
}

export async function reconcileGet(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  input: { reconciliationId: string }
  now?: Date
  origin?: string
}) {
  const { tx, orgId } = args
  const head = await readHead(tx, orgId, String(args.input.reconciliationId ?? ""))
  let c: Context
  try {
    c = await loadContext({
      tx,
      orgId,
      scopes: args.scopes,
      project: head.project_id,
      ...periodInput(head),
      ...(args.now ? { now: args.now } : {}),
    })
  } catch (err) {
    // A project that stopped using time and budgets: a proposal is refused like any new
    // planning, and a card already on an invoice reads as what was billed, nothing more.
    if (!(err instanceof ProjectsServiceError) || err.code !== "planning_off") throw err
    if (head.state === "proposed") throw err
    const hpd = await hoursPerDayMinutes(tx, orgId)
    const shape = await readStored(tx, orgId, head.id)
    const billed = shape.lines
      .filter((l) => l.billMinutes > 0)
      .map((l) => ({ name: l.wording ?? l.name, bill: worded(l.billMinutes, head.basis, hpd) }))
    const project = extractRows<{ name: string }>(
      await tx.execute(drizzleSql`
        SELECT name FROM ${projectsRel("projects")}
         WHERE id = ${head.project_id}::uuid AND org_id = ${orgId}::uuid`),
    )[0]
    return {
      reconciliationId: head.id,
      revision: head.revision,
      state: head.state,
      billedOnly: true,
      // The card draws what was billed and nothing else: no planned, no time spent.
      title: `${project?.name ?? "Project"}: billed`,
      end: `${head.period_start} to ${head.period_end}`,
      sub: "This project no longer uses time and budgets, so only what was billed is shown.",
      fit: "billed",
      cover: null,
      notice: null,
      connectGithub: null,
      fixedPrice: null,
      editable: null,
      groups: [
        {
          label: "Billed",
          rows: shape.lines
            .filter((l) => l.billMinutes > 0)
            .map((l) => ({
              id: l.id,
              name: l.wording ?? l.name,
              bill: worded(l.billMinutes, head.basis, hpd),
            })),
        },
      ],
      tot: [],
      cardNotes: [],
      foot: null,
      createInvoice: null,
      waiveOverage: null,
      summary: null,
      undo: null,
      locked: head.state === "invoiced" ? "yes" : null,
      lines: billed,
      message: `${billed.length} billed line${billed.length === 1 ? "" : "s"} of a card that is ${head.state}. The project no longer uses time and budgets, so planned and time spent are not shown.`,
      next: "Answer from the billed lines; a correction goes through a credit note.",
    }
  }
  // A time-spent note is its author's alone: another reader of the card sees the time entered on
  // the tasks.
  const stored = await readStored(tx, orgId, head.id)
  const shape =
    head.created_by === args.userId
      ? stored
      : { ...stored, lines: stored.lines.map(({ realNoteMinutes: _note, ...l }) => l) }
  return cardData({
    c,
    id: head.id,
    revision: head.revision,
    outcome: "unchanged",
    state: head.state,
    shape,
    viewerId: args.userId,
    createdBy: head.created_by,
    said: `The card as stored, revision ${head.revision}.`,
    ...(args.origin ? { origin: args.origin } : {}),
    ...(args.origin === "mcp" ? { link: await cardLink(orgId, head.id) } : {}),
  })
}

/** The card's own page in Liaison, where a person presses Create invoice. */
async function cardLink(orgId: string, reconciliationId: string): Promise<string> {
  return `Open the card in Liaison: ${await orgPublicBaseUrl(orgId)}/projects/reconcile/${reconciliationId}`
}

/**
 * A stored card as its reader may see it, for the create and undo steps: the same card
 * reconcile_get draws, with what the step says.
 */
export async function storedCard(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  reconciliationId: string
  said: string
  now?: Date
}) {
  const head = await readHead(args.tx, args.orgId, args.reconciliationId)
  const c = await loadContext({
    tx: args.tx,
    orgId: args.orgId,
    scopes: args.scopes,
    project: head.project_id,
    ...periodInput(head),
    ...(args.now ? { now: args.now } : {}),
  })
  const stored = await readStored(args.tx, args.orgId, head.id)
  return {
    head,
    card: cardData({
      c,
      id: head.id,
      revision: head.revision,
      outcome: "unchanged",
      state: head.state,
      shape: stored,
      viewerId: args.userId,
      createdBy: head.created_by,
      said: args.said,
    }),
  }
}

/** A stored card's head, for the create and undo steps. */
export async function reconciliationHead(tx: Tx, orgId: string, id: string) {
  return readHead(tx, orgId, id)
}

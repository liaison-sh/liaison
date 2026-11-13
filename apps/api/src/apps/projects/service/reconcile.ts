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
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { hasScope } from "~/modules/permissions/permissions"
import { type BudgetTask, coverageOf, liveTasks, plannedByTask } from "./coverage"
import {
  amountMinor,
  type ComputedLine,
  type ComputedProof,
  computeLines,
  keptProofUrl,
  lateNote,
  NOT_EVERYTHING_SEEN,
  namedMember,
  type Period,
  type ProposedLine,
  proofLabel,
  readProposedLines,
  repoHostsOf,
  resolvePeriod,
  worded,
} from "./reconcile-lines"
import { resolveProjectId } from "./resolve"
import { ProjectsServiceError } from "./statuses"
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
  /** The period's tasks: closed in it, and on a retainer also those with time in it. */
  inPeriod: TaskRow[]
  rateMinor: number | null
  currency: string | null
  sourceRepos: Array<{ provider: string; repo: string }>
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
  for (const t of totals) {
    if (!liveIds.has(t.task_id)) continue
    const m = Number(t.minutes)
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

  return {
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
    inPeriod,
    rateMinor,
    currency,
    sourceRepos: Array.isArray(plan?.source_repos) ? plan.source_repos : [],
  }
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
  }>(
    await tx.execute(drizzleSql`
      SELECT source_kind, source_ref, state, document_number
        FROM ${projectsRel("billing_claims")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${c.project.id}::uuid
         AND state IN ('reserved', 'billed', 'left_off')`),
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
    hasEntries: c.hasEntries.has(r.id),
    claim: taskClaim.get(r.id) ?? null,
  })

  // Earlier work not yet on any document: closed after the last period a document covered and
  // before this one. With no document yet there is no earlier baseline, so nothing is listed.
  const lastBilled = extractRows<{ end: string | null }>(
    await tx.execute(drizzleSql`
      SELECT max(period_end)::text AS "end" FROM ${projectsRel("reconciliations")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${c.project.id}::uuid
         AND state IN ('drafted', 'invoiced')`),
  )[0]?.end
  const unbilledEarlier = lastBilled
    ? c.rows.filter(
        (r) =>
          !r.archived &&
          r.completed_on !== null &&
          r.completed_on > lastBilled &&
          r.completed_on < c.period.from &&
          !taskClaim.has(r.id),
      )
    : []

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
  const late = c.today > c.period.to
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
    timebox: timeboxRow?.minutes ? { minutes: timeboxRow.minutes, source: "plan" } : null,
    tasks,
    unbilledEarlier: unbilledEarlier.map(shape),
    leftOff: claims
      .filter((cl) => cl.source_kind === "task" && cl.state === "left_off")
      .map((cl) => c.rows.find((r) => r.id === cl.source_ref))
      .filter((r): r is TaskRow => Boolean(r))
      .map((r) => ({ key: r.key, title: r.title })),
    coverage,
    sourceRepos: c.sourceRepos,
    clientMarkers: {
      domains: [...new Set(markers.map((m) => m.domain).filter((d): d is string => !!d))],
      contactEmails: [...new Set(markers.map((m) => m.email).filter((e): e is string => !!e))],
    },
    billedRefs: claims
      .filter((cl) => cl.source_kind !== "task" && cl.state === "billed")
      .map((cl) => ({
        kind: cl.source_kind,
        ref: cl.source_ref,
        documentNumber: cl.document_number,
      })),
    latestProposal: latest ? { id: latest.id, revision: latest.revision } : null,
    late,
    message: `${tasks.length} task${tasks.length === 1 ? "" : "s"} of ${c.project.name} closed in ${c.period.label}; real time is entered on ${coverage.withEntries} of ${coverage.total}. Nothing was saved.`,
    next: "Read this period's traces with your own tools (commits, meetings, notes, mail), then call reconcile_propose with the lines. Every figure is worked out by the server.",
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
  lines: Array<Omit<ComputedLine, "proofs"> & { proofs: ComputedProof[] }>
  notSeen: Array<{ source: string; why: string }>
  excludedCount: number
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
      ...s,
      lines: s.lines.map(({ tag: _tag, ...l }) => ({
        ...l,
        proofs: [...l.proofs].sort((x, y) =>
          `${x.kind}|${x.ref}|${x.label}`.localeCompare(`${y.kind}|${y.ref}|${y.label}`),
        ),
      })),
    })
  return canon(a) === canon(b)
}

async function readStored(tx: Tx, orgId: string, id: string): Promise<StoredShape> {
  const head = extractRows<{ not_seen: StoredShape["notSeen"]; excluded_count: number }>(
    await tx.execute(drizzleSql`
      SELECT not_seen, excluded_count FROM ${projectsRel("reconciliations")}
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
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, position, name, why, kind, reason, task_ids::text[] AS task_ids,
             planned_minutes, real_minutes, trace_estimate_minutes, bill_minutes
        FROM ${projectsRel("reconciliation_lines")}
       WHERE reconciliation_id = ${id}::uuid AND org_id = ${orgId}::uuid
       ORDER BY position`),
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
  return {
    lines: lines.map((l) => ({
      position: l.position,
      name: l.name,
      ...(l.why ? { why: l.why } : {}),
      kind: l.kind,
      ...(l.reason ? { reason: l.reason } : {}),
      taskIds: l.task_ids,
      plannedMinutes: l.planned_minutes,
      realMinutes: l.real_minutes ?? 0,
      traceEstimateMinutes: l.trace_estimate_minutes,
      billMinutes: l.bill_minutes,
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

async function writeLines(tx: Tx, orgId: string, id: string, lines: StoredShape["lines"]) {
  for (const l of lines) {
    const inserted = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("reconciliation_lines")}
          (org_id, reconciliation_id, position, name, why, kind, reason, task_ids,
           planned_minutes, real_minutes, trace_estimate_minutes, bill_minutes)
        VALUES (${orgId}::uuid, ${id}::uuid, ${l.position}, ${l.name}, ${l.why ?? null},
          ${l.kind}, ${l.reason ?? null},
          ${`{${l.taskIds.join(",")}}`}::uuid[], ${l.plannedMinutes}, ${l.realMinutes},
          ${l.traceEstimateMinutes}, ${l.billMinutes})
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

export async function reconcilePropose(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  threadId?: string
  input: ProposeInput
  now?: Date
}) {
  const { tx, orgId, userId, input } = args
  // The shape first: a line carrying a figure is refused before anything is read.
  const proposed = readProposedLines(input.lines)
  const excluded = readExcluded(input.excluded)
  const notSeen = readNotSeen(input.notSeen)
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
          label: proofLabel({ ...p, label: t.key ?? t.title }),
        })
        continue
      }
      const url = keptProofUrl(p, repoHosts)
      proofsOut.push({
        kind: p.kind,
        ref: p.ref,
        label: proofLabel(p),
        ...(url ? { url } : {}),
        ...(p.occurredOn ? { occurredOn: p.occurredOn } : {}),
      })
    }
    return { ...line, resolvedTaskIds, proofsOut }
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
  const unlisted = c.inPeriod
    .map((r) => r.id)
    .filter((id) => !listed.has(id) && !excludedIds.has(id))

  const computed = computeLines({
    basis: c.basis,
    hoursPerDayMinutes: c.hpd,
    projectTasks: c.live,
    ownReal: c.ownReal,
    lines: linesIn,
    unlisted,
  })
  const shape: StoredShape = {
    lines: computed,
    notSeen,
    excludedCount: [...excludedIds].filter((id) => c.inPeriod.some((r) => r.id === id)).length,
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
         SET revision = ${revision}, not_seen = ${JSON.stringify(notSeen)}::jsonb,
             excluded_count = ${shape.excludedCount}, basis = ${c.basis},
             period_end = ${c.period.to}::date,
             thread_id = coalesce(${args.threadId ?? null}::uuid, thread_id), updated_at = now()
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`)
    await writeLines(tx, orgId, id, computed)
  } else {
    id = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("reconciliations")}
          (org_id, project_id, period_start, period_end, basis, state, created_by, thread_id,
           not_seen, excluded_count)
        VALUES (${orgId}::uuid, ${c.project.id}::uuid, ${c.period.from}::date,
          ${c.period.to}::date, ${c.basis}, 'proposed', ${userId}::uuid,
          ${args.threadId ?? null}::uuid, ${JSON.stringify(notSeen)}::jsonb,
          ${shape.excludedCount})
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

  return cardData({ c, id, revision, outcome, shape })
}

/** The card's data: what the `reconcile` card draws, worded in the project's unit. */
function cardData(args: {
  c: Context
  id: string
  revision: number
  outcome: "created" | "unchanged" | "revised"
  shape: StoredShape
}) {
  const { c, id, revision, outcome, shape } = args
  const q = (m: number) => worded(m, c.basis, c.hpd)
  const money =
    c.rateMinor !== null && (c.basis === "daily" || c.basis === "hourly" || c.basis === "retainer")
  const amount = (m: number) => {
    const a = amountMinor(m, c.basis, c.rateMinor, c.hpd)
    return a === null ? null : a / 100
  }
  const lines = shape.lines.map((l) => ({
    position: l.position,
    name: l.name,
    ...(l.why ? { why: l.why } : {}),
    kind: l.kind,
    ...(l.reason ? { reason: l.reason } : {}),
    ...(l.tag ? { tag: l.tag } : {}),
    taskIds: l.taskIds,
    plannedMinutes: l.plannedMinutes,
    realMinutes: l.realMinutes,
    traceEstimateMinutes: l.traceEstimateMinutes,
    billMinutes: l.billMinutes,
    planned: l.plannedMinutes !== null ? q(l.plannedMinutes) : null,
    real:
      l.realMinutes > 0
        ? q(l.realMinutes)
        : l.traceEstimateMinutes !== null
          ? `~${q(l.traceEstimateMinutes)}`
          : null,
    bill: q(l.billMinutes),
    ...(money ? { amount: amount(l.billMinutes) } : {}),
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
  const notes: string[] = []
  if (c.today > c.period.to) notes.push(lateNote(c.period))
  if (shape.notSeen.length > 0 || coverage.total === 0) notes.push(NOT_EVERYTHING_SEEN)
  const totalAmount = money ? amount(billMinutes) : null
  const said =
    outcome === "unchanged"
      ? `Nothing changed since revision ${revision}; the same card is returned.`
      : outcome === "revised"
        ? `The card was updated to revision ${revision}.`
        : "The card was saved; only you can see it."
  return {
    reconciliationId: id,
    revision,
    state: "proposed" as const,
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
    coverageText: `Real time entered on ${coverage.withEntries} of ${coverage.total} tasks`,
    notSeen: shape.notSeen,
    excludedCount: shape.excludedCount,
    notes,
    message: `${c.project.name}, ${c.period.label}: ${lines.length} line${lines.length === 1 ? "" : "s"}, ${q(billMinutes)} to bill${totalAmount !== null ? ` (${totalAmount.toFixed(2)} ${c.currency ?? ""} excluding VAT)`.replace(" )", ")") : ""}${unplannedAtZero.length > 0 ? `, ${unplannedAtZero.length} not in the plan left off the bill` : ""}. ${said} No invoice was created.`,
    next: "Show the person the card. They change a line by telling you or on the card; nothing is billed until they act.",
  }
}

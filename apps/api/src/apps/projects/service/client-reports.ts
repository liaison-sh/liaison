// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Friday client report: a status report on one project that a person approves
// before it goes to the client. A routine or a person saves a draft; only a
// person's approved send writes what went out (`sections_sent`, written once),
// then mails it, then marks it sent. Nothing here counts, ranks or compares
// people, and a quiet week is no draft rather than a finding.
//
// What a report may say follows the portal shares a person opened for the
// project: each section names the share kind it belongs to, and a section whose
// kind is not open is refused when saved and again when sent. Hours are only the
// totals the client's portal shows (billed, or the retainer's "so far").

import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { UUID_RE } from "~/lib/uuid"
import { ProjectsServiceError } from "./statuses"

/** The share kinds a section may belong to: the per-project kinds of the portal. */
export const REPORT_SECTION_KINDS = [
  "project_reports",
  "project_progress",
  "project_hours",
] as const
export type ReportSectionKind = (typeof REPORT_SECTION_KINDS)[number]

export interface ReportSection {
  kind: ReportSectionKind
  heading: string
  text: string
}

export interface LeftOutItem {
  what: string
  why: string
}

const MAX_SECTIONS = 12
const MAX_TEXT = 6000
const MAX_HEADING = 120
const MAX_LEFT_OUT = 40

interface Base {
  tx: RlsClient
  orgId: string
}

function refuse(status: number, code: string, message: string, details?: unknown): never {
  throw new ProjectsServiceError(status, code, message, details)
}

function isDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

interface ProjectRow {
  id: string
  name: string
  company_id: string | null
  company_name: string | null
  time_budgets_on: boolean
}

async function readProject(b: Base, projectId: string): Promise<ProjectRow> {
  if (!UUID_RE.test(projectId)) refuse(404, "not_found", `No project ${projectId}.`)
  const [row] = extractRows<ProjectRow>(
    await b.tx.execute(drizzleSql`
      SELECT p.id::text AS id, p.name, p.company_id::text AS company_id,
             c.name AS company_name, COALESCE(p.time_budgets_on, false) AS time_budgets_on
        FROM ${projectsRel("projects")} p
        LEFT JOIN ${kernelRel("companies")} c ON c.id = p.company_id AND c.org_id = p.org_id
       WHERE p.id = ${projectId}::uuid AND p.org_id = ${b.orgId}::uuid
       LIMIT 1`),
  )
  if (!row) refuse(404, "not_found", `No project ${projectId} you can read.`)
  return row
}

/** The per-project share kinds open on the portal for this project's client. */
export async function openKinds(b: Base, projectId: string): Promise<Set<string>> {
  const rows = extractRows<{ k: string }>(
    await b.tx.execute(
      drizzleSql`SELECT k FROM ${projectsRel("client_report_open_kinds")}(${projectId}::uuid) AS k`,
    ),
  )
  return new Set(rows.map((r) => r.k))
}

export interface ReportHours {
  kind: "billed" | "so_far"
  usedMinutes: number
  ofMinutes: number | null
  period: string | null
}

/** Totals only, exactly what the portal shows; null when the hours share is closed or time is off. */
export async function reportHours(b: Base, projectId: string): Promise<ReportHours | null> {
  const [row] = extractRows<{
    kind: "billed" | "so_far"
    used_minutes: string | number
    of_minutes: string | number | null
    period: string | null
  }>(
    await b.tx.execute(
      drizzleSql`SELECT * FROM ${projectsRel("client_report_hours")}(${projectId}::uuid)`,
    ),
  )
  if (!row) return null
  return {
    kind: row.kind,
    usedMinutes: Number(row.used_minutes),
    ofMinutes: row.of_minutes === null ? null : Number(row.of_minutes),
    period: row.period,
  }
}

// ── Sources: the one project read a report is written from ───────────────────

export interface ReportSources {
  projectId: string
  projectName: string
  companyName: string | null
  since: string
  until: string
  openKinds: string[]
  tasks: Array<{ key: string | null; title: string; status: string; done: boolean }>
  pullRequests: Array<{ title: string; on: string | null }>
  threadMessages: Array<{ threadTitle: string | null; text: string; at: string }>
  hours: ReportHours | null
  quiet: boolean
  message: string
}

export interface ReportProjects {
  projects: Array<{ projectId: string; name: string }>
  message: string
}

/** The projects whose reports a person shared with their client: the ones a report is drafted for. */
async function reportProjects(b: Base): Promise<ReportProjects> {
  const projects = extractRows<{ projectId: string; name: string }>(
    await b.tx.execute(drizzleSql`
      SELECT p.id::text AS "projectId", p.name
        FROM ${projectsRel("projects")} p
       WHERE p.org_id = ${b.orgId}::uuid AND p.kind = 'work' AND p.archived_at IS NULL
         AND p.company_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM ${projectsRel("client_report_open_kinds")}(p.id) k
                      WHERE k = 'project_reports')
       ORDER BY p.name
       LIMIT 200`),
  )
  return {
    projects,
    message:
      projects.length === 0
        ? "No project has its reports shared with a client, so no report is drafted."
        : `${projects.length} project(s) have their reports shared with their client. Next: read each one's sources with its projectId.`,
  }
}

/**
 * Task titles and statuses, pull request titles and the messages of threads linked to
 * the project, over the week that ends on `until`. Never a task's comments, an internal
 * note, an assignee, real time or who did what. Hours only as the portal's totals.
 */
export async function clientReportSources(
  b: Base & { input: { projectId?: unknown; until?: unknown; since?: unknown } },
): Promise<ReportSources | ReportProjects> {
  if (b.input.projectId === undefined || b.input.projectId === null || b.input.projectId === "")
    return reportProjects(b)
  const projectId = String(b.input.projectId)
  const project = await readProject(b, projectId)
  const until = isDate(b.input.until) ? b.input.until : new Date().toISOString().slice(0, 10)
  const since = isDate(b.input.since)
    ? b.input.since
    : new Date(Date.parse(until) - 6 * 86_400_000).toISOString().slice(0, 10)
  const kinds = await openKinds(b, project.id)
  const tasks = extractRows<{ key: string | null; title: string; status: string; done: boolean }>(
    await b.tx.execute(drizzleSql`
      SELECT CASE WHEN p.key IS NULL THEN NULL ELSE p.key || '-' || t.number::text END AS key,
             t.title, s.label AS status, COALESCE(s.terminal, false) AS done
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
        LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
       WHERE t.project_id = ${project.id}::uuid AND t.org_id = ${b.orgId}::uuid
         AND t.archived_at IS NULL
         AND t.updated_at >= ${since}::date AND t.updated_at < (${until}::date + 1)
       ORDER BY t.updated_at DESC
       LIMIT 100`),
  )
  const pullRequests = extractRows<{ title: string; on: string | null }>(
    await b.tx.execute(drizzleSql`
      SELECT DISTINCT pr.label AS title, pr.occurred_on::text AS on
        FROM ${projectsRel("reconciliation_proofs")} pr
        JOIN ${projectsRel("reconciliation_lines")} l ON l.id = pr.line_id AND l.org_id = pr.org_id
        JOIN ${projectsRel("reconciliations")} r ON r.id = l.reconciliation_id AND r.org_id = l.org_id
       WHERE r.project_id = ${project.id}::uuid AND r.org_id = ${b.orgId}::uuid
         AND pr.kind IN ('pull_request', 'merge_request')
         AND (pr.occurred_on IS NULL OR (pr.occurred_on >= ${since}::date AND pr.occurred_on <= ${until}::date))
       LIMIT 50`),
  )
  // Threads a person linked to the project, never a task's own discussion thread. A message
  // stamped with a restricted record's scope (a turn that read a restricted agreement) is never a
  // source: the report is read by every reports reader and, once approved, by the client, who
  // are not that record's list. The stamp decides, whoever runs this read.
  const threadMessages = extractRows<{ threadTitle: string | null; text: string; at: string }>(
    await b.tx.execute(drizzleSql`
      SELECT th.title AS "threadTitle", m.content AS text, m.created_at::text AS at
        FROM ${kernelRel("thread_references")} ref
        JOIN ${kernelRel("threads")} th ON th.id = ref.thread_id AND th.org_id = ref.org_id
        JOIN ${kernelRel("messages")} m ON m.thread_id = th.id AND m.org_id = th.org_id
       WHERE ref.org_id = ${b.orgId}::uuid AND ref.app = 'projects'
         AND ref.entity_type = 'project' AND ref.entity_id = ${project.id}
         AND NOT EXISTS (SELECT 1 FROM ${projectsRel("tasks")} t
                          WHERE t.thread_id = th.id AND t.org_id = th.org_id)
         AND m.created_at >= ${since}::date AND m.created_at < (${until}::date + 1)
         AND NOT EXISTS (SELECT 1 FROM unnest(m.required_scopes) AS rq(s)
                          WHERE left(rq.s, 11) = 'restricted:')
       ORDER BY m.created_at
       LIMIT 100`),
  )
  const hours = project.time_budgets_on ? await reportHours(b, project.id) : null
  const quiet = tasks.length === 0 && pullRequests.length === 0 && threadMessages.length === 0
  return {
    projectId: project.id,
    projectName: project.name,
    companyName: project.company_name,
    since,
    until,
    openKinds: [...kinds].sort(),
    tasks,
    pullRequests,
    threadMessages,
    hours,
    quiet,
    message: quiet
      ? `Nothing moved on ${project.name} from ${since} to ${until}: no draft is needed this week.`
      : `Sources for ${project.name} from ${since} to ${until}: ${tasks.length} task(s), ${pullRequests.length} pull request(s), ${threadMessages.length} message(s)${hours ? ", hours as totals" : ", no hours"}. Task comments and internal notes are not part of them. Next: save a draft for a person to approve.`,
  }
}

// ── Drafts ───────────────────────────────────────────────────────────────────

function parseSections(raw: unknown): ReportSection[] {
  if (!Array.isArray(raw) || raw.length === 0)
    refuse(422, "invalid_params", "A report needs at least one section.")
  if (raw.length > MAX_SECTIONS)
    refuse(422, "invalid_params", `A report has at most ${MAX_SECTIONS} sections.`)
  return raw.map((s, i) => {
    const r = (s ?? {}) as Record<string, unknown>
    const kind = String(r.kind ?? "")
    if (!(REPORT_SECTION_KINDS as readonly string[]).includes(kind))
      refuse(
        422,
        "invalid_params",
        `Section ${i + 1} has kind "${kind}": a section is one of ${REPORT_SECTION_KINDS.join(", ")}.`,
      )
    const heading = String(r.heading ?? "").trim()
    const text = String(r.text ?? "").trim()
    if (!heading || heading.length > MAX_HEADING)
      refuse(
        422,
        "invalid_params",
        `Section ${i + 1} needs a heading of 1 to ${MAX_HEADING} characters.`,
      )
    if (!text || text.length > MAX_TEXT)
      refuse(422, "invalid_params", `Section ${i + 1} needs a text of 1 to ${MAX_TEXT} characters.`)
    return { kind: kind as ReportSectionKind, heading, text }
  })
}

function parseLeftOut(raw: unknown): LeftOutItem[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > MAX_LEFT_OUT)
    refuse(422, "invalid_params", `What was left out is a list of at most ${MAX_LEFT_OUT} items.`)
  return raw.map((x) => {
    const r = (x ?? {}) as Record<string, unknown>
    return { what: String(r.what ?? "").slice(0, 300), why: String(r.why ?? "").slice(0, 300) }
  })
}

/** Sections whose share kind is closed: what the client may not be told. */
function closedSections(sections: ReportSection[], open: Set<string>): ReportSection[] {
  return sections.filter((s) => !open.has(s.kind))
}

export interface ReportRow {
  id: string
  project_id: string
  project_name: string
  company_id: string
  period_end: string
  status: string
  sections: ReportSection[]
  sections_sent: ReportSection[] | null
  left_out: LeftOutItem[]
  sources: Record<string, unknown>
  recipient_contact_id: string | null
  approved_by_user_id: string | null
  approved_at: string | null
  sent_at: string | null
  edited: boolean
}

async function readReport(b: Base, reportId: string): Promise<ReportRow> {
  if (!UUID_RE.test(reportId)) refuse(404, "not_found", `No client report ${reportId}.`)
  const [row] = extractRows<ReportRow>(
    await b.tx.execute(drizzleSql`
      SELECT r.id::text AS id, r.project_id::text AS project_id, p.name AS project_name,
             r.company_id::text AS company_id, r.period_end::text AS period_end, r.status,
             r.sections, r.sections_sent, r.left_out, r.sources,
             r.recipient_contact_id::text AS recipient_contact_id,
             r.approved_by_user_id::text AS approved_by_user_id,
             r.approved_at::text AS approved_at, r.sent_at::text AS sent_at, r.edited
        FROM ${projectsRel("client_reports")} r
        JOIN ${projectsRel("projects")} p ON p.id = r.project_id AND p.org_id = r.org_id
       WHERE r.id = ${reportId}::uuid AND r.org_id = ${b.orgId}::uuid
       LIMIT 1`),
  )
  if (!row) refuse(404, "not_found", `No client report ${reportId} you can read.`)
  return row
}

/** A report as staff read it: the body, what was left out and why, its sources. */
export async function clientReportGet(b: Base & { input: { reportId?: unknown } }) {
  const r = await readReport(b, String(b.input.reportId ?? ""))
  return {
    reportId: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    periodEnd: r.period_end,
    status: r.status,
    sections: r.sections_sent ?? r.sections,
    leftOut: r.left_out,
    sources: r.sources,
    recipientContactId: r.recipient_contact_id,
    approvedAt: r.approved_at,
    sentAt: r.sent_at,
    edited: r.edited,
    message:
      r.status === "sent"
        ? `The report on ${r.project_name} for the week ending ${r.period_end} was sent on ${String(r.sent_at).slice(0, 10)}; it does not change. Next: a correction goes in next week's report.`
        : `The report on ${r.project_name} for the week ending ${r.period_end} is ${r.status}. Nothing goes to the client until a person approves its send.`,
  }
}

/** Every report the caller can read, newest period first, optionally for one project. */
export async function clientReportsList(
  b: Base & { input: { projectId?: unknown; status?: unknown; limit?: unknown } },
) {
  const projectId = typeof b.input.projectId === "string" ? b.input.projectId : null
  if (projectId && !UUID_RE.test(projectId)) refuse(404, "not_found", `No project ${projectId}.`)
  const status = typeof b.input.status === "string" ? b.input.status : null
  const limit = Math.min(Math.max(Number(b.input.limit) || 50, 1), 200)
  const rows = extractRows<{
    id: string
    project_id: string
    project_name: string
    period_end: string
    status: string
    sent_at: string | null
  }>(
    await b.tx.execute(drizzleSql`
      SELECT r.id::text AS id, r.project_id::text AS project_id, p.name AS project_name,
             r.period_end::text AS period_end, r.status, r.sent_at::text AS sent_at
        FROM ${projectsRel("client_reports")} r
        JOIN ${projectsRel("projects")} p ON p.id = r.project_id AND p.org_id = r.org_id
       WHERE r.org_id = ${b.orgId}::uuid
         AND (${projectId}::uuid IS NULL OR r.project_id = ${projectId}::uuid)
         AND (${status}::text IS NULL OR r.status = ${status}::text)
       ORDER BY r.period_end DESC, p.name
       LIMIT ${limit}`),
  )
  return {
    reports: rows.map((r) => ({
      reportId: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      periodEnd: r.period_end,
      status: r.status,
      sentAt: r.sent_at,
    })),
    total: rows.length,
    message:
      rows.length === 0
        ? "No client report matches. A report is drafted only for a project whose reports a person shared with its client."
        : `${rows.length} client report(s). Next: open one to read it, or approve a draft's send.`,
  }
}

/** Saves the draft for a project and week; a sent report is never rewritten. */
export async function clientReportSaveDraft(
  b: Base & {
    userId: string
    human: boolean
    routineId?: string | null
    input: {
      projectId?: unknown
      periodEnd?: unknown
      sections?: unknown
      leftOut?: unknown
      sources?: unknown
      recipientContactId?: unknown
      threadId?: unknown
    }
  },
) {
  const project = await readProject(b, String(b.input.projectId ?? ""))
  if (!project.company_id)
    refuse(
      422,
      "no_client_company",
      `${project.name} has no client company, so it has no client report. Nothing was saved.`,
    )
  if (!isDate(b.input.periodEnd))
    refuse(422, "invalid_params", "periodEnd is the last day of the week reported, as YYYY-MM-DD.")
  const periodEnd = b.input.periodEnd
  const sections = parseSections(b.input.sections)
  const leftOut = parseLeftOut(b.input.leftOut)
  const open = await openKinds(b, project.id)
  if (!open.has("project_reports"))
    refuse(
      409,
      "SHARE_CLOSED",
      `Reports of ${project.name} are not shared with ${project.company_name ?? "its client"}, so no report is drafted. Nothing was saved. Next: a person shares the project's reports on the company's client access panel.`,
    )
  const closed = closedSections(sections, open)
  if (closed.length > 0)
    refuse(
      409,
      "SHARE_CLOSED",
      `Section "${closed[0]!.heading}" belongs to ${closed[0]!.kind}, which is not shared with ${project.company_name ?? "the client"}. Nothing was saved. Next: leave that section out, or a person shares it first.`,
      { closedKinds: [...new Set(closed.map((s) => s.kind))] },
    )
  const recipient =
    typeof b.input.recipientContactId === "string" && UUID_RE.test(b.input.recipientContactId)
      ? b.input.recipientContactId
      : null
  const threadId =
    typeof b.input.threadId === "string" && UUID_RE.test(b.input.threadId) ? b.input.threadId : null
  const sources =
    b.input.sources && typeof b.input.sources === "object" && !Array.isArray(b.input.sources)
      ? b.input.sources
      : {}
  const [existing] = extractRows<{ id: string; status: string }>(
    await b.tx.execute(drizzleSql`
      SELECT id::text AS id, status FROM ${projectsRel("client_reports")}
       WHERE project_id = ${project.id}::uuid AND period_end = ${periodEnd}::date
         AND org_id = ${b.orgId}::uuid
       LIMIT 1`),
  )
  if (existing && existing.status === "sent")
    refuse(
      409,
      "REPORT_SENT",
      `The report on ${project.name} for the week ending ${periodEnd} was already sent and does not change. Nothing was saved.`,
    )
  let id: string
  let outcome: "created" | "updated"
  if (existing) {
    await b.tx.execute(drizzleSql`
      UPDATE ${projectsRel("client_reports")}
         SET sections = ${JSON.stringify(sections)}::jsonb,
             left_out = ${JSON.stringify(leftOut)}::jsonb,
             sources = ${JSON.stringify(sources)}::jsonb,
             recipient_contact_id = COALESCE(${recipient}::uuid, recipient_contact_id),
             thread_id = COALESCE(${threadId}::uuid, thread_id),
             status = 'draft', approved_by_user_id = NULL, approved_at = NULL,
             edited = edited OR ${b.human},
             updated_at = now()
       WHERE id = ${existing.id}::uuid AND org_id = ${b.orgId}::uuid`)
    id = existing.id
    outcome = "updated"
  } else {
    id = extractRows<{ id: string }>(
      await b.tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("client_reports")}
          (org_id, project_id, company_id, period_end, status, sections, left_out, sources,
           recipient_contact_id, routine_id, thread_id, edited)
        VALUES (${b.orgId}::uuid, ${project.id}::uuid, ${project.company_id}::uuid, ${periodEnd}::date,
                'draft', ${JSON.stringify(sections)}::jsonb, ${JSON.stringify(leftOut)}::jsonb,
                ${JSON.stringify(sources)}::jsonb, ${recipient}::uuid, ${b.routineId ?? null}::uuid,
                ${threadId}::uuid, false)
        RETURNING id::text AS id`),
    )[0]!.id
    outcome = "created"
  }
  await b.tx.queueEvent({
    app: "projects",
    entity: "client_report",
    action: "drafted",
    entityId: id,
    data: { reportId: id, projectId: project.id, periodEnd },
    actorId: b.userId,
    actorType: "user",
    orgId: b.orgId,
  })
  return {
    reportId: id,
    projectId: project.id,
    projectName: project.name,
    periodEnd,
    status: "draft",
    outcome,
    message: `Draft ${outcome === "created" ? "saved" : "updated"}: the report on ${project.name} for the week ending ${periodEnd}. Nothing was sent to the client. Next: a person approves its send with client_report_send.`,
  }
}

// ── The card's warning (deterministic, no model) ─────────────────────────────

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

function words(text: string): string[] {
  return (text.toLocaleLowerCase().match(WORD) ?? []).map((w) => w.replace(/[’]/g, "'"))
}

/** Runs of `n` consecutive words of `note` that also appear in `report`. */
function sharedRuns(report: string, note: string, n = 4): string[] {
  const r = words(report)
  const grams = new Set<string>()
  for (let i = 0; i + n <= r.length; i++) grams.add(r.slice(i, i + n).join(" "))
  const nw = words(note)
  const hits: string[] = []
  for (let i = 0; i + n <= nw.length; i++) {
    const g = nw.slice(i, i + n).join(" ")
    if (grams.has(g) && !hits.includes(g)) hits.push(g)
  }
  return hits
}

function containsName(text: string, name: string): boolean {
  const w = ` ${words(text).join(" ")} `
  const n = words(name).join(" ")
  return n.length > 0 && w.includes(` ${n} `)
}

export interface ReportWarning {
  kind: "internal_note" | "member_name"
  words: string
}

/**
 * What the approving person is warned about: report text matching an internal note of
 * the project (a comment on one of its tasks, or its description), or the name of an
 * active member of the org. A contact of the client company is never matched. Each match
 * is named once. It never blocks: the person approves or edits.
 */
export async function clientReportWarnings(
  b: Base,
  report: { project_id: string; company_id: string; sections: ReportSection[] },
): Promise<ReportWarning[]> {
  const text = report.sections.map((s) => `${s.heading}\n${s.text}`).join("\n")
  const notes = extractRows<{ body: string }>(
    await b.tx.execute(drizzleSql`
      SELECT m.content AS body
        FROM ${projectsRel("tasks")} t
        JOIN ${kernelRel("messages")} m ON m.thread_id = t.thread_id AND m.org_id = t.org_id
       WHERE t.project_id = ${report.project_id}::uuid AND t.org_id = ${b.orgId}::uuid
      UNION ALL
      SELECT p.description AS body FROM ${projectsRel("projects")} p
       WHERE p.id = ${report.project_id}::uuid AND p.org_id = ${b.orgId}::uuid
         AND p.description IS NOT NULL`),
  )
  const out: ReportWarning[] = []
  const seen = new Set<string>()
  for (const n of notes) {
    for (const run of sharedRuns(text, n.body)) {
      if (seen.has(`n:${run}`)) continue
      seen.add(`n:${run}`)
      out.push({ kind: "internal_note", words: run })
    }
  }
  const members = extractRows<{ name: string }>(
    await b.tx.execute(drizzleSql`
      SELECT DISTINCT u.name FROM ${kernelRel("users")} u
       WHERE u.org_id = ${b.orgId}::uuid AND u.user_type = 'member' AND u.status = 'active'
         AND u.name IS NOT NULL AND length(u.name) > 2
         AND NOT EXISTS (
           SELECT 1 FROM ${kernelRel("contacts")} c
            WHERE c.org_id = u.org_id AND c.company_id = ${report.company_id}::uuid
              AND lower(c.name) = lower(u.name))`),
  )
  for (const m of members) {
    if (seen.has(`m:${m.name}`) || !containsName(text, m.name)) continue
    seen.add(`m:${m.name}`)
    out.push({ kind: "member_name", words: m.name })
  }
  return out
}

// ── Send: a person's approved act only ───────────────────────────────────────

interface Recipient {
  email: string
  name: string | null
}

async function recipientOf(b: Base, r: ReportRow): Promise<Recipient | null> {
  const [c] = extractRows<{ email: string | null; name: string | null }>(
    await b.tx.execute(drizzleSql`
      SELECT c.email, c.name FROM ${kernelRel("contacts")} c
       WHERE c.org_id = ${b.orgId}::uuid AND c.company_id = ${r.company_id}::uuid
         AND (${r.recipient_contact_id}::uuid IS NULL OR c.id = ${r.recipient_contact_id}::uuid)
         AND c.email IS NOT NULL
       ORDER BY (c.id = ${r.recipient_contact_id}::uuid) DESC NULLS LAST, c.created_at
       LIMIT 1`),
  )
  return c?.email ? { email: c.email, name: c.name } : null
}

/** The send's key: the report, its body and its recipient, held to the approved card. */
export function clientReportGuardKey(r: Pick<ReportRow, "id" | "sections">, to: string): string {
  return `${r.id}:${Bun.hash(JSON.stringify(r.sections)).toString(16)}:${to.toLowerCase()}`
}

export interface SendPreflight {
  report: ReportRow
  recipient: Recipient
  warnings: ReportWarning[]
  guardKey: string
  sendGuard: Record<string, unknown>
}

/** The refusals a send has, checked before the card is staged and again when it goes. */
export async function clientReportReadyToSend(
  b: Base & { input: { reportId?: unknown } },
): Promise<SendPreflight> {
  const r = await readReport(b, String(b.input.reportId ?? ""))
  if (r.status === "sent")
    refuse(
      409,
      "REPORT_SENT",
      `The report on ${r.project_name} for ${r.period_end} was already sent. Nothing was sent again.`,
    )
  if (r.status !== "draft" && r.status !== "approved")
    refuse(
      409,
      "REPORT_NOT_DRAFT",
      `The report on ${r.project_name} for ${r.period_end} is ${r.status}. Nothing was sent. Next: save a new draft.`,
    )
  const open = await openKinds(b, r.project_id)
  const closed = open.has("project_reports") ? closedSections(r.sections, open) : r.sections
  if (closed.length > 0)
    refuse(
      409,
      "SHARE_CLOSED",
      `"${closed[0]!.heading}" belongs to a share that was closed since the draft (${closed[0]!.kind}). Nothing was sent. Next: remove that section from the draft, or a person shares it again.`,
      { closedKinds: [...new Set(closed.map((s) => s.kind))] },
    )
  const recipient = await recipientOf(b, r)
  if (!recipient)
    refuse(
      422,
      "NO_RECIPIENT",
      `The report on ${r.project_name} has no client contact with an address to send to. Nothing was sent. Next: name the recipient on the draft.`,
    )
  const at = new Date().toISOString()
  return {
    report: r,
    recipient,
    warnings: await clientReportWarnings(b, r),
    guardKey: clientReportGuardKey(r, recipient.email),
    sendGuard: {
      v: 1,
      applies: true,
      mode: "plain",
      since: at,
      stagedAt: at,
      addresses: [recipient.email],
      contactIds: r.recipient_contact_id ? [r.recipient_contact_id] : [],
      refs: [],
      classification: "service",
    },
  }
}

/** Plain text of exactly what went out: the same words on the portal and in the mail. */
export function reportText(sections: ReportSection[]): string {
  return sections.map((s) => `${s.heading}\n\n${s.text}`).join("\n\n")
}

/**
 * Writes what goes out (once), mails it, then marks it sent. Runs only as a person's act:
 * the approved re-entry of an agent's card (`approverId`), or a person's own click.
 */
export async function clientReportSend(
  b: Base & {
    approverId: string
    input: { reportId?: unknown; sendGuard?: unknown; guardKey?: unknown }
    mail: (m: {
      to: string
      subject: string
      text: string
      reportId: string
    }) => Promise<string | null>
  },
) {
  const ready = await clientReportReadyToSend(b)
  const r = ready.report
  const guard = b.input.sendGuard as { addresses?: unknown } | undefined
  if (b.input.guardKey !== undefined || guard !== undefined) {
    const addresses = Array.isArray(guard?.addresses) ? guard.addresses : []
    if (b.input.guardKey !== ready.guardKey || !addresses.includes(ready.recipient.email))
      refuse(
        409,
        "SEND_GUARD_MISMATCH",
        `The report on ${r.project_name} no longer matches the card that was approved (its text or its recipient changed). Nothing was sent. Next: send it again for a new decision.`,
      )
  }
  await b.tx.execute(drizzleSql`
    UPDATE ${projectsRel("client_reports")}
       SET sections_sent = sections, status = 'approved',
           approved_by_user_id = ${b.approverId}::uuid, approved_at = now(), updated_at = now()
     WHERE id = ${r.id}::uuid AND org_id = ${b.orgId}::uuid AND sections_sent IS NULL`)
  const mailId = await b.mail({
    to: ready.recipient.email,
    subject: `${r.project_name}: week ending ${r.period_end}`,
    text: reportText(r.sections),
    reportId: r.id,
  })
  await b.tx.execute(drizzleSql`
    UPDATE ${projectsRel("client_reports")}
       SET status = 'sent', sent_at = now(), mail_message_id = ${mailId}, updated_at = now()
     WHERE id = ${r.id}::uuid AND org_id = ${b.orgId}::uuid`)
  await b.tx.queueEvent({
    app: "projects",
    entity: "client_report",
    action: "sent",
    entityId: r.id,
    data: { reportId: r.id, projectId: r.project_id, periodEnd: r.period_end },
    actorId: b.approverId,
    actorType: "user",
    orgId: b.orgId,
  })
  return {
    reportId: r.id,
    projectName: r.project_name,
    periodEnd: r.period_end,
    status: "sent",
    sentTo: ready.recipient.email,
    message: `Sent: the report on ${r.project_name} for the week ending ${r.period_end} went to ${ready.recipient.email} and is on the client's portal when the project's reports are shared there. It no longer changes. Next: a correction goes in next week's report.`,
  }
}

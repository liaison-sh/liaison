// SPDX-License-Identifier: FSL-1.1-ALv2
// The Home lines of time and budgets, all calm (low urgency, no count, no colour):
//
// - Month close: a computed row on one day of the month only, the last working day strictly
//   before its last calendar day, to the project's biller, for daily, hourly and retainer
//   projects with no reconcile past proposed for that month, whoever drafted it (read
//   privileged, as project ids alone). It reads plans, days off and reconciles only: no time
//   entered, commit, calendar or mail. A day missed is not shown later.
// - More planned than fits: one persisted line per person and ISO week, to the leads of the
//   projects holding that person's planned work that week, never to the person. Planned time
//   comes from timeboxes only (capacity), never from time entered or activity. A line once
//   raised for a week is not raised again, read, set aside or not; the week's end retires it.
import {
  type AttentionItem,
  type AttentionKind,
  addCalendarDays,
  expandDaysOff,
  isoWeekdayOf,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { afterCurrentCommit } from "~/db/commit-hooks"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { scopeHoldersInTx } from "~/modules/permissions/scope-holders"
import { getCapacity } from "./capacity"
import { orgTimezone } from "./time-plan"
import { todayIn } from "./took"

const log = rootLogger.child({ module: "projects/home-lines" })

type SqlClient = RlsClient | RlsTx | PrivilegedDb

export const MONTH_CLOSE_KIND = "projects:time_budgets.month_close"
export const CAPACITY_OVER_KIND = "projects:time_budgets.capacity_over"
const CAPACITY_ENTITY = "capacity"
/** Who reads capacity, and so who is told when someone has more planned than fits. */
export const CAPACITY_LINE_SCOPE = "projects:capacity:read"
/** Calm: these lines sort below anything that asks for action today. */
const CALM_URGENCY = 20
/** The bases a month-close line is for: billed by time or by the month. */
const MONTH_CLOSE_BASES = ["daily", "hourly", "retainer"] as const

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0))
  return d.toISOString().slice(0, 10)
}

/**
 * The one day the month-close line shows: the last working day (Monday to Friday, not a
 * company day off) strictly before the month's last calendar day.
 */
export function monthCloseDay(
  year: number,
  month: number,
  companyOff: ReadonlySet<string>,
): string {
  let d = addCalendarDays(lastDayOfMonth(year, month), -1)
  while (isoWeekdayOf(d) > 5 || companyOff.has(d)) d = addCalendarDays(d, -1)
  return d
}

async function companyDaysOff(tx: SqlClient, orgId: string, from: string, to: string) {
  const rows = extractRows<{ starts_on: string; ends_on: string; yearly: boolean }>(
    await tx.execute(drizzleSql`
      SELECT starts_on::text AS starts_on, ends_on::text AS ends_on, recurs_yearly AS yearly
        FROM ${projectsRel("days_off")} WHERE org_id = ${orgId}::uuid`),
  ).map((r) => ({ startsOn: r.starts_on, endsOn: r.ends_on, yearly: r.yearly }))
  return new Set(expandDaysOff(rows, from, to))
}

/**
 * Which of these projects already have the month reconciled past proposed, whoever drafted it.
 * Read privileged, since a biller without reconcile read cannot see a colleague's draft under
 * RLS; it returns project ids only, nothing of the reconcile itself, and the line it suppresses
 * names only the project the biller already reads.
 */
async function monthsReconciled(
  orgId: string,
  projectIds: readonly string[],
  monthStart: string,
  monthEnd: string,
): Promise<Set<string>> {
  return withPrivilegedDb(
    orgId,
    "projects-month-close-reconciled",
    async (ptx) =>
      new Set(
        extractRows<{ project_id: string }>(
          await ptx.execute(drizzleSql`
          SELECT DISTINCT r.project_id::text AS project_id
            FROM ${projectsRel("reconciliations")} r
           WHERE r.org_id = ${orgId}::uuid AND r.state <> 'proposed'
             AND r.project_id IN (${drizzleSql.join(
               projectIds.map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})
             AND r.period_start <= ${monthEnd}::date
             AND COALESCE(r.period_end, r.period_start) >= ${monthStart}::date`),
        ).map((r) => r.project_id),
      ),
  )
}

/**
 * The month-close rows for the caller (and for the people away today who name the caller next
 * in line, each tagged). Empty on every day but the month's one day.
 */
export async function monthCloseItems(
  tx: SqlClient,
  orgId: string,
  callerUserId: string,
  forUserIds: readonly string[] = [],
  now: Date = new Date(),
): Promise<AttentionItem[]> {
  const today = todayIn(await orgTimezone(tx as RlsClient | PrivilegedDb, orgId), now)
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const monthStart = `${today.slice(0, 7)}-01`
  const monthEnd = lastDayOfMonth(year, month)
  // The feed polls often: only the month's last two weeks can hold its one day.
  if (today < addCalendarDays(monthEnd, -14) || today >= monthEnd) return []
  const off = await companyDaysOff(tx, orgId, monthStart, monthEnd)
  if (today !== monthCloseDay(year, month, off)) return []

  const people = [callerUserId, ...forUserIds.filter((id) => id !== callerUserId)]
  const rows = extractRows<{ id: string; name: string; biller: string }>(
    await tx.execute(drizzleSql`
      SELECT p.id::text AS id, p.name, COALESCE(tp.biller_id, p.owner_id)::text AS biller
        FROM ${projectsRel("projects")} p
        JOIN ${projectsRel("project_time_plan")} tp ON tp.project_id = p.id AND tp.org_id = p.org_id
       WHERE p.org_id = ${orgId}::uuid AND p.kind = 'work' AND p.time_budgets_on
         AND p.archived_at IS NULL
         AND tp.basis IN (${drizzleSql.join(
           MONTH_CLOSE_BASES.map((b) => drizzleSql`${b}`),
           drizzleSql`, `,
         )})
         AND COALESCE(tp.biller_id, p.owner_id) IN (${drizzleSql.join(
           people.map((id) => drizzleSql`${id}::uuid`),
           drizzleSql`, `,
         )})
       ORDER BY p.name`),
  )
  if (rows.length === 0) return []
  const done = await monthsReconciled(
    orgId,
    rows.map((r) => r.id),
    monthStart,
    monthEnd,
  )
  const monthName = MONTHS[month - 1]
  return rows
    .filter((r) => !done.has(r.id))
    .map((r) => ({
      id: `projects:month_close:${r.id}:${today.slice(0, 7)}`,
      app: "projects",
      entity: "project",
      entityId: r.id,
      // An app-qualified kind, outside the kernel list (as kernel:away.recap is).
      kind: MONTH_CLOSE_KIND as AttentionKind,
      summary: `${r.name}: ${monthName} ends soon. Reconcile it when you are ready.`,
      urgency: CALM_URGENCY,
      occurredAt: now.toISOString(),
      action: { type: "open_entity", tabType: "projects:project", entityId: r.id },
      metadata: {
        projectId: r.id,
        projectName: r.name,
        period: today.slice(0, 7),
        ...(r.biller !== callerUserId ? { forUserId: r.biller } : {}),
      },
    }))
}

/** Orgs with at least one work project using time and budgets. */
async function orgsUsingTime(): Promise<string[]> {
  return withSystemDb("projects-home-lines-orgs", async (tx) =>
    extractRows<{ org_id: string }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT org_id::text AS org_id FROM ${projectsRel("projects")}
         WHERE kind = 'work' AND time_budgets_on AND archived_at IS NULL`),
    ).map((r) => r.org_id),
  )
}

/**
 * Raise this week's "more planned than fits" lines for one org. A person is over when planned
 * exceeds available by more than three hours (capacity's own note). Each lead of a counted
 * project holding that person's planned work this week, with capacity read, gets one line; the
 * person never does. Lines of earlier weeks still unread are retired.
 */
export async function raiseCapacityLines(
  orgId: string,
  now: Date = new Date(),
): Promise<{ raised: number }> {
  return withPrivilegedDb(
    orgId,
    "projects-capacity-lines",
    async (tx) => {
      const cap = await getCapacity({ tx, orgId, now, withProjects: true })
      await tx.execute(drizzleSql`
        UPDATE ${kernelRel("attention_events")} SET read_at = now()
         WHERE org_id = ${orgId}::uuid AND app = 'projects' AND kind = ${CAPACITY_OVER_KIND}
           AND read_at IS NULL AND entity_id NOT LIKE ${`%:${cap.week}`}`)
      const over = cap.people.filter((p) => p.plannedMinutes - p.availableMinutes > 180)
      if (over.length === 0) return { raised: 0 }
      const readers = new Set(await scopeHoldersInTx(tx, orgId, CAPACITY_LINE_SCOPE))
      let raised = 0
      for (const person of over) {
        const projectIds = [...new Set(person.tasks.map((t) => t.projectId).filter(Boolean))]
        if (projectIds.length === 0) continue
        const leads = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT DISTINCT u.id::text AS id
              FROM ${projectsRel("projects")} p
              JOIN ${kernelRel("users")} u ON u.org_id = p.org_id AND u.status = 'active'
             WHERE p.org_id = ${orgId}::uuid
               AND p.id IN (${drizzleSql.join(
                 projectIds.map((id) => drizzleSql`${id}::uuid`),
                 drizzleSql`, `,
               )})
               AND (u.id = p.owner_id OR EXISTS (
                 SELECT 1 FROM ${projectsRel("tasks")} t
                  WHERE t.project_id = p.id AND t.org_id = p.org_id
                    AND t.assignee_id = u.id AND t.archived_at IS NULL))`),
        )
          .map((r) => r.id)
          .filter((id) => id !== person.userId && readers.has(id))
        const entityId = `${person.userId}:${cap.week}`
        const summary = `${person.name} has more planned than fits in week ${Number(cap.week.slice(6))}.`
        for (const lead of leads) {
          // Once per person and week: a line read or set aside is not raised again.
          const told = extractRows<{ told: boolean }>(
            await tx.execute(drizzleSql`
              SELECT EXISTS (
                SELECT 1 FROM ${kernelRel("attention_events")}
                 WHERE org_id = ${orgId}::uuid AND user_id = ${lead}::uuid AND app = 'projects'
                   AND entity_type = ${CAPACITY_ENTITY} AND entity_id = ${entityId}
                   AND kind = ${CAPACITY_OVER_KIND}) AS told`),
          )[0]?.told
          if (told === true) continue
          const metadata = JSON.stringify({ week: cap.week, personId: person.userId })
          await tx.execute(drizzleSql`
            INSERT INTO ${kernelRel("attention_events")}
              (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id,
               actor_type, metadata, occurred_at, is_urgent, digest_state, digest_eligible_at,
               email_only)
            VALUES (${orgId}::uuid, ${lead}::uuid, 'projects', ${CAPACITY_ENTITY}, ${entityId},
                    ${CAPACITY_OVER_KIND}, ${CALM_URGENCY}, ${summary}, NULL, 'system',
                    ${metadata}::jsonb, ${now.toISOString()}::timestamptz, false, 'not_eligible',
                    now(), false)
            ON CONFLICT (user_id, app, entity_type, entity_id, kind)
              WHERE read_at IS NULL AND email_only = false
              DO NOTHING`)
          raised++
        }
      }
      return { raised }
    },
    { pool: "jobs" },
  )
}

/** After the caller's commit: a change to company days off may put someone over this week. */
export function scheduleCapacityLines(orgId: string): void {
  const start = () => {
    raiseCapacityLines(orgId).catch((err: unknown) =>
      log.warn({ err, orgId }, "capacity lines after a days-off change failed"),
    )
  }
  if (!afterCurrentCommit(start)) start()
}

/** The daily pass: this week's lines for every org using time and budgets. */
export async function raiseCapacityLinesAll(now: Date = new Date()): Promise<{ orgs: number }> {
  const orgs = await orgsUsingTime()
  for (const orgId of orgs) {
    try {
      await raiseCapacityLines(orgId, now)
    } catch (err) {
      log.warn({ err, orgId }, "capacity lines failed for one org")
    }
  }
  return { orgs: orgs.length }
}

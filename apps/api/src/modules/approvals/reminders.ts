// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REMINDING A PERSON OF THEIR OWN WAITING REQUESTS.
//
// A person asks their agent to do something, the call parks as an approval,
// and nobody ever decides it: often the person could have approved it
// themselves and simply forgot. While any of those requests has waited longer
// than the person's reminder interval, their personal agent says so in its
// conversation with them, once per interval.
//
// The interval is the person's own setting (Settings -> Notifications,
// "Approval reminders"; `approvalReminder` in user_preferences.
// notification_channels, packages/shared/src/notifications/approval-reminder.ts):
// daily (24 hours, the default when nothing is stored), every 3 days (72),
// weekly (168), or off (never reminded).
//
// The sweep only decides WHETHER to speak. It never writes the words: it posts
// one system line (`metadata.type = 'approval-reminder'`) in the person's DM
// with their agent, carrying the waiting requests as facts (system-event-
// replay.ts turns them into the agent's context), and starts ONE background
// turn of that agent off the line, like a saved secret's follow-up turn. The
// turn's reply is `unprompted`, so it reaches the person's attention feed and
// push like a routine's post. Nothing pending, no line and no turn: no model
// spend.
//
// Which requests: pending, raised for the person themselves (`requested_by` is
// them) by their OWN personal agent, or from their own MCP client (no agent,
// `metadata.origin = 'mcp'`), not by a routine (`originRoutineId` / `originRoutineRunId`), older than the
// person's interval.
// A bundle counts once (its head). Requests the person cannot decide are kept:
// the line says who can, so the agent tells them what it is waiting on.
//
// Once per person per interval, derived from the last reminder line in that
// DM (no new column): checked and written under a per-person advisory lock, so
// two workers or a restart never post twice. `force` (the operator's CLI)
// skips the interval check and the person's "off", but still needs a request
// that has waited at least a day (or the person's longer interval).

import {
  APPROVAL_REMINDER_HOURS,
  type ApprovalAuthorityFacts,
  type ApprovalReminderFrequency,
  canDecidePure,
  DEFAULT_APPROVAL_REMINDER,
  decidingScope,
  isSharedSurfaceFacts,
  readApprovalReminder,
} from "@liaison/shared"
import { and, sql as drizzleSql, eq, gt, type SQL } from "drizzle-orm"
import { extractRows } from "~/db"
import { advisoryXactLock } from "~/db/advisory-lock"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob, enqueueAppJobForServer } from "~/infra/jobs/jobs"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { apiViewer, authorityFacts } from "~/modules/approvals/authority"
import { approvalActionPhrase, deriveApprovalTitle } from "~/modules/approvals/payload-title"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import { createOrGetAgentDm } from "~/modules/threads/thread"

const log = rootLogger.child({ module: "approval-reminders" })
const K = drizzleSql.raw(schemaRef("kernel"))

/** `metadata.type` of the reminder line (system-event-replay.ts reads it). */
export const APPROVAL_REMINDER_TYPE = "approval-reminder"
/** The job that runs the agent's turn off the line. */
export const APPROVAL_REMINDER_TURN_JOB = "approval-reminder-turn"
/** The sweep's schedule: hourly, off the quarter hours. */
export const APPROVAL_REMINDER_CRON = "23 * * * *"
/**
 * The default interval: how long a request waits before it is reminded of, and
 * how often a person is reminded, for everyone who did not choose another one.
 */
export const APPROVAL_REMINDER_INTERVAL_HOURS = APPROVAL_REMINDER_HOURS[DEFAULT_APPROVAL_REMINDER]
/** Requests listed on the line; the count says how many there are in all. */
const MAX_LISTED = 20
/** Candidates read per page of the sweep, and pages per run (bounded pool use). */
const PAGE_SIZE = 100
const MAX_PAGES = 20

/** One waiting request as the line carries it. */
export interface ReminderItem {
  requestId: string
  handle: string
  toolName: string
  /** The action in words ("Update contact"): the agent groups by it. */
  kind: string
  title: string
  ageHours: number
  link: string
  canDecide: boolean
  /** Set to "mcp" when the person made the request from their own MCP client. */
  origin?: "mcp"
  /** When the person cannot decide it: the permission that decides it, and who was asked. */
  waitingOn?: { permission: string; names: string[] }
}

export interface ReminderMetadata {
  type: typeof APPROVAL_REMINDER_TYPE
  userId: string
  agentId: string
  count: number
  items: ReminderItem[]
  approvalsLink: string
}

export interface ApprovalReminderTurnPayload {
  orgId: string
  threadId: string
  messageId: string
  userId: string
  agentId: string
}

export type StartReminderTurn = (payload: ApprovalReminderTurnPayload) => Promise<void>

export type RemindResult =
  | { status: "sent"; threadId: string; messageId: string; count: number }
  | { status: "nothing_pending" | "throttled" | "inactive" | "off" }

/**
 * The person's interval in hours, over `up` (their user_preferences row, left
 * joined: no row or no stored value is the default). NULL when they turned it off.
 * Built from the shared table, so the sweep and the settings never disagree.
 */
const PERSON_INTERVAL_HOURS = drizzleSql`(CASE up.notification_channels->>'approvalReminder'
  WHEN 'off' THEN NULL
  WHEN 'every_3_days' THEN ${APPROVAL_REMINDER_HOURS.every_3_days}::int
  WHEN 'weekly' THEN ${APPROVAL_REMINDER_HOURS.weekly}::int
  ELSE ${APPROVAL_REMINDER_INTERVAL_HOURS}::int END)`

/**
 * The qualifying-request predicate, over `ar` left-joined to its agent `a`
 * (NULL for MCP rows), for requests older than `hours` (a NULL interval
 * qualifies nothing).
 */
function qualifying(hours: SQL) {
  return drizzleSql`
    ar.status = 'pending'
    AND ar.created_at <= now() - make_interval(hours => ${hours})
    AND ar.expires_at > now()
    AND (ar.bundle_id IS NULL OR ar.bundle_id = ar.id)
    AND NOT (ar.metadata ? 'originRoutineId')
    AND NOT (ar.metadata ? 'originRoutineRunId')
    AND (
      (a.kind = 'personal' AND a.owner_user_id = ar.requested_by)
      OR (ar.agent_id IS NULL AND ar.metadata->>'origin' = 'mcp')
    )`
}

interface StaleRow {
  id: string
  handle: string
  tool_name: string
  thread_id: string
  summary: { title?: unknown } | null
  current_payload: unknown
  age_hours: number
  approve_scope: string | null
  resource_owner_id: string | null
  requested_by: string
  notify_user_ids: string[] | null
  origin: string | null
}

async function startTurnByJob(payload: ApprovalReminderTurnPayload): Promise<void> {
  // attempts: 1, like every re-invocation: the turn spends credits and posts a
  // reply, so a retry after a partial run would speak twice.
  await enqueueAppJob("kernel", APPROVAL_REMINDER_TURN_JOB, payload, {
    jobId: `${APPROVAL_REMINDER_TURN_JOB}:${payload.messageId}`,
    attempts: 1,
  })
}

/** The same turn, queued from a process that hosts no job worker (the CLI). */
export const startReminderTurnOnServer: StartReminderTurn = async (payload) => {
  await enqueueAppJobForServer("kernel", APPROVAL_REMINDER_TURN_JOB, payload, {
    jobId: `${APPROVAL_REMINDER_TURN_JOB}:${payload.messageId}`,
    attempts: 1,
  })
}

const WAITED: Record<Exclude<ApprovalReminderFrequency, "off">, string> = {
  daily: "a day",
  every_3_days: "3 days",
  weekly: "a week",
}

function lineContent(count: number, frequency: ApprovalReminderFrequency): string {
  const span = WAITED[frequency === "off" ? DEFAULT_APPROVAL_REMINDER : frequency]
  return count === 1
    ? `Reminder: 1 of your requests has waited more than ${span} for a decision.`
    : `Reminder: ${count} of your requests have waited more than ${span} for a decision.`
}

function titleOf(r: StaleRow): string {
  const authored = typeof r.summary?.title === "string" ? r.summary.title.trim() : ""
  if (authored) return authored
  const payload =
    r.current_payload && typeof r.current_payload === "object"
      ? (r.current_payload as Record<string, unknown>)
      : null
  return deriveApprovalTitle(r.tool_name, payload) ?? approvalActionPhrase(r.tool_name)
}

/**
 * Remind one person, if they have a qualifying request and (unless `force`)
 * reminders on and none in their last interval. Posts the line and starts the turn.
 */
export async function remindUserOfWaitingApprovals(args: {
  orgId: string
  userId: string
  force?: boolean
  startTurn?: StartReminderTurn
}): Promise<RemindResult> {
  const { orgId, userId } = args
  const prep = await withPrivilegedDb(orgId, "approval-reminder-prepare", async (tx) => {
    const [person] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (person?.status !== "active") return null
    const [pref] = extractRows<{ approval_reminder: string | null }>(
      await tx.execute(drizzleSql`
        SELECT notification_channels->>'approvalReminder' AS approval_reminder
          FROM ${K}.user_preferences WHERE user_id = ${userId}::uuid`),
    )
    const frequency = readApprovalReminder(pref?.approval_reminder)
    if (frequency === "off" && !args.force) return { off: true as const }
    // Forced while off: the default interval.
    const hours =
      APPROVAL_REMINDER_HOURS[frequency === "off" ? DEFAULT_APPROVAL_REMINDER : frequency]
    const rows = extractRows<StaleRow>(
      await tx.execute(drizzleSql`
        SELECT ar.id, ar.handle, ar.tool_name, ar.thread_id, ar.summary, ar.current_payload,
               floor(extract(epoch FROM now() - ar.created_at) / 3600)::int AS age_hours,
               ar.approve_scope, ar.resource_owner_id, ar.requested_by, ar.notify_user_ids,
               ar.metadata->>'origin' AS origin
          FROM ${K}.approval_requests ar
          LEFT JOIN ${K}.agents a ON a.id = ar.agent_id AND a.org_id = ar.org_id
         WHERE ar.org_id = ${orgId}::uuid AND ar.requested_by = ${userId}::uuid
           AND ${qualifying(drizzleSql`${hours}`)}
         ORDER BY ar.created_at ASC`),
    )
    if (rows.length === 0) return { frequency, hours, rows, names: new Map<string, string>() }
    const others = [
      ...new Set(rows.flatMap((r) => (r.notify_user_ids ?? []).filter((id) => id !== userId))),
    ]
    const names = new Map<string, string>()
    if (others.length > 0) {
      const nameRows = extractRows<{ id: string; name: string | null }>(
        await tx.execute(drizzleSql`
          SELECT id, name FROM ${K}.users
           WHERE id IN (${drizzleSql.join(
             others.map((id) => drizzleSql`${id}::uuid`),
             drizzleSql`, `,
           )}) AND status = 'active'`),
      )
      for (const n of nameRows) if (n.name) names.set(n.id, n.name)
    }
    return {
      frequency,
      hours,
      rows,
      names,
      agentId: await getOrCreatePersonalAgentId(tx, { orgId, userId }),
      perms: await loadEffectivePermissions(tx, userId, orgId),
    }
  })
  if (!prep) return { status: "inactive" }
  if ("off" in prep) return { status: "off" }
  if (prep.rows.length === 0 || !prep.agentId || !prep.perms) return { status: "nothing_pending" }
  const { frequency, hours, rows, names, agentId, perms } = prep

  const viewer = apiViewer(userId, perms.scopes)
  const items: ReminderItem[] = rows.slice(0, MAX_LISTED).map((r) => {
    const facts: ApprovalAuthorityFacts = authorityFacts(r)
    const canDecide = canDecidePure(facts, viewer, { sharedSurface: isSharedSurfaceFacts(facts) })
    return {
      requestId: r.id,
      handle: r.handle,
      toolName: r.tool_name,
      kind: approvalActionPhrase(r.tool_name),
      title: titleOf(r),
      ageHours: r.age_hours,
      link: `${env.BASE_URL}/threads/${r.thread_id}`,
      canDecide,
      ...(r.origin === "mcp" ? { origin: "mcp" as const } : {}),
      ...(canDecide
        ? {}
        : {
            waitingOn: {
              permission: decidingScope(facts),
              names: (r.notify_user_ids ?? [])
                .filter((id) => id !== userId)
                .flatMap((id) => (names.has(id) ? [names.get(id) as string] : []))
                .slice(0, 3),
            },
          }),
    }
  })

  const asPerson = {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
  const posted = await withRlsContext(asPerson, async (tx) => {
    // Two sweeps (two workers, a restart mid-run, the CLI) wait here, and the
    // second finds the first one's line.
    await tx.execute(advisoryXactLock(`${APPROVAL_REMINDER_TYPE}:${orgId}:${userId}`))
    const dm = await createOrGetAgentDm(tx, { orgId, userId, agentId })
    if (!dm) throw new Error(`approval reminder: no conversation with agent ${agentId}`)
    if (!args.force) {
      const since = new Date(Date.now() - hours * 3600_000)
      const [recent] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, dm.id),
            eq(messages.orgId, orgId),
            eq(messages.authorType, "system"),
            gt(messages.createdAt, since),
            drizzleSql`${messages.metadata}->>'type' = ${APPROVAL_REMINDER_TYPE}`,
          ),
        )
        .limit(1)
      if (recent) return null
    }
    const metadata: ReminderMetadata = {
      type: APPROVAL_REMINDER_TYPE,
      userId,
      agentId,
      count: rows.length,
      items,
      approvalsLink: `${env.BASE_URL}/approvals`,
    }
    const message = await sendMessage(tx, {
      // The person's own requests, in their own conversation with their agent.
      requiredScopes: [],
      orgId,
      userId,
      threadId: dm.id,
      content: lineContent(rows.length, frequency),
      authorType: "system",
      agentId,
      metadata,
    })
    if (!message)
      throw new Error("approval reminder: the person is not in their agent conversation")
    return { threadId: dm.id, messageId: message.id }
  })
  if (!posted) return { status: "throttled" }

  try {
    await (args.startTurn ?? startTurnByJob)({
      orgId,
      threadId: posted.threadId,
      messageId: posted.messageId,
      userId,
      agentId,
    })
  } catch (err) {
    // No turn means no reminder: take the line back, so the person is not left
    // with a bare system line and the next sweep is not throttled by it.
    await withPrivilegedDb(orgId, "approval-reminder-unpost", (tx) =>
      tx.delete(messages).where(and(eq(messages.id, posted.messageId), eq(messages.orgId, orgId))),
    )
    throw err
  }
  log.info({ orgId, userId, count: rows.length }, "approval reminder posted")
  return { status: "sent", ...posted, count: rows.length }
}

interface Candidate {
  org_id: string
  requested_by: string
}
type Cursor = { orgId: string; userId: string }

/**
 * One page of people with a qualifying request (older than their own
 * interval; nobody who turned reminders off), after `cursor` in (org, person) order.
 */
async function scanCandidates(cursor: Cursor | null): Promise<Candidate[]> {
  const result: unknown = await withSystemDb("approval-reminder-scan", (db) =>
    db.execute(drizzleSql`
      SELECT DISTINCT ar.org_id, ar.requested_by
        FROM ${K}.approval_requests ar
        LEFT JOIN ${K}.agents a ON a.id = ar.agent_id AND a.org_id = ar.org_id
        LEFT JOIN ${K}.user_preferences up ON up.user_id = ar.requested_by
       WHERE ${qualifying(PERSON_INTERVAL_HOURS)}
         ${cursor ? drizzleSql`AND (ar.org_id, ar.requested_by) > (${cursor.orgId}::uuid, ${cursor.userId}::uuid)` : drizzleSql``}
       ORDER BY ar.org_id, ar.requested_by
       LIMIT ${PAGE_SIZE}`),
  )
  return extractRows<Candidate>(result)
}

/**
 * The scheduled pass: every person with a qualifying request, page by page
 * (each person in their own short transactions), reminded unless they were
 * within their interval. Returns how many reminders went out.
 */
export async function runApprovalReminderSweep(
  opts: { startTurn?: StartReminderTurn } = {},
): Promise<{ candidates: number; sent: number }> {
  let after: Cursor | null = null
  let candidates = 0
  let sent = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await scanCandidates(after)
    for (const c of batch) {
      candidates++
      try {
        const res = await remindUserOfWaitingApprovals({
          orgId: c.org_id,
          userId: c.requested_by,
          ...(opts.startTurn ? { startTurn: opts.startTurn } : {}),
        })
        if (res.status === "sent") sent++
      } catch (err) {
        log.error({ err, orgId: c.org_id, userId: c.requested_by }, "approval reminder failed")
      }
    }
    const last: Candidate | undefined = batch[batch.length - 1]
    if (!last || batch.length < PAGE_SIZE) break
    after = { orgId: last.org_id, userId: last.requested_by }
  }
  return { candidates, sent }
}

/**
 * The agent's turn off the reminder line: as the person (their current
 * permissions), AS their personal agent, in the background. Its reply is
 * `unprompted`: news to the person, so it reaches their feed and push.
 */
export async function runApprovalReminderTurn(payload: ApprovalReminderTurnPayload): Promise<void> {
  const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
  const perms = await withPrivilegedDb(payload.orgId, "approval-reminder-turn-perms", (tx) =>
    loadEffectivePermissions(tx, payload.userId, payload.orgId),
  )
  await invokeAgentForThread(
    payload.threadId,
    payload.messageId,
    {
      userId: payload.userId,
      orgId: payload.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    payload.orgId,
    true, // background: a job-driven turn, nobody at the keyboard
    undefined, // budget: default
    undefined, // routineId: not a routine tick
    undefined, // seedDiscoveredTools: lean start
    false, // anchorHistory: the agent reads its conversation
    payload.agentId,
    undefined, // coordination: not an agent's ask
    { unprompted: true },
  )
}

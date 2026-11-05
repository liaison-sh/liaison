// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { runApprovalRemindersCli } from "~/cli/approval-reminders"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { systemEventLine } from "~/modules/agent/context/system-event-replay"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import {
  APPROVAL_REMINDER_TYPE,
  type ApprovalReminderTurnPayload,
  type ReminderMetadata,
  runApprovalReminderSweep,
} from "~/modules/approvals/reminders"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let agentId: string
let threadId: string
let roleAgentId: string

async function seed(opts: {
  handle: string
  ageSql?: string
  status?: string
  notifySelf?: boolean
  metadata?: Record<string, unknown>
  agent?: string | null
}): Promise<string> {
  const id = crypto.randomUUID()
  const notify = opts.notifySelf === false ? "{}" : `{${userId}}`
  await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary,
      metadata, agent_id, created_at
    ) VALUES (
      ${id}, ${orgId}, ${opts.handle}, ${threadId}, ${threadId}, 'remindtest:update_contact',
      '{}'::jsonb, '{"name":"Ada"}'::jsonb, now() + interval '30 days', ${notify}::uuid[],
      ${userId}, ${opts.status ?? "pending"}, 'gated',
      ${JSON.stringify({ kind: "decide", title: `Update contact ${opts.handle}`, lines: [] })}::jsonb,
      ${JSON.stringify(opts.metadata ?? {})}::jsonb, ${opts.agent === undefined ? agentId : opts.agent},
      now() - ${opts.ageSql ?? "30 hours"}::interval
    )`
  return id
}

/** The person's approval reminder setting, as Settings -> Notifications stores it (null = never chosen). */
async function setFrequency(value: string | null) {
  const channels = value === null ? null : JSON.stringify({ approvalReminder: value })
  await sql`INSERT INTO kernel.user_preferences (user_id, notification_channels)
    VALUES (${userId}, ${channels}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET notification_channels = EXCLUDED.notification_channels`
}

async function reminderLines() {
  return sql<{ id: string; thread_id: string; content: string; metadata: ReminderMetadata }[]>`
    SELECT id, thread_id, content, metadata FROM kernel.messages
     WHERE org_id = ${orgId} AND author_type = 'system'
       AND metadata->>'type' = ${APPROVAL_REMINDER_TYPE}
     ORDER BY created_at ASC`
}

describe("approval reminders", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    const [admin] = await withSystemDb("reminder-test-admin", (db) =>
      db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1),
    )
    if (!admin) throw new Error("no admin")
    userId = admin.id
    agentId = await withPrivilegedDb(orgId, "reminder-test-agent", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId, userId }),
    )
    roleAgentId = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${roleAgentId}, ${orgId}, 'role', 'reminder-role', 'Role agent', '["*"]'::jsonb)`
    threadId = crypto.randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}, ${orgId}, 'reminder-origin', 'thread', ${userId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}, ${userId}, ${orgId}, 'admin')`
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}
      AND metadata->>'type' = ${APPROVAL_REMINDER_TYPE}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
    // Nobody chose: the default (daily) for everyone.
    await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${userId}`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("reminds once per 24 hours of stale self-requested approvals only, and again after 24 hours", async () => {
    await seed({ handle: "stale-mine" })
    await seed({ handle: "stale-not-mine-to-decide", notifySelf: false, ageSql: "3 days" })
    await seed({ handle: "fresh", ageSql: "2 hours" })
    await seed({ handle: "routine", metadata: { originRoutineId: crypto.randomUUID() } })
    await seed({ handle: "routine-run", metadata: { originRoutineRunId: crypto.randomUUID() } })
    await seed({ handle: "decided", status: "approved" })
    await seed({ handle: "no-agent", agent: null })
    await seed({ handle: "mcp-mine", agent: null, metadata: { origin: "mcp" } })
    await seed({
      handle: "mcp-routine",
      agent: null,
      metadata: { origin: "mcp", originRoutineId: crypto.randomUUID() },
    })
    await seed({ handle: "role-agent", agent: roleAgentId })

    const turns: ApprovalReminderTurnPayload[] = []
    const startTurn = async (p: ApprovalReminderTurnPayload) => {
      turns.push(p)
    }

    const first = await runApprovalReminderSweep({ startTurn })
    expect(first.sent).toBe(1)
    expect(turns).toHaveLength(1)
    const [line] = await reminderLines()
    expect(line).toBeDefined()
    expect(turns[0]).toEqual({
      orgId,
      threadId: line!.thread_id,
      messageId: line!.id,
      userId,
      agentId,
    })
    // Read before the matchers below: an asymmetric matcher may be written into the received object.
    const replay = systemEventLine({
      content: line!.content,
      metadata: structuredClone(line!.metadata),
    })
    expect(line!.metadata.count).toBe(3)
    const byHandle = new Map(line!.metadata.items.map((i) => [i.handle, i]))
    expect([...byHandle.keys()].sort()).toEqual([
      "mcp-mine",
      "stale-mine",
      "stale-not-mine-to-decide",
    ])
    expect(byHandle.get("mcp-mine")).toMatchObject({ origin: "mcp", canDecide: true })
    expect(byHandle.get("stale-mine")!.origin).toBeUndefined()
    expect(byHandle.get("stale-mine")).toMatchObject({
      canDecide: true,
      kind: "Update contact",
      title: "Update contact stale-mine",
      link: expect.stringContaining(`/threads/${threadId}`),
    })
    expect(byHandle.get("stale-not-mine-to-decide")).toMatchObject({
      canDecide: false,
      waitingOn: { permission: "remindtest:approve" },
    })
    expect(byHandle.get("stale-not-mine-to-decide")!.ageHours).toBeGreaterThanOrEqual(72)

    // The line is the agent's context: both requests, who can decide, the links.
    expect(replay).toContain("stale-mine")
    expect(replay).toContain("made from the person's MCP client")
    expect(replay).toContain("the person can approve or reject it")
    expect(replay).toContain("waits on someone holding remindtest:approve")
    expect(replay).toContain(`/threads/${threadId}`)
    // Unprompted: straight to the point, no "here is" preamble, in the person's language.
    expect(replay).toContain("This message is unprompted")
    expect(replay).toContain('no preamble such as "here is"')
    expect(replay).toContain("in the language the person usually writes to you")
    // Only their own requests: never the size of the whole approvals queue.
    expect(replay).toContain("never count or mention the rest of the approvals queue")
    expect(replay).toContain("without quoting a total")

    // Within 24 hours: nothing.
    const second = await runApprovalReminderSweep({ startTurn })
    expect(second.sent).toBe(0)
    expect(turns).toHaveLength(1)
    expect(await reminderLines()).toHaveLength(1)

    // 24 hours later, still waiting: reminded again.
    await sql`UPDATE kernel.messages SET created_at = now() - interval '25 hours'
      WHERE id = ${line!.id}`
    const third = await runApprovalReminderSweep({ startTurn })
    expect(third.sent).toBe(1)
    expect(turns).toHaveLength(2)
    expect(await reminderLines()).toHaveLength(2)
  })

  it("starts nothing when only fresh, routine-raised or decided approvals are pending", async () => {
    await seed({ handle: "fresh", ageSql: "2 hours" })
    await seed({ handle: "routine", metadata: { originRoutineId: crypto.randomUUID() } })
    await seed({ handle: "decided", status: "denied" })
    let called = 0
    const res = await runApprovalReminderSweep({
      startTurn: async () => {
        called++
      },
    })
    expect(res).toEqual({ candidates: 0, sent: 0 })
    expect(called).toBe(0)
    expect(await reminderLines()).toHaveLength(0)
  })

  it("the CLI reminds one member, honours the 24-hour throttle unless --force, and needs a waiting request", async () => {
    const turns: ApprovalReminderTurnPayload[] = []
    const deps = {
      startTurn: async (p: ApprovalReminderTurnPayload) => {
        turns.push(p)
      },
    }
    const none = await runApprovalRemindersCli(["--user", userId], deps)
    expect(none.exitCode).toBe(0)
    expect(none.report).toMatchObject({ status: "nothing_pending" })
    // --force never skips the waiting-request check.
    const forcedNone = await runApprovalRemindersCli(["--user", userId, "--force"], deps)
    expect(forcedNone.report).toMatchObject({ status: "nothing_pending" })
    expect(turns).toHaveLength(0)

    await seed({ handle: "stale-cli" })
    const sent = await runApprovalRemindersCli(["--user", userId], deps)
    expect(sent.report).toMatchObject({ status: "sent", count: 1 })
    const throttled = await runApprovalRemindersCli(["--user", userId], deps)
    expect(throttled.report).toMatchObject({ status: "throttled" })
    const forced = await runApprovalRemindersCli(["--user", userId, "--force"], deps)
    expect(forced.report).toMatchObject({ status: "sent", count: 1 })
    expect(turns).toHaveLength(2)

    const missing = await runApprovalRemindersCli([], deps)
    expect(missing.exitCode).toBe(2)
  })

  it("takes the line back when the turn cannot be started, so nothing is left bare or throttled", async () => {
    await seed({ handle: "stale-unstarted" })
    const failing = {
      startTurn: async () => {
        throw new Error("no worker for the turn")
      },
    }
    await expect(runApprovalRemindersCli(["--user", userId], failing)).rejects.toThrow(
      "no worker for the turn",
    )
    const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.messages
      WHERE org_id = ${orgId} AND metadata->>'type' = ${APPROVAL_REMINDER_TYPE}`
    expect(left?.n).toBe(0)
    const turns: ApprovalReminderTurnPayload[] = []
    const retried = await runApprovalRemindersCli(["--user", userId], {
      startTurn: async (p: ApprovalReminderTurnPayload) => {
        turns.push(p)
      },
    })
    expect(retried.report).toMatchObject({ status: "sent", count: 1 })
    expect(turns).toHaveLength(1)
  })

  it("sends nothing to a person who turned reminders off; the CLI says so and --force still sends", async () => {
    await setFrequency("off")
    await seed({ handle: "stale-off", ageSql: "10 days" })
    let called = 0
    const res = await runApprovalReminderSweep({
      startTurn: async () => {
        called++
      },
    })
    expect(res).toEqual({ candidates: 0, sent: 0 })
    expect(called).toBe(0)
    expect(await reminderLines()).toHaveLength(0)

    const turns: ApprovalReminderTurnPayload[] = []
    const deps = {
      startTurn: async (p: ApprovalReminderTurnPayload) => {
        turns.push(p)
      },
    }
    const off = await runApprovalRemindersCli(["--user", userId], deps)
    expect(off.report).toMatchObject({ status: "off" })
    expect(off.message).toContain("turned approval reminders off")
    expect(turns).toHaveLength(0)
    const forced = await runApprovalRemindersCli(["--user", userId, "--force"], deps)
    expect(forced.report).toMatchObject({ status: "sent", count: 1 })
    expect(turns).toHaveLength(1)
  })

  it("weekly: only requests older than a week, and at most one reminder a week", async () => {
    await setFrequency("weekly")
    await seed({ handle: "three-days", ageSql: "3 days" })
    const turns: ApprovalReminderTurnPayload[] = []
    const startTurn = async (p: ApprovalReminderTurnPayload) => {
      turns.push(p)
    }
    // A daily person would be reminded of it; a weekly one is not yet.
    expect(await runApprovalReminderSweep({ startTurn })).toEqual({ candidates: 0, sent: 0 })

    await seed({ handle: "eight-days", ageSql: "8 days" })
    expect((await runApprovalReminderSweep({ startTurn })).sent).toBe(1)
    const [line] = await reminderLines()
    expect(line!.metadata.items.map((i) => i.handle)).toEqual(["eight-days"])
    expect(line!.content).toContain("more than a week")

    // Two days later: still within the week.
    await sql`UPDATE kernel.messages SET created_at = now() - interval '2 days' WHERE id = ${line!.id}`
    expect((await runApprovalReminderSweep({ startTurn })).sent).toBe(0)
    // Eight days later: reminded again.
    await sql`UPDATE kernel.messages SET created_at = now() - interval '8 days' WHERE id = ${line!.id}`
    expect((await runApprovalReminderSweep({ startTurn })).sent).toBe(1)
    expect(turns).toHaveLength(2)
  })

  it("every 3 days: a 2-day-old request waits, a 4-day-old one is reminded of", async () => {
    await setFrequency("every_3_days")
    await seed({ handle: "two-days", ageSql: "2 days" })
    const startTurn = async () => {}
    expect((await runApprovalReminderSweep({ startTurn })).sent).toBe(0)
    await seed({ handle: "four-days", ageSql: "4 days" })
    expect((await runApprovalReminderSweep({ startTurn })).sent).toBe(1)
    const [line] = await reminderLines()
    expect(line!.metadata.items.map((i) => i.handle)).toEqual(["four-days"])
  })
})

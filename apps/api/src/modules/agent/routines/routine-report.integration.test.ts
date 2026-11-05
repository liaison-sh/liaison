// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine reports back to the conversation it was asked for in (0166).
//
// "Send me a message in one minute": the routine ticked on time and its agent
// answered, but only in the routine's own output thread, so in the
// conversation where the person asked, nothing ever arrived. These tests drive
// a real tick through `runRoutineTick` (the agent is a stub that writes its
// replies into the output thread, as a turn does) and read the report
// conversation back from the database.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, asc, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  attentionEvents,
  auditLog,
  messages,
  routines as routinesTbl,
  threadParticipants,
  threads,
} from "~/db/schema/kernel"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import {
  type RoutineReportMetadata,
  resolveReportThreadId,
  routineReportSentence,
} from "~/modules/agent/routines/routine-report"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import {
  handleCreateRoutine,
  handleUpdateRoutine,
} from "~/modules/agent/tools/skills-routines-tools"
import { registerTranslatorConsumer } from "~/modules/attention/translator"
import { createOrGetAgentDm } from "~/modules/threads/thread"
import { countThreadUnread } from "~/modules/threads/thread-state"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let ownerAgentId: string

async function makeRoutine(reportThreadId: string | null): Promise<{ id: string; name: string }> {
  const name = `report-${crypto.randomUUID().slice(0, 8)}`
  return await withPrivilegedDb(orgId, "report-seed-routine", async (tx) => {
    const [row] = await tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId,
        name,
        description: "Report test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Send the user a short message.",
        scopes: [],
        reportThreadId,
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id, name: routinesTbl.name })
    return row!
  })
}

/** One agent reply in the output thread, as a turn writes it. */
async function agentReply(threadId: string, content: string, requiredScopes: string[]) {
  await withPrivilegedDb(orgId, "report-seed-reply", (tx) =>
    tx.insert(messages).values({
      threadId,
      orgId,
      authorId: userId,
      authorType: "agent",
      authorAgentId: ownerAgentId,
      content,
      requiredScopes,
    }),
  )
}

type Reply = { content: string; scopes: string[] }

async function tick(
  routineId: string,
  opts: { replies?: Reply[]; failure?: string; requestedByUserId?: string } = {},
): Promise<{ status: string; prompt: string; outputThreadId: string }> {
  let prompt = ""
  let outputThreadId = ""
  const result = await runRoutineTick({
    orgId,
    routineId,
    scheduledAt: new Date().toISOString(),
    loadOwnerScopes: async () => ["*"],
    checkCredits: async () => null,
    agentInvoker: async (input) => {
      prompt = input.prompt
      outputThreadId = input.threadId
      for (const r of opts.replies ?? []) await agentReply(input.threadId, r.content, r.scopes)
      return { turnsAdded: opts.replies?.length ?? 0, failure: opts.failure ?? null }
    },
    ...(opts.requestedByUserId ? { requestedByUserId: opts.requestedByUserId } : {}),
  })
  return { status: result.status, prompt, outputThreadId }
}

async function threadMessages(threadId: string) {
  return withSystemDb("report-read-thread", (db) =>
    db
      .select({
        content: messages.content,
        authorType: messages.authorType,
        authorAgentId: messages.authorAgentId,
        requiredScopes: messages.requiredScopes,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.orgId, orgId)))
      .orderBy(asc(messages.createdAt)),
  )
}

/** What the run posted in a conversation besides its "is running" line. */
async function postsIn(threadId: string) {
  return (await threadMessages(threadId)).filter(
    (m) => (m.metadata as { type?: string } | null)?.type !== "routine-run",
  )
}

/** The status of the run's "is running" line(s) in a conversation. */
async function runLines(threadId: string) {
  return (await threadMessages(threadId)).flatMap((m) => {
    const run = (m.metadata as { routineRun?: { status: string } } | null)?.routineRun
    return run ? [run.status] : []
  })
}

/** The run-now "finished running" item naming this routine, if one was filed. */
async function finishedNotification(routineName: string) {
  const rows = await withSystemDb("report-audit-read", (db) =>
    db
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "agent_notification.create"))),
  )
  return rows.find((r) => {
    const summary = (r.changes as { summary?: string } | null)?.summary
    return summary === `Routine "${routineName}" finished running`
  })
}

beforeAll(async () => {
  await acquireTestLock()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
    addThreadMember: () => {},
    removeThreadMember: () => {},
    closeConnectionsForUser: () => {},
  } as never)
  // The attention rows a report files (thread_reply), as the server boots it.
  registerTranslatorConsumer()
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  ownerAgentId = await withPrivilegedDb(orgId, "report-seed-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId }),
  )
})

afterAll(async () => {
  await clearRedisPatterns(["routine-lock:*"])
  resetEventBus()
  await releaseTestLock()
})

describe("a routine reports its result to the conversation it was asked in", () => {
  it("posts the tick's final reply there, as the routine, stamped with the tick's scopes", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)

    const run = await tick(routine.id, {
      replies: [
        { content: "Looking at the numbers first.", scopes: ["shopify:orders:read"] },
        { content: "Here is your one-minute message.", scopes: ["kernel:threads:read"] },
      ],
    })
    expect(run.status).toBe("succeeded")
    // The tick is told its last message is what the person receives.
    expect(run.prompt).toContain(routineReportSentence())

    const posted = await postsIn(conversation)
    expect(posted).toHaveLength(1)
    expect(await runLines(conversation)).toEqual(["succeeded"])
    const report = posted[0]!
    expect(report.content).toBe("Here is your one-minute message.")
    expect(report.authorType).toBe("agent")
    expect(report.authorAgentId).toBe(ownerAgentId)
    // Readers who could not read the run cannot read its summary either.
    expect(report.requiredScopes).toEqual(["kernel:threads:read", "shopify:orders:read"])
    const meta = report.metadata as {
      agentAuthorLabel?: string
      routineReport?: RoutineReportMetadata
    }
    expect(meta.agentAuthorLabel).toBe(`Routine ${routine.name}`)
    expect(meta.routineReport).toEqual({
      routineId: routine.id,
      routineName: routine.name,
      outputThreadId: run.outputThreadId,
      ownerUserId: userId,
    })
    // The output thread still holds the full run.
    expect((await threadMessages(run.outputThreadId)).map((m) => m.content)).toContain(
      "Here is your one-minute message.",
    )
  })

  it("a run-now whose requester got the report files no extra 'finished running' item", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const run = await tick(routine.id, {
      replies: [{ content: "Done: three new orders.", scopes: [] }],
      requestedByUserId: userId,
    })
    expect(run.status).toBe("succeeded")
    await drainOutbox()
    expect(await postsIn(conversation)).toHaveLength(1)
    expect(await finishedNotification(routine.name)).toBeUndefined()
  })

  it("a run-now requester who cannot read the report still gets the 'finished running' item", async () => {
    // Seated in the report conversation, but without the report's scope: RLS
    // hides the row from them, so the report did not reach them.
    const member = (await minimal.person(orgId)).id
    const conversation = await minimal.thread(orgId, userId)
    await withPrivilegedDb(orgId, "report-seat-member", (tx) =>
      tx.insert(threadParticipants).values({ threadId: conversation, userId: member, orgId }),
    )
    const routine = await makeRoutine(conversation)
    const run = await tick(routine.id, {
      replies: [{ content: "Margins by dealer attached.", scopes: ["report-test:secret:read"] }],
      requestedByUserId: member,
    })
    expect(run.status).toBe("succeeded")
    await drainOutbox()
    expect(await postsIn(conversation)).toHaveLength(1)
    expect(await finishedNotification(routine.name)).toBeDefined()
  })

  it("a failed tick reports nothing to the conversation", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const run = await tick(routine.id, {
      replies: [{ content: "I could not reach the store.", scopes: [] }],
      failure: "a tool it called was unavailable",
    })
    expect(run.status).toBe("failed")
    expect(await postsIn(conversation)).toHaveLength(0)
    // Its "is running" line says it failed, never stays running.
    expect(await runLines(conversation)).toEqual(["failed"])
  })

  it("a tick that wrote no text posts nothing, and the run-now item still tells the requester", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const run = await tick(routine.id, { replies: [], requestedByUserId: userId })
    expect(run.status).toBe("succeeded")
    await drainOutbox()
    expect(await postsIn(conversation)).toHaveLength(0)
    expect(await finishedNotification(routine.name)).toBeDefined()
  })

  it("a routine with no report conversation keeps today's behaviour", async () => {
    const routine = await makeRoutine(null)
    const run = await tick(routine.id, { replies: [{ content: "Hi.", scopes: [] }] })
    expect(run.status).toBe("succeeded")
    expect(run.prompt).not.toContain(routineReportSentence())
  })
})

/** The owner's direct messages with their personal agent. */
async function ownerAgentDm(): Promise<string> {
  const dm = await withPrivilegedDb(orgId, "report-owner-dm", (tx) =>
    createOrGetAgentDm(tx as never, { orgId, userId, agentId: ownerAgentId }),
  )
  return dm!.id
}

/** The unread attention rows `who` holds on `threadId` (a kernel message's row targets its thread). */
async function unreadAttention(who: string, threadId: string) {
  return withSystemDb("report-attention-read", (db) =>
    db
      .select({ kind: attentionEvents.kind, readAt: attentionEvents.readAt })
      .from(attentionEvents)
      .where(
        and(
          eq(attentionEvents.orgId, orgId),
          eq(attentionEvents.userId, who),
          eq(attentionEvents.entityId, threadId),
        ),
      ),
  )
}

// Demo walk 2026-10-27: a routine's summary landed in its owner's direct
// messages with their agent and lit nothing: no unread mark, no notification.
// Nobody in that conversation asked for the post, so it is news to its owner.
describe("a routine's post in its owner's DM with their agent is unread news to them", () => {
  it("counts as unread and files the owner's attention row", async () => {
    const dm = await ownerAgentDm()
    const routine = await makeRoutine(dm)
    const run = await tick(routine.id, {
      replies: [{ content: "Brief: Northwind wants 40 units.", scopes: [] }],
    })
    expect(run.status).toBe("succeeded")
    await drainOutbox()
    const unread = await withPrivilegedDb(orgId, "report-unread", (tx) =>
      countThreadUnread(tx as never, { userId, threadId: dm }),
    )
    expect(unread).toBeGreaterThan(0)
    const rows = await unreadAttention(userId, dm)
    expect(rows.filter((r) => r.kind === "thread_reply" && r.readAt === null)).toHaveLength(1)
  })
})

describe("which conversation a routine may report to", () => {
  it("a conversation the owner sits in", async () => {
    const conversation = await minimal.thread(orgId, userId)
    expect(await resolveReportThreadId(orgId, conversation, userId)).toBe(conversation)
  })

  it("not a conversation the owner is not in", async () => {
    const other = (await minimal.person(orgId)).id
    const conversation = await minimal.thread(orgId, other)
    expect(await resolveReportThreadId(orgId, conversation, userId)).toBeNull()
  })

  it("not a routine's own output thread", async () => {
    const conversation = await minimal.thread(orgId, userId)
    await withPrivilegedDb(orgId, "report-mark-routine-thread", (tx) =>
      tx.update(threads).set({ type: "routine" }).where(eq(threads.id, conversation)),
    )
    expect(await resolveReportThreadId(orgId, conversation, userId)).toBeNull()
  })

  it("no conversation at all", async () => {
    expect(await resolveReportThreadId(orgId, undefined, userId)).toBeNull()
  })
})

describe("create_routine records the conversation it was asked in", () => {
  /** The tool context of a turn in `threadId` (the shape the routine tool tests use). */
  function turnCtx(threadId: string | undefined) {
    return {
      orgId,
      userId,
      actorType: "user",
      scopes: ["*"],
      approverUserId: userId,
      agentExecutionThreadId: threadId,
    } as never
  }

  async function storedReportThread(routineId: string): Promise<string | null> {
    const [row] = await withSystemDb("report-read-routine", (db) =>
      db
        .select({ reportThreadId: routinesTbl.reportThreadId })
        .from(routinesTbl)
        .where(eq(routinesTbl.id, routineId)),
    )
    return row?.reportThreadId ?? null
  }

  async function create(threadId: string | undefined): Promise<string> {
    const res = await handleCreateRoutine(
      {
        name: `asked-${crypto.randomUUID().slice(0, 8)}`,
        description: "d",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Send the user a short message.",
        scopes: [],
        // Off: no scheduler is registered, the row is what this test reads.
        enabled: false,
      },
      turnCtx(threadId),
    )
    const routine = (res as { routine?: { id: string } }).routine
    expect(routine).toBeDefined()
    return routine!.id
  }

  it("a routine created in a conversation reports to it, and an edit can stop that", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const id = await create(conversation)
    expect(await storedReportThread(id)).toBe(conversation)

    await handleUpdateRoutine({ id, reportThreadId: null }, turnCtx(conversation))
    expect(await storedReportThread(id)).toBeNull()
  })

  it("a routine created outside a conversation posts in its owner's DM with their agent", async () => {
    const id = await create(undefined)
    expect(await storedReportThread(id)).toBe(await ownerAgentDm())
  })

  it("a create can name where it posts, by a channel's handle, or nowhere but its own thread", async () => {
    const channel = await minimal.thread(orgId, userId)
    const [row] = await withSystemDb("report-channel-handle", (db) =>
      db.select({ handle: threads.handle }).from(threads).where(eq(threads.id, channel)),
    )
    const named = await handleCreateRoutine(
      {
        name: `named-${crypto.randomUUID().slice(0, 8)}`,
        description: "d",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Post the numbers.",
        scopes: [],
        enabled: false,
        reportThreadId: `#${row!.handle}`,
      },
      turnCtx(undefined),
    )
    expect((named as { routine?: { reportThreadId: string } }).routine?.reportThreadId).toBe(
      channel,
    )
    const none = await handleCreateRoutine(
      {
        name: `none-${crypto.randomUUID().slice(0, 8)}`,
        description: "d",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Post the numbers.",
        scopes: [],
        enabled: false,
        reportThreadId: null,
      },
      turnCtx(undefined),
    )
    expect(
      (none as { routine?: { reportThreadId: string | null } }).routine?.reportThreadId,
    ).toBeNull()
  })

  it("an edit cannot point the reports at a conversation the owner is not in", async () => {
    const id = await create(undefined)
    const other = (await minimal.person(orgId)).id
    const elsewhere = await minimal.thread(orgId, other)
    const before = await storedReportThread(id)
    const res = await handleUpdateRoutine({ id, reportThreadId: elsewhere }, turnCtx(undefined))
    expect((res as { error?: { code: string } }).error?.code).toBe("invalid_report_thread")
    expect(await storedReportThread(id)).toBe(before)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A ROUTINE'S RUN SHOWS WHERE THE ROUTINE POSTS (routine-report.ts).
//
// Demo walk 2026-10-27: a routine run by the visitor's personal agent asked to
// read a website, and the approval card showed only in Home, never in the
// visitor's conversation with that agent, where the routine's summary landed.
// A routine posts its whole run to its conversation (its owner's DM with their
// personal agent, or a channel like #marketing): the "is running" line, each
// approval it asks for as the live card, then its summary. These tests raise
// real approval requests inside a routine tick's run frame and read the
// conversation back.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, asc, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import {
  approvalRequests,
  messages,
  routineRuns,
  routines as routinesTbl,
  threadParticipants,
  threads,
} from "~/db/schema/kernel"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import {
  applyDefaultReportThread,
  postRunStarted,
  type RoutineApprovalMetadata,
  type RoutineRunLineMetadata,
  STALE_RUN_LINE_MS,
  settleRunLineOfRun,
  settleRunStarted,
  settleStaleRunLines,
} from "~/modules/agent/routines/routine-report"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleCreateRoutine } from "~/modules/agent/tools/skills-routines-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { listApprovals } from "~/modules/approvals/list"
import { createApprovalRequestInBundle } from "~/modules/apps/execute-tool"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createOrGetAgentDm } from "~/modules/threads/thread"
import { countThreadUnread } from "~/modules/threads/thread-state"
import * as minimal from "~/seed/tiers/minimal"
import { isMessageVisible } from "~/services/security/visibility"
import { createTestOrg } from "~/tests/helpers/org"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let ownerId: string
let ownerAgentId: string

type RoutineRow = typeof routinesTbl.$inferSelect

async function makeRoutine(reportThreadId: string | null, scopes: string[] = []) {
  return withPrivilegedDb(orgId, "dest-seed-routine", async (tx) => {
    const [row] = await tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: ownerId,
        ownerAgentId,
        name: `dest-${crypto.randomUUID().slice(0, 8)}`,
        description: "Destination test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Look something up.",
        scopes,
        reportThreadId,
        createdByUserId: ownerId,
        createdByActorType: "user",
      })
      .returning()
    return row!
  })
}

/** A routine's output thread, as ensureOutputThread makes one. */
async function outputThread(): Promise<string> {
  const id = await minimal.thread(orgId, ownerId)
  await withPrivilegedDb(orgId, "dest-mark-routine-thread", (tx) =>
    tx.update(threads).set({ type: "routine" }).where(eq(threads.id, id)),
  )
  return id
}

/** A gated call the routine's tick raises, inside its run frame (as a tick does). */
async function raiseInTick(
  routine: RoutineRow,
  output: string,
  taintScopes: string[] = [],
): Promise<string> {
  const runId = crypto.randomUUID()
  return runContextStore.run(
    {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      background: true,
      routineId: routine.id,
      // What the tick's turn has read so far (the proposing turn's scopes).
      ...(taintScopes.length > 0 ? { effectiveScope: taintScopes } : {}),
    },
    () =>
      createApprovalRequestInBundle({
        orgId,
        threadId: output,
        toolName: "kernel:web_fetch",
        toolParams: { url: "https://example.com/" },
        requestedBy: ownerId,
        summary: { kind: "web_fetch", title: "Read example.com", lines: ["https://example.com/"] },
        appName: "kernel",
        toolShortName: "web_fetch",
        requesterCanApprove: true,
        stepBundleId: null,
      }),
  )
}

async function rowsIn(threadId: string) {
  return withSystemDb("dest-read-thread", (db) =>
    db
      .select({
        id: messages.id,
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

const approvalRowsIn = async (threadId: string) =>
  (await rowsIn(threadId)).filter(
    (m) => (m.metadata as { routineApproval?: unknown } | null)?.routineApproval,
  )

async function ownerDm(): Promise<string> {
  const dm = await withPrivilegedDb(orgId, "dest-owner-dm", (tx) =>
    createOrGetAgentDm(tx as never, { orgId, userId: ownerId, agentId: ownerAgentId }),
  )
  return dm!.id
}

async function actorFor(userId: string) {
  const perms = await withPrivilegedDb(orgId, "dest-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
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
  orgId = (await createTestOrg()).id
  ownerId = (await minimal.person(orgId, { role: "admin" })).id
  ownerAgentId = await withPrivilegedDb(orgId, "dest-seed-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId: ownerId }),
  )
})

afterAll(async () => {
  await drainOutbox().catch(() => {})
  resetEventBus()
  await releaseTestLock()
})

describe("an approval a routine asks for shows where the routine posts", () => {
  it("in its owner's DM with their personal agent, as the routine, pointing at the one request", async () => {
    const dm = await ownerDm()
    const output = await outputThread()
    const routine = await makeRoutine(dm)
    const requestId = await raiseInTick(routine, output)

    const rows = await approvalRowsIn(dm)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.authorType).toBe("agent")
    expect(row.authorAgentId).toBe(ownerAgentId)
    const meta = row.metadata as {
      routineApproval: RoutineApprovalMetadata
      agentAuthorLabel?: string
    }
    expect(meta.agentAuthorLabel).toBe(`Routine ${routine.name}`)
    expect(meta.routineApproval).toMatchObject({
      requestId,
      toolName: "kernel:web_fetch",
      routineId: routine.id,
      outputThreadId: output,
    })
    expect(meta.routineApproval.handle).not.toBe("")

    // One request, not a copy: it stays in Home's feed and in the run's thread.
    const requests = await withSystemDb("dest-requests", (db) =>
      db
        .select({ id: approvalRequests.id, threadId: approvalRequests.threadId })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.orgId, orgId), eq(approvalRequests.id, requestId))),
    )
    expect(requests).toEqual([{ id: requestId, threadId: output }])
    const home = await withRlsContext(await actorFor(ownerId), (tx) =>
      listApprovals(tx, { orgId, userId: ownerId, scopes: ["*"] }),
    )
    expect(home.map((a) => a.id)).toContain(requestId)
  })

  it("in a channel the routine posts to, like #marketing", async () => {
    const channel = await minimal.thread(orgId, ownerId)
    const output = await outputThread()
    const routine = await makeRoutine(channel)
    const requestId = await raiseInTick(routine, output)
    const rows = await approvalRowsIn(channel)
    expect(rows).toHaveLength(1)
    expect(
      (rows[0]!.metadata as { routineApproval: RoutineApprovalMetadata }).routineApproval.requestId,
    ).toBe(requestId)
  })

  it("deciding it anywhere decides the one request the conversation's card points at", async () => {
    const dm = await ownerDm()
    const output = await outputThread()
    const routine = await makeRoutine(dm)
    const requestId = await raiseInTick(routine, output)
    // Decided the way Home's card decides it.
    await decideApproval({
      orgId,
      actor: await actorFor(ownerId),
      requestId,
      decision: "deny",
      reason: "not now",
    } as never)
    const [decided] = await withSystemDb("dest-decided", (db) =>
      db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, requestId)),
    )
    expect(decided?.status).toBe("denied")
    const rows = await approvalRowsIn(dm)
    const pointed = rows.map(
      (r) => (r.metadata as { routineApproval: RoutineApprovalMetadata }).routineApproval.requestId,
    )
    expect(pointed).toContain(requestId)
    // Still one request.
    const count = await withSystemDb("dest-count", (db) =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.orgId, orgId), eq(approvalRequests.threadId, output))),
    )
    expect(count).toHaveLength(1)
  })

  it("a channel member who could not read the run cannot read the approval row", async () => {
    const member = (await minimal.person(orgId)).id
    const channel = await minimal.thread(orgId, ownerId)
    await withPrivilegedDb(orgId, "dest-seat-member", (tx) =>
      tx.insert(threadParticipants).values({ threadId: channel, userId: member, orgId }),
    )
    const output = await outputThread()
    const routine = await makeRoutine(channel)
    // A run that could read everything its owner (an admin) can.
    await raiseInTick(routine, output, ["*"])
    const [row] = await approvalRowsIn(channel)
    expect(row).toBeDefined()
    expect(row!.requiredScopes.length).toBeGreaterThan(0)
    const memberPerms = await withPrivilegedDb(orgId, "dest-member-perms", (tx) =>
      loadEffectivePermissions(tx, member, orgId),
    )
    expect(
      isMessageVisible(
        { requiredScopes: row!.requiredScopes, disclosureList: null },
        { userId: member, grants: memberPerms.scopes },
      ),
    ).toBe(false)
  })

  it("a routine that posts only in its own thread adds nothing anywhere else", async () => {
    const output = await outputThread()
    const routine = await makeRoutine(null)
    await raiseInTick(routine, output)
    expect(await approvalRowsIn(output)).toHaveLength(0)
  })
})

describe("the 'is running' line", () => {
  async function lineStatus(id: string) {
    const [row] = await withSystemDb("dest-line", (db) =>
      db.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, id)),
    )
    return (row?.metadata as { routineRun?: RoutineRunLineMetadata } | null)?.routineRun?.status
  }

  it("settles once, to what the tick ended with, whatever retries follow", async () => {
    const dm = await ownerDm()
    const output = await outputThread()
    const routine = await makeRoutine(dm)
    const line = await postRunStarted({
      orgId,
      routine,
      outputThreadId: output,
      runKey: "tick-1",
      ownerScopes: ["*"],
    })
    expect(line).not.toBeNull()
    expect(await lineStatus(line!)).toBe("running")
    await settleRunStarted(orgId, line, "succeeded")
    await settleRunStarted(orgId, line, "failed")
    expect(await lineStatus(line!)).toBe("succeeded")
  })

  it("a tick that died leaves no line running: the next tick and the sweep settle it failed", async () => {
    const dm = await ownerDm()
    const output = await outputThread()
    const routine = await makeRoutine(dm)
    const first = await postRunStarted({
      orgId,
      routine,
      outputThreadId: output,
      runKey: "dead-tick",
      ownerScopes: ["*"],
    })
    const second = await postRunStarted({
      orgId,
      routine,
      outputThreadId: output,
      runKey: "next-tick",
      ownerScopes: ["*"],
    })
    expect(await lineStatus(first!)).toBe("failed")
    expect(await lineStatus(second!)).toBe("running")
    // The sweep, once the line is older than a tick can live.
    await settleStaleRunLines(new Date(Date.now() + STALE_RUN_LINE_MS + 60_000))
    expect(await lineStatus(second!)).toBe("failed")
  })
})

describe("the 'is running' line is calm", () => {
  // A status line, never news: a channel member reading the channel sees it,
  // but it raises nobody's unread count (the owner's or anyone else's).
  it("raises no member's unread count, while a real message still does", async () => {
    const member = (await minimal.person(orgId)).id
    const channel = await minimal.thread(orgId, ownerId)
    await withPrivilegedDb(orgId, "dest-seat-calm", (tx) =>
      tx.insert(threadParticipants).values({ threadId: channel, userId: member, orgId }),
    )
    const output = await outputThread()
    const routine = await makeRoutine(channel)
    const unread = (who: string) =>
      withPrivilegedDb(orgId, "dest-calm-unread", (tx) =>
        countThreadUnread(tx as never, { userId: who, threadId: channel }),
      )
    const line = await postRunStarted({
      orgId,
      routine,
      outputThreadId: output,
      runKey: "calm",
      ownerScopes: ["*"],
    })
    expect(line).not.toBeNull()
    expect(await unread(member)).toBe(0)
    expect(await unread(ownerId)).toBe(0)
    await settleRunStarted(orgId, line, "succeeded")
    expect(await unread(member)).toBe(0)
    // The approval the run asks for is news.
    await raiseInTick(routine, output)
    expect(await unread(member)).toBe(1)
  })
})

describe("a run on a person's computer (a node run)", () => {
  it("keeps its line running while the node works, and its job's settle ends it", async () => {
    const dm = await ownerDm()
    const output = await outputThread()
    const routine = await makeRoutine(dm)
    const [run] = await withPrivilegedDb(orgId, "dest-node-run", (tx) =>
      tx
        .insert(routineRuns)
        .values({ orgId, routineId: routine.id, status: "dispatched" })
        .returning({ id: routineRuns.id }),
    )
    const line = await postRunStarted({
      orgId,
      routine,
      outputThreadId: output,
      runKey: run!.id,
      ownerScopes: ["*"],
    })
    const status = async () => {
      const [row] = await withSystemDb("dest-node-line", (db) =>
        db.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, line!)),
      )
      return (row?.metadata as { routineRun?: RoutineRunLineMetadata } | null)?.routineRun?.status
    }
    // Long past a cloud tick's life, the node still works: the sweep leaves it.
    await settleStaleRunLines(new Date(Date.now() + STALE_RUN_LINE_MS + 60_000))
    expect(await status()).toBe("running")
    // The node job settles the run (nodes/jobs.ts), and its line with it.
    await withPrivilegedDb(orgId, "dest-node-settle", (tx) =>
      tx.update(routineRuns).set({ status: "succeeded" }).where(eq(routineRuns.id, run!.id)),
    )
    await settleRunLineOfRun(orgId, routine.id, run!.id, "succeeded")
    expect(await status()).toBe("succeeded")
  })
})

describe("where a routine posts when nobody said", () => {
  it("a personal-agent routine created outside a conversation posts in its owner's DM with it", async () => {
    const res = await handleCreateRoutine(
      {
        name: `default-${crypto.randomUUID().slice(0, 8)}`,
        description: "d",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Say hello.",
        scopes: [],
        enabled: false,
      },
      {
        orgId,
        userId: ownerId,
        actorType: "user",
        scopes: ["*"],
        approverUserId: ownerId,
      } as never,
    )
    const routine = (res as { routine?: RoutineRow }).routine
    expect(routine?.reportThreadId).toBe(await ownerDm())
  })

  it("a role agent's routine keeps its own thread only", async () => {
    const roleAgentId = await withPrivilegedDb(orgId, "dest-role-agent", async (tx) => {
      const { agents } = await import("~/db/schema/kernel")
      const [a] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "role",
          handle: `role-${crypto.randomUUID().slice(0, 6)}`,
          displayName: "Marketing",
          createdBy: ownerId,
        } as never)
        .returning({ id: agents.id })
      return a!.id
    })
    const seeded = await makeRoutine(null)
    const routine = await withPrivilegedDb(orgId, "dest-role-routine", async (tx) => {
      const [row] = await tx
        .update(routinesTbl)
        .set({ ownerAgentId: roleAgentId })
        .where(eq(routinesTbl.id, seeded.id))
        .returning()
      return row!
    })
    expect(await applyDefaultReportThread(orgId, routine)).toBeNull()
  })
})

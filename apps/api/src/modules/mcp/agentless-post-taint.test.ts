// SPDX-License-Identifier: FSL-1.1-ALv2
//
// scope-taint.ts, rule 14 (2026-11-12): a post made over the MCP gateway by a connection bound to
// no agent (a person's own external client) is judged like any other agent post. Its stamp is
// what the connection read through Liaison, never the caller's whole grant; a direct message
// always goes through, visible to its addressee; in a group a post some member could not read
// parks for the requester, whose approval is a standing disclosure for that thread; and the
// handler refuses, never writes, a post that would be hidden. Visibility is asserted through the
// real messages RLS policy, as each reader.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages, threadParticipants } from "~/db/schema/kernel"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { handleThreadsCreate, handleThreadsReply } from "~/modules/agent/tools/chat-tools"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { approvalEditableFieldsRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { connectionTaintWindowId, saveConnectionTurnTaint } from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  grantScope,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as dispatchGuardModule from "~/modules/threads/agent-dispatch-guard"
import { insertThreadWithParticipants } from "~/modules/threads/thread"
import { seedUserRow } from "~/seed/factories/org/rows"
import { grantScopesThroughRole } from "~/seed/factories/people/scoped-role"

const READ = "test:items:read"
const THREADS = ["kernel:threads:read", "kernel:threads:write"]
/** A catalogued read scope nobody here reads through a tool: injected into a window. */
const OTHER_READ = "kernel:audit:read"

interface World {
  orgId: string
  ownerId: string
  ownerScopes: string[]
  /** Holds threads only: lacks what the owner reads. */
  bob: string
  /** Holds threads only. */
  carol: string
  /** Holds threads and READ. */
  holder: string
}

describe("rule 14: posts from a connection bound to no agent", () => {
  const orgs: string[] = []
  const grants = new Map<string, string[]>()

  beforeAll(async () => {
    await initSandboxPool()
    resetEventBus()
    initEventBus()
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as any)
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  async function person(orgId: string, name: string, scopes: string[]): Promise<string> {
    const id = crypto.randomUUID()
    await seedUserRow({
      id,
      orgId,
      email: `${name}-${id.slice(0, 8)}@test.com`,
      passwordHash: "hash",
      name,
      status: "active",
    })
    for (const scope of scopes) await grantScope(orgId, id, scope)
    grants.set(id, scopes)
    return id
  }

  async function world(): Promise<World> {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await registerKernelAgentTools(seed.orgId)
    for (const scope of THREADS) await grantScope(seed.orgId, seed.ownerId, scope)
    const ownerScopes = [...seed.scopes, ...THREADS]
    grants.set(seed.ownerId, ownerScopes)
    return {
      orgId: seed.orgId,
      ownerId: seed.ownerId,
      ownerScopes,
      bob: await person(seed.orgId, "Bob", THREADS),
      carol: await person(seed.orgId, "Carol", THREADS),
      holder: await person(seed.orgId, "Hana", [...THREADS, READ]),
    }
  }

  async function thread(w: World, people: string[], title: string | null = null) {
    const created = await withPrivilegedDb(w.orgId, "test-rule14-thread", (tx) =>
      insertThreadWithParticipants(tx, {
        orgId: w.orgId,
        userId: w.ownerId,
        participantIds: people,
        title,
        isPinned: false,
        createdFrom: null,
      }),
    )
    return created.thread.id as string
  }

  async function join(w: World, threadId: string, userId: string) {
    await withPrivilegedDb(w.orgId, "test-rule14-join", (tx) =>
      tx.insert(threadParticipants).values({ threadId, userId, orgId: w.orgId }),
    )
  }

  /** A fresh agentless connection of `userId` (a new request each call: the transport is stateless). */
  async function connection(w: World, userId = w.ownerId) {
    const conn = await seedMcpConnection({
      orgId: w.orgId,
      userId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    return (): ToolCallCtx => ({
      orgId: w.orgId,
      actor: userContextFor(w.orgId, userId, grants.get(userId) ?? []),
      connectionId: conn.id,
      ownerUserId: userId,
      connectionThreadId: null,
      discovered: new Set(),
    })
  }

  /** The agent-authored posts `userId` can read in `threadId`, through the messages RLS. */
  async function visibleTo(w: World, userId: string, threadId: string): Promise<string[]> {
    const rows = await withRlsContext(
      userContextFor(w.orgId, userId, grants.get(userId) ?? []),
      (tx) =>
        tx
          .select({ content: messages.content, authorType: messages.authorType })
          .from(messages)
          .where(eq(messages.threadId, threadId)),
    )
    return rows.filter((r) => r.authorType === "agent").map((r) => r.content)
  }

  async function rows(threadId: string) {
    const found = await sql<
      {
        content: string
        required_scopes: string[]
        disclosure_list: string[] | null
        metadata: Record<string, unknown> | null
      }[]
    >`SELECT content, required_scopes, disclosure_list::text[] AS disclosure_list, metadata
      FROM kernel.messages WHERE thread_id = ${threadId} AND author_type = 'agent'
      ORDER BY created_at, id`
    return [...found]
  }

  async function approvalCount(orgId: string): Promise<number> {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
    return n
  }

  async function read(ctx: () => ToolCallCtx) {
    const res = await handleToolCall(ctx(), "test__listItems", {})
    expect(res.isError).toBeFalsy()
  }

  async function reply(ctx: () => ToolCallCtx, threadId: string, content: string) {
    return handleToolCall(ctx(), "kernel__threads_reply", { threadId, content })
  }

  function parkedId(res: { structuredContent?: unknown }): string {
    const out = res.structuredContent as {
      gated?: boolean
      executed?: boolean
      approvalRequestId?: string
      postDisclosure?: { relay?: string }
    }
    expect(out.gated).toBe(true)
    expect(out.executed).toBe(false)
    expect(out.postDisclosure?.relay).toContain("NOT sent yet")
    expect(typeof out.approvalRequestId).toBe("string")
    return out.approvalRequestId as string
  }

  async function approve(w: World, requestId: string, by = w.ownerId) {
    const decided = await decideApproval({
      orgId: w.orgId,
      requestId,
      actor: userContextFor(w.orgId, by, grants.get(by) ?? []),
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
  }

  it("with nothing read, a DM to a low-scope teammate posts inline, unstamped, and they read it", async () => {
    const w = await world()
    const dm = await thread(w, [w.ownerId, w.bob])
    const res = await reply(await connection(w), dm, "lunch at noon?")
    expect(res.isError).toBeFalsy()
    const [row] = await rows(dm)
    expect(row?.required_scopes).toEqual([])
    expect(await visibleTo(w, w.bob, dm)).toEqual(["lunch at noon?"])
    expect(await approvalCount(w.orgId)).toBe(0)
  }, 30_000)

  it("after a scoped read, a DM goes through inline for both of them; someone added later does not read it", async () => {
    const w = await world()
    const conn = await connection(w)
    await read(conn)
    const dm = await thread(w, [w.ownerId, w.bob])
    const res = await reply(conn, dm, "the item list says 3 open")
    expect(res.isError).toBeFalsy()
    expect((res.structuredContent as { gated?: boolean }).gated).not.toBe(true)
    const [row] = await rows(dm)
    // Stamped with what this connection read, never with the caller's whole grant.
    expect(row?.required_scopes).toEqual([READ])
    expect([...(row?.disclosure_list ?? [])].sort()).toEqual([w.ownerId, w.bob].sort())
    expect(await visibleTo(w, w.bob, dm)).toEqual(["the item list says 3 open"])
    expect(await approvalCount(w.orgId)).toBe(0)
    await join(w, dm, w.carol)
    expect(await visibleTo(w, w.carol, dm)).toEqual([])
  }, 30_000)

  it("in a group, a post some member cannot read parks; approving writes it for them, and once is enough", async () => {
    const w = await world()
    const conn = await connection(w)
    await read(conn)
    const group = await thread(w, [w.ownerId, w.bob, w.carol])

    const first = await reply(conn, group, "first: 3 open items")
    const id = parkedId(first)
    expect(await rows(group)).toEqual([])
    const [card] = await sql<{ summary: unknown; requested_by: string }[]>`
      SELECT summary, requested_by FROM kernel.approval_requests WHERE id = ${id}`
    expect(card?.requested_by).toBe(w.ownerId)
    expect(JSON.stringify(card?.summary)).toContain(
      "2 people in this conversation cannot see test data this conversation read",
    )
    await approve(w, id)
    expect(await visibleTo(w, w.bob, group)).toEqual(["first: 3 open items"])
    expect(await visibleTo(w, w.carol, group)).toEqual(["first: 3 open items"])

    // The same requester, the same kind of data, the same thread: inline, visible, no new card.
    const before = await approvalCount(w.orgId)
    const second = await reply(conn, group, "second: still 3")
    expect((second.structuredContent as { gated?: boolean }).gated).not.toBe(true)
    expect(await approvalCount(w.orgId)).toBe(before)
    expect(await visibleTo(w, w.bob, group)).toEqual(["first: 3 open items", "second: still 3"])

    // A scope the approval did not cover: asks again.
    await saveConnectionTurnTaint(
      w.orgId,
      connectionTaintWindowId({ connectionId: conn().connectionId }),
      [READ, OTHER_READ],
    )
    grants.set(w.ownerId, [...w.ownerScopes, OTHER_READ])
    await grantScope(w.orgId, w.ownerId, OTHER_READ)
    parkedId(await reply(conn, group, "third: with the audit trail"))
  }, 60_000)

  it("the standing grant is per person: A approved for X and B for Y never sends A+B to Y", async () => {
    const w = await world()
    await grantScope(w.orgId, w.ownerId, OTHER_READ)
    grants.set(w.ownerId, [...w.ownerScopes, OTHER_READ])
    const conn = await connection(w)
    const windowId = connectionTaintWindowId({ connectionId: conn().connectionId })
    const taint = (scopes: string[]) => saveConnectionTurnTaint(w.orgId, windowId, scopes)
    const group = await thread(w, [w.ownerId, w.bob, w.holder])

    // A, approved while X (bob) is in the room and Y (carol) is not.
    await taint([READ])
    await approve(w, parkedId(await reply(conn, group, "A for X")))
    // B, approved while Y is in the room and X is not.
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${group} AND user_id = ${w.bob}`
    await join(w, group, w.carol)
    await taint([OTHER_READ])
    await approve(w, parkedId(await reply(conn, group, "B for Y")))
    await join(w, group, w.bob)

    // A+B: neither X nor Y was granted both, so it asks.
    await taint([READ, OTHER_READ])
    parkedId(await reply(conn, group, "A and B"))
    expect(await visibleTo(w, w.carol, group)).toEqual(["B for Y"])
    // A alone is covered for X, but Y was never granted A: still asks.
    await taint([READ])
    parkedId(await reply(conn, group, "A again"))
  }, 60_000)

  it("a newcomer lacking the taint makes the next post ask again", async () => {
    const w = await world()
    const conn = await connection(w)
    await read(conn)
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    await approve(w, parkedId(await reply(conn, group, "approved once")))
    const dave = await person(w.orgId, "Dave", THREADS)
    await join(w, group, dave)
    parkedId(await reply(conn, group, "after dave joined"))
    // Dave never reads the post approved before he joined.
    expect(await visibleTo(w, dave, group)).toEqual([])
  }, 60_000)

  it("another requester in the same thread does not inherit the approval", async () => {
    const w = await world()
    const group = await thread(w, [w.ownerId, w.bob, w.holder])
    const ownerConn = await connection(w)
    await read(ownerConn)
    await approve(w, parkedId(await reply(ownerConn, group, "owner, approved")))
    const hanaConn = await connection(w, w.holder)
    await read(hanaConn)
    parkedId(await reply(hanaConn, group, "hana, not covered by the owner's approval"))
  }, 60_000)

  it("in a group whose every member holds what was read, the post runs inline", async () => {
    const w = await world()
    const conn = await connection(w)
    await read(conn)
    const group = await thread(w, [
      w.ownerId,
      w.holder,
      await person(w.orgId, "Ivo", [...THREADS, READ]),
    ])
    const res = await reply(conn, group, "everyone may read this")
    expect((res.structuredContent as { gated?: boolean }).gated).not.toBe(true)
    expect(await visibleTo(w, w.holder, group)).toEqual(["everyone may read this"])
    expect(await approvalCount(w.orgId)).toBe(0)
  }, 30_000)

  it("two connections of one person keep separate windows: a read on A does not stamp B's post", async () => {
    const w = await world()
    const a = await connection(w)
    const b = await connection(w)
    await read(a)
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    const res = await reply(b, group, "from B, which read nothing")
    expect((res.structuredContent as { gated?: boolean }).gated).not.toBe(true)
    const [row] = await rows(group)
    expect(row?.required_scopes).toEqual([])
    expect(await visibleTo(w, w.bob, group)).toEqual(["from B, which read nothing"])
  }, 30_000)

  it("the handler refuses, and writes nothing, a post that would be hidden", async () => {
    const w = await world()
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    // A direct handler call with no frame: the stamp falls back to the caller's grant.
    const res = await withRlsContext(userContextFor(w.orgId, w.ownerId, w.ownerScopes), (db) =>
      handleThreadsReply(
        { threadId: group, content: "would be hidden" },
        { userId: w.ownerId, orgId: w.orgId, db, scopes: w.ownerScopes, actorType: "mcp" },
      ),
    )
    expect((res as { error?: { code?: string } }).error?.code).toBe("post_would_be_hidden")
    expect(JSON.stringify(res)).not.toContain("new conversation")
    expect(await rows(group)).toEqual([])

    const created = await withRlsContext(userContextFor(w.orgId, w.ownerId, w.ownerScopes), (db) =>
      handleThreadsCreate(
        { participantIds: [w.bob, w.carol], initialMessage: "would be hidden too" },
        { userId: w.ownerId, orgId: w.orgId, db, scopes: w.ownerScopes, actorType: "mcp" },
      ),
    )
    expect((created as { error?: { code?: string } }).error?.code).toBe("post_would_be_hidden")
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
      WHERE org_id = ${w.orgId} AND content = 'would be hidden too'`
    expect(n).toBe(0)
  }, 30_000)

  // Review fixes (rule 14a, 14e).
  it("a post carrying a scope the requester does not hold is refused even in a DM, and nothing is written", async () => {
    const w = await world()
    const conn = await connection(w)
    // The window read more than the owner holds (as a routine or agent turn can).
    await saveConnectionTurnTaint(
      w.orgId,
      connectionTaintWindowId({ connectionId: conn().connectionId }),
      [OTHER_READ],
    )
    const dm = await thread(w, [w.ownerId, w.bob])
    const res = await reply(conn, dm, "audit figures")
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).toContain("you do not hold all of those scopes yourself")
    expect(await rows(dm)).toEqual([])
    expect(await approvalCount(w.orgId)).toBe(0)

    // The handler refuses the same post on its own (direct call, stamp from the caller).
    const scopes = [...w.ownerScopes, OTHER_READ]
    const direct = await withRlsContext(userContextFor(w.orgId, w.ownerId, scopes), (db) =>
      handleThreadsReply(
        { threadId: dm, content: "audit figures, direct" },
        { userId: w.ownerId, orgId: w.orgId, db, scopes, actorType: "mcp" },
      ),
    )
    expect((direct as { error?: { code?: string } }).error?.code).toBe("post_would_be_hidden")
    expect(await rows(dm)).toEqual([])
  }, 30_000)

  it("someone who joined between the park and the approval stops the approved post; sending again asks again", async () => {
    const w = await world()
    const conn = await connection(w)
    await read(conn)
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    const id = parkedId(await reply(conn, group, "parked before dave joined"))
    const dave = await person(w.orgId, "Dave", THREADS)
    await join(w, group, dave)
    await decideApproval({
      orgId: w.orgId,
      requestId: id,
      actor: userContextFor(w.orgId, w.ownerId, w.ownerScopes),
      decision: "approve",
    }).catch(() => null)
    // Not written: Dave was not part of the decision and would not see it.
    expect(await rows(group)).toEqual([])
    parkedId(await reply(conn, group, "parked before dave joined"))
  }, 60_000)

  it("a reply-thread post approved for a member who reads the root by scope is not hidden from them", async () => {
    const w = await world()
    const group = await thread(w, [w.ownerId, w.bob, w.holder])
    const asOwner = userContextFor(w.orgId, w.ownerId, w.ownerScopes)
    const { sendMessage } = await import("~/modules/threads/message")
    const root = await withRlsContext(asOwner, (db) =>
      sendMessage(db, {
        orgId: w.orgId,
        userId: w.ownerId,
        threadId: group,
        content: "root",
        authorType: "agent",
        requiredScopes: [READ],
        disclosureList: [w.ownerId, w.bob],
      }),
    )
    // The reply carries more than the root; the holder reads the root by scope, not its list.
    await withRlsContext(asOwner, (db) =>
      sendMessage(db, {
        orgId: w.orgId,
        userId: w.ownerId,
        threadId: group,
        content: "reply",
        authorType: "agent",
        requiredScopes: [OTHER_READ],
        disclosureList: [w.ownerId, w.bob, w.holder],
        replyRootId: root?.id as string,
      }),
    )
    const seen = await withRlsContext(
      userContextFor(w.orgId, w.holder, grants.get(w.holder) ?? []),
      (tx) =>
        tx.select({ content: messages.content }).from(messages).where(eq(messages.threadId, group)),
    )
    expect(seen.map((r) => r.content).sort()).toEqual(["reply", "root"])
  }, 30_000)

  it("a titled or discoverable conversation of two people is no DM: the post parks", async () => {
    const w = await world()
    const conn = await connection(w)
    await read(conn)
    const titled = await thread(w, [w.ownerId, w.bob], "Project X")
    parkedId(await reply(conn, titled, "to a titled room of two"))
    const open = await thread(w, [w.ownerId, w.bob])
    await sql`UPDATE kernel.threads SET discoverable = true WHERE id = ${open}`
    parkedId(await reply(conn, open, "to a discoverable room of two"))
    expect(await rows(titled)).toEqual([])
    expect(await rows(open)).toEqual([])
  }, 30_000)

  it("a soft-deleted approved post no longer counts as a standing disclosure", async () => {
    const w = await world()
    const conn = await connection(w)
    await read(conn)
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    await approve(w, parkedId(await reply(conn, group, "approved, then deleted")))
    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE thread_id = ${group}`
    parkedId(await reply(conn, group, "asks again"))
  }, 60_000)

  it("the handler's refusal says what happened without promising an approval", async () => {
    const w = await world()
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    const res = await withRlsContext(userContextFor(w.orgId, w.ownerId, w.ownerScopes), (db) =>
      handleThreadsReply(
        { threadId: group, content: "hidden" },
        { userId: w.ownerId, orgId: w.orgId, db, scopes: w.ownerScopes, actorType: "mcp" },
      ),
    )
    const message = (res as { error?: { message?: string } }).error?.message ?? ""
    expect(message).toContain("no approval was created")
    expect(message).not.toContain("normal tool call")
  }, 30_000)

  it("a titled create's title is still judged even for one participant", async () => {
    const w = await world()
    const accumulator = (
      await import("~/modules/agent/scopes/turn-scope-accumulator")
    ).createTurnScopeAccumulator()
    accumulator.recordInjected([READ])
    const { runContextStore } = await import("~/modules/agent/runtime/run-context")
    const runId = crypto.randomUUID()
    const res = await runContextStore.run(
      {
        runId,
        parentRunId: null,
        rootRunId: runId,
        nestingDepth: 0,
        mcpGateway: true,
        effectiveScope: w.ownerScopes,
        turnScopeAccumulator: accumulator,
      },
      () =>
        withRlsContext(userContextFor(w.orgId, w.ownerId, w.ownerScopes), (db) =>
          handleThreadsCreate(
            {
              participantIds: [w.bob],
              title: "Item count 3",
              initialMessage: "see title",
              forceCreate: true,
            },
            { userId: w.ownerId, orgId: w.orgId, db, scopes: w.ownerScopes, actorType: "mcp" },
          ),
        ),
    )
    expect((res as { error?: { code?: string } }).error?.code).toBe("E_SCOPE_TAINT_BLOCKED")
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.threads WHERE org_id = ${w.orgId} AND title = 'Item count 3'`
    expect(n).toBe(0)
  }, 30_000)

  // Follow-ups: the disclosure names only what the lacking readers lack, and an approved
  // external-client post keeps its marker.
  it("the card and relay name only the apps the lacking readers lack, not the whole taint", async () => {
    const w = await world()
    const conn = await connection(w)
    // The window read threads (everyone here holds it) and the test app (bob and carol lack it).
    await saveConnectionTurnTaint(
      w.orgId,
      connectionTaintWindowId({ connectionId: conn().connectionId }),
      ["kernel:threads:read", READ],
    )
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    const res = await reply(conn, group, "3 open items")
    const id = parkedId(res)
    const relay =
      (res.structuredContent as { postDisclosure?: { relay?: string } }).postDisclosure?.relay ?? ""
    expect(relay).toContain("cannot see test data read in this session")
    expect(relay).not.toContain("threads")
    const [card] = await sql<{ summary: unknown; metadata: Record<string, unknown> }[]>`
      SELECT summary, metadata FROM kernel.approval_requests WHERE id = ${id}`
    const text = JSON.stringify(card?.summary)
    expect(text).toContain(
      "2 people in this conversation cannot see test data this conversation read",
    )
    expect(text).not.toContain("test, threads")
    // Wording only: the stored audience still demands the whole taint.
    expect([...((card?.metadata.taintAudienceMustHold as string[]) ?? [])].sort()).toEqual(
      ["kernel:threads:read", READ].sort(),
    )
  }, 60_000)

  it("the handler's refusal names only what the lacking readers lack", async () => {
    const w = await world()
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    const scopes = ["kernel:threads:read", READ]
    const res = await withRlsContext(userContextFor(w.orgId, w.ownerId, w.ownerScopes), (db) =>
      handleThreadsReply(
        { threadId: group, content: "hidden" },
        { userId: w.ownerId, orgId: w.orgId, db, scopes, actorType: "mcp" },
      ),
    )
    const message = (res as { error?: { message?: string } }).error?.message ?? ""
    expect(message).toContain(
      "2 people in this conversation cannot see test data this session read",
    )
  }, 30_000)

  it("an approved post from a person's external client keeps the external-client marker", async () => {
    const w = await world()
    const conn = await connection(w)
    await read(conn)
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    const id = parkedId(await reply(conn, group, "from my client, approved"))
    const [approval] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(approval?.metadata.taintDisclosureExternalClient).toBeDefined()
    await approve(w, id)
    const [row] = await rows(group)
    expect(row?.metadata?.taintDisclosureApprovalId).toBe(id)
    expect(row?.metadata?.externalClientPost).toBe(true)
  }, 60_000)

  it("an in-app agent's approved post does not get the external-client marker", async () => {
    const w = await world()
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    const { executeTool } = await import("~/modules/apps/execute-tool")
    const { runContextStore } = await import("~/modules/agent/runtime/run-context")
    const { createTurnScopeAccumulator } = await import(
      "~/modules/agent/scopes/turn-scope-accumulator"
    )
    const accumulator = createTurnScopeAccumulator()
    accumulator.recordInjected([READ])
    const runId = crypto.randomUUID()
    const res = await runContextStore.run(
      {
        runId,
        parentRunId: null,
        rootRunId: runId,
        nestingDepth: 0,
        humanTurn: true,
        effectiveScope: w.ownerScopes,
        turnScopeAccumulator: accumulator,
      },
      () =>
        executeTool({
          toolName: "kernel:threads_reply",
          orgId: w.orgId,
          actor: userContextFor(w.orgId, w.ownerId, w.ownerScopes),
          params: { threadId: group, content: "from the in-app agent, approved" },
          origin: "in-app-agent",
          stepBundleId: null,
        }),
    )
    const id = "blocked" in res ? (res.blocked?.approvalRequestId ?? "") : ""
    expect(id).not.toBe("")
    const [approval] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(approval?.metadata.taintDisclosureExternalClient).toBeUndefined()
    await approve(w, id)
    const [row] = await rows(group)
    expect(row?.content).toBe("from the in-app agent, approved")
    expect(row?.metadata?.taintDisclosureApprovalId).toBe(id)
    expect(row?.metadata?.externalClientPost).toBeUndefined()
  }, 60_000)

  it("editing a parked post keeps naming only what the lacking readers lack", async () => {
    const w = await world()
    // threads_reply declares no editable field today; the edit path is what is under test.
    approvalEditableFieldsRegistry.set(
      [w.orgId, "kernel", "threads_reply"],
      [{ field: "content", label: "Message", widget: "text" }],
    )
    const conn = await connection(w)
    await saveConnectionTurnTaint(
      w.orgId,
      connectionTaintWindowId({ connectionId: conn().connectionId }),
      ["kernel:threads:read", READ],
    )
    const group = await thread(w, [w.ownerId, w.bob, w.carol])
    const id = parkedId(await reply(conn, group, "3 open items"))
    const edited = await updatePayload({
      orgId: w.orgId,
      requestId: id,
      fields: { content: "3 open items, edited" },
      actor: userContextFor(w.orgId, w.ownerId, w.ownerScopes),
      actingAgentId: null,
    })
    expect(edited.lastEdit).not.toBeNull()
    const [card] = await sql<{ summary: unknown }[]>`
      SELECT summary FROM kernel.approval_requests WHERE id = ${id}`
    const text = JSON.stringify(card?.summary)
    expect(text).toContain(
      "2 people in this conversation cannot see test data this conversation read",
    )
    expect(text).not.toContain("test, threads")
    expect(text).not.toContain("threads, test")
    expect(text).not.toContain("Drafted after reading")
  }, 60_000)

  describe("an approved post that mentions an agent", () => {
    type DispatchArgs = Parameters<typeof dispatchGuardModule.dispatchAgentMention>[1]
    let spy: ReturnType<typeof spyOn> | null = null
    const dispatched: DispatchArgs[] = []

    function watchDispatch() {
      dispatched.length = 0
      spy = spyOn(dispatchGuardModule, "dispatchAgentMention").mockImplementation((async (
        _runRls: unknown,
        args: DispatchArgs,
      ) => {
        dispatched.push(args)
        return { allowed: true }
      }) as never)
    }

    afterEach(() => {
      spy?.mockRestore()
      spy = null
    })

    it("from a person's external client: none on park, exactly one on approval, as the requester with the connection's scopes", async () => {
      const w = await world()
      const agent = await seedAgentForOrg(w.orgId, { scopeCeiling: THREADS })
      // A second decider with a dimension grant the requester lacks: approving delegates their
      // authority to the handler, never to the turn the post wakes.
      const dana = await person(w.orgId, "Dana", [...THREADS, READ])
      await grantScopesThroughRole(w.orgId, {
        adminUserId: w.ownerId,
        userId: dana,
        name: "Dana's desk",
        scopes: [],
        dimensions: { "test:team": ["dana-only-team"] },
      })
      const conn = await connection(w)
      await read(conn)
      const connectionScopes = conn().actor.scopes
      const group = await thread(w, [w.ownerId, w.bob, w.carol, dana])
      watchDispatch()
      const id = parkedId(
        await reply(conn, group, `@[MCP Test Agent](agent:${agent.agentId}) how many are open?`),
      )
      expect(dispatched).toHaveLength(0)
      await approve(w, id, dana)
      expect(dispatched).toHaveLength(1)
      const [call] = dispatched
      expect(call?.calleeAgentId).toBe(agent.agentId)
      expect(call?.threadId).toBe(group)
      expect(call?.callerAgentId).toBeNull()
      expect(call?.actor.userId).toBe(w.ownerId)
      expect([...(call?.actor.scopes ?? [])].sort()).toEqual([...connectionScopes].sort())
      expect([...(call?.callerEffectiveScope ?? [])].sort()).toEqual([...connectionScopes].sort())
      // The requester's own dimension grants, not widened by the decider's.
      const owner = await withPrivilegedDb(w.orgId, "test-rule14-owner-perms", (tx) =>
        loadEffectivePermissions(tx, w.ownerId, w.orgId),
      )
      expect(call?.actor.dimensionGrants ?? {}).toEqual(owner.dimensionGrants)
      expect(JSON.stringify(call?.actor.dimensionGrants ?? {})).not.toContain("dana-only-team")
    }, 60_000)

    it("from an in-app agent: approving wakes no mentioned agent, as before", async () => {
      const w = await world()
      const agent = await seedAgentForOrg(w.orgId, { scopeCeiling: THREADS })
      const group = await thread(w, [w.ownerId, w.bob, w.carol])
      const { executeTool } = await import("~/modules/apps/execute-tool")
      const { runContextStore } = await import("~/modules/agent/runtime/run-context")
      const { createTurnScopeAccumulator } = await import(
        "~/modules/agent/scopes/turn-scope-accumulator"
      )
      const accumulator = createTurnScopeAccumulator()
      accumulator.recordInjected([READ])
      const runId = crypto.randomUUID()
      watchDispatch()
      const res = await runContextStore.run(
        {
          runId,
          parentRunId: null,
          rootRunId: runId,
          nestingDepth: 0,
          humanTurn: true,
          effectiveScope: w.ownerScopes,
          turnScopeAccumulator: accumulator,
        },
        () =>
          executeTool({
            toolName: "kernel:threads_reply",
            orgId: w.orgId,
            actor: userContextFor(w.orgId, w.ownerId, w.ownerScopes),
            params: {
              threadId: group,
              content: `@[MCP Test Agent](agent:${agent.agentId}) from the in-app agent`,
            },
            origin: "in-app-agent",
            stepBundleId: null,
          }),
      )
      const id = "blocked" in res ? (res.blocked?.approvalRequestId ?? "") : ""
      expect(id).not.toBe("")
      await approve(w, id)
      const [row] = await rows(group)
      expect(row?.content).toContain("from the in-app agent")
      expect(dispatched).toHaveLength(0)
    }, 60_000)
  })

  describe("threads_create's first message", () => {
    async function create(ctx: () => ToolCallCtx, participantIds: string[], text: string) {
      return handleToolCall(ctx(), "kernel__threads_create", {
        participantIds,
        initialMessage: text,
      })
    }

    it("a DM after a scoped read posts inline and its addressee reads it", async () => {
      const w = await world()
      const conn = await connection(w)
      await read(conn)
      const res = await create(conn, [w.bob], "dm from a scoped session")
      expect(res.isError).toBeFalsy()
      expect((res.structuredContent as { gated?: boolean }).gated).not.toBe(true)
      const threadId = (res.structuredContent as { thread: { id: string } }).thread.id
      expect(await visibleTo(w, w.bob, threadId)).toEqual(["dm from a scoped session"])
      expect(await approvalCount(w.orgId)).toBe(0)
    }, 30_000)

    it("into an existing group with members lacking the taint, it parks, and approving shows it to them", async () => {
      const w = await world()
      const group = await thread(w, [w.ownerId, w.bob, w.carol])
      const conn = await connection(w)
      await read(conn)
      const id = parkedId(await create(conn, [w.bob, w.carol], "group from a scoped session"))
      expect(await rows(group)).toEqual([])
      await approve(w, id)
      expect(await visibleTo(w, w.bob, group)).toEqual(["group from a scoped session"])
    }, 60_000)

    it("into an existing group whose members hold the taint, it runs inline", async () => {
      const w = await world()
      const ivo = await person(w.orgId, "Ivo", [...THREADS, READ])
      const group = await thread(w, [w.ownerId, w.holder, ivo])
      const conn = await connection(w)
      await read(conn)
      const res = await create(conn, [w.holder, ivo], "group everyone may read")
      expect((res.structuredContent as { gated?: boolean }).gated).not.toBe(true)
      expect(await visibleTo(w, ivo, group)).toEqual(["group everyone may read"])
    }, 30_000)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// scope-taint.ts, rule 14 (2026-11-12): a post made over the MCP gateway by a connection bound to
// no agent (a person's own external client) is judged like any other agent post. Its stamp is
// what the connection read through Liaison, never the caller's whole grant; a direct message
// always goes through, visible to its addressee; in a group a post some member could not read
// parks for the requester, whose approval is a standing disclosure for that thread; and the
// handler refuses, never writes, a post that would be hidden. Visibility is asserted through the
// real messages RLS policy, as each reader.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { handleThreadsCreate, handleThreadsReply } from "~/modules/agent/tools/chat-tools"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { connectionTaintWindowId, saveConnectionTurnTaint } from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  grantScope,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"

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
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${id}, ${orgId}, ${`${name}-${id.slice(0, 8)}@test.com`}, 'hash', ${name}, 'active')`
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
    const id = crypto.randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, title)
      VALUES (${id}, ${w.orgId}, ${`r14-${id.slice(0, 8)}`}, 'thread', ${w.ownerId}, ${title})`
    for (const userId of people) await join(w, id, userId)
    return id
  }

  async function join(w: World, threadId: string, userId: string) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${threadId}, ${userId}, ${w.orgId})`
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
    return sql<
      {
        content: string
        required_scopes: string[]
        disclosure_list: string[] | null
        metadata: Record<string, unknown> | null
      }[]
    >`SELECT content, required_scopes, disclosure_list::text[] AS disclosure_list, metadata
      FROM kernel.messages WHERE thread_id = ${threadId} AND author_type = 'agent'
      ORDER BY created_at, id`
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

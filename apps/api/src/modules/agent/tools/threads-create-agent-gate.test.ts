// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An agent never opens a NEW conversation with people on its own judgement. Asked to message
// two colleagues, an agent got duplicate_thread back, decided its topic was "genuinely
// separate", retried with a title and forceCreate, and opened a group thread nobody asked for.
// threads_create is now gated for an agent's call (`gatedWhen`) whenever it would open a new
// conversation: a title, forceCreate, or a new group of two or more people. The card names it
// and the people; nothing exists until a person approves. An untitled create that lands in the
// existing thread (or opens a 1:1 DM) runs as before, and a person's own call is never gated.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import * as eventBusModule from "~/infra/events/event-bus"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { executeTool, type ToolOrigin } from "~/modules/apps/execute-tool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

type Envelope = Awaited<ReturnType<typeof executeTool>>

describe("threads_create: an agent asks before opening a new conversation", () => {
  let admin: minimal.Session
  let threadId: string
  let alice: string
  let bob: string
  let carol: string
  let dave: string
  const actor = (): UserContext => ({
    actorType: "user",
    userId: admin.userId,
    orgId: admin.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  beforeAll(async () => {
    admin = await minimal.adminSession((await createTestOrg()).id)
    threadId = await minimal.thread(admin.orgId, admin.userId)
    alice = (await minimal.person(admin.orgId, { name: "Alice Gate" })).id
    bob = (await minimal.person(admin.orgId, { name: "Bob Gate" })).id
    carol = (await minimal.person(admin.orgId, { name: "Carol Gate" })).id
    dave = (await minimal.person(admin.orgId, { name: "Dave Gate" })).id
    await registerKernelAgentTools(admin.orgId)
  })

  afterAll(() => {
    broadcastSpy.mockRestore()
  })

  const create = (params: Record<string, unknown>, origin: ToolOrigin = "in-app-agent") =>
    executeTool({
      toolName: "kernel:threads_create",
      orgId: admin.orgId,
      actor: actor(),
      params,
      threadId,
      origin,
      stepBundleId: null,
    })

  const createdThread = (res: Envelope): { id: string } | undefined =>
    "data" in res ? (res.data as { thread?: { id: string } }).thread : undefined

  const threadsTitled = (title: string) =>
    sql<Array<{ id: string }>>`
      SELECT id FROM kernel.threads WHERE org_id = ${admin.orgId} AND title = ${title}`

  const pendingCreates = () =>
    sql<Array<{ id: string }>>`
      SELECT id FROM kernel.approval_requests
      WHERE org_id = ${admin.orgId} AND tool_name = 'kernel:threads_create' AND status = 'pending'`

  it("(a) an agent's untitled create lands in the existing DM or group, ungated", async () => {
    // The people's own conversations, opened by the admin in the UI.
    const dm = createdThread(await create({ participantIds: [alice] }, "human-ui"))
    const group = createdThread(await create({ participantIds: [alice, bob] }, "human-ui"))
    expect(dm?.id).toBeDefined()
    expect(group?.id).toBeDefined()
    const before = (await pendingCreates()).length

    const toDm = await create({ participantIds: [alice], initialMessage: "Quick question" })
    expect("blocked" in toDm).toBe(false)
    expect(createdThread(toDm)?.id).toBe(dm?.id as string)

    for (const origin of ["in-app-agent", "mcp"] as const) {
      const toGroup = await create({ participantIds: [bob, alice], initialMessage: "Hi" }, origin)
      expect("blocked" in toGroup).toBe(false)
      expect(createdThread(toGroup)?.id).toBe(group?.id as string)
    }
    // A 1:1 DM that does not exist yet still opens, as "message this person" always did.
    const fresh = await create({ participantIds: [dave], initialMessage: "Hello" })
    expect("blocked" in fresh).toBe(false)
    expect(createdThread(fresh)?.id).toBeDefined()
    expect((await pendingCreates()).length).toBe(before)
  })

  it("(b) an agent's titled create parks a card naming the conversation and people; nothing exists until approved", async () => {
    const res = await create({
      participantIds: [carol, bob],
      title: "Launch plan",
      initialMessage: "Let's plan the launch",
    })
    expect("blocked" in res).toBe(true)
    if (!("blocked" in res)) return
    const summary = res.blocked.summary as { title?: string } | undefined
    expect(summary?.title).toBe('Create new conversation "Launch plan" with Carol Gate, Bob Gate')
    expect(await threadsTitled("Launch plan")).toHaveLength(0)

    await decideApproval({
      orgId: admin.orgId,
      requestId: res.blocked.approvalRequestId as string,
      actor: actor(),
      decision: "approve",
    })
    expect(await threadsTitled("Launch plan")).toHaveLength(1)
  })

  it("(b) forceCreate and a new group of two or more people park the same way", async () => {
    const before = (await pendingCreates()).length
    const forced = await create({ participantIds: [alice], forceCreate: true, initialMessage: "x" })
    expect("blocked" in forced).toBe(true)
    // Carol and Dave share no conversation with the admin: a new group.
    const group = await create({ participantIds: [carol, dave], initialMessage: "Hi both" }, "mcp")
    expect("blocked" in group).toBe(true)
    expect((await pendingCreates()).length).toBe(before + 2)
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.threads t
      WHERE t.org_id = ${admin.orgId} AND t.title IS NULL
        AND (SELECT count(*) FROM kernel.thread_participants tp
             WHERE tp.thread_id = t.id AND tp.user_id IN (${carol}, ${dave})) = 2`
    expect(row?.n).toBe(0)
  })

  it("(c) a person's own create in the UI is never gated", async () => {
    const res = await create(
      { participantIds: [carol, dave], title: "Person room", forceCreate: true },
      "human-ui",
    )
    expect("blocked" in res).toBe(false)
    expect(await threadsTitled("Person room")).toHaveLength(1)
  })

  it("(d) a titled duplicate is refused without a card, and the refusal never invites forceCreate", async () => {
    const before = (await pendingCreates()).length
    const err = (await create({ participantIds: [alice], title: "Another topic" }).then(
      () => null,
      (e: unknown) => e,
    )) as (Error & { code?: string }) | null
    expect(err?.code).toBe("duplicate_thread")
    expect(err?.message).toContain("ask the user")
    expect(err?.message).toContain("Never retry with forceCreate")
    expect(err?.message).not.toContain("genuinely separate")
    expect((await pendingCreates()).length).toBe(before)
    expect(await threadsTitled("Another topic")).toHaveLength(0)
  })
})

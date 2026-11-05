// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The low-latency ephemeral COPY of an agent reply carries the same visibility
// facts as the row it copies, so it reaches exactly the connections that may
// read that reply.
//
// The reply is persisted through sendMessage, whose create event is tagged, so
// an untagged ephemeral copy leaks nothing: the fan-out simply drops it and the
// reply appears only on the next fetch. That is precisely the latency this
// broadcast exists to remove, which is why the copy has to be tagged rather
// than exempted.
//
// The turn is real: a real tool call accumulates a real scope, the real
// finalize persists and broadcasts, and the payload asserted on is the one
// broadcastEphemeral was actually handed.

import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import * as eventBusModule from "~/infra/events/event-bus"
import { WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { AgentServiceTestAccess, runAgentChat } from "~/modules/agent/runtime/agent-service"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-live-reply-visibility"
const SCOPE = "lrv:deals:read"
const TOOL = "lrv__dealTool"
const REPLY = "Deal 42 closes Monday for 90k"

type WsEvent = Parameters<WebSocketManager["broadcast"]>[0]

interface FakeSocket {
  send: ReturnType<typeof mock>
  readyState: number
}

/** A stream whose model calls the scoped probe tool, then answers. */
function toolCallingStream(toolName: string) {
  return (opts: { tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }> }) => ({
    fullStream: (async function* () {
      const toolDef = opts.tools?.[toolName]
      if (!toolDef?.execute) throw new Error(`${toolName} is not in the turn tool set`)
      yield { type: "tool-call", toolCallId: "call-lrv-0", toolName, input: {} }
      const output = await toolDef.execute({})
      yield { type: "tool-result", toolCallId: "call-lrv-0", toolName, input: {}, output }
      yield { type: "text-delta", text: REPLY }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  })
}

describe("the live copy of an agent reply carries the reply's visibility facts", () => {
  let orgId: string

  async function userWith(scopes: string[]): Promise<string> {
    const user = await minimal.person(orgId)
    await minimal.revokeRole(user.id, "member")
    for (const scope of scopes) await minimal.grantScope(user.id, scope)
    return user.id
  }

  async function actorFor(userId: string): Promise<UserContext> {
    const { scopes } = await withPrivilegedDb(orgId, "test-lrv-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  }

  async function seedThread(createdBy: string, participantIds: string[]): Promise<string> {
    return withPrivilegedDb(orgId, "test-lrv-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `lrv-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy,
        })
        .returning({ id: threads.id })
      for (const userId of participantIds) {
        await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      }
      return t.id
    })
  }

  async function seedPersonalAgent(ownerUserId: string, ceiling: string[]): Promise<string> {
    return withPrivilegedDb(orgId, "test-lrv-agent", async (tx) => {
      const [a] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "personal",
          handle: `@lrv-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Liaison",
          ownerUserId,
          scopeCeiling: ceiling,
        })
        .returning({ id: agents.id })
      return a.id
    })
  }

  async function addParticipant(threadId: string, userId: string): Promise<void> {
    await withPrivilegedDb(orgId, "test-lrv-participant", (tx) =>
      tx.insert(threadParticipants).values({ threadId, userId, orgId }),
    )
  }

  /**
   * One real chat turn that calls the scoped tool, returning the ephemeral
   * `message:create` payload the turn actually broadcast.
   */
  async function turnEphemeralReply(threadId: string, actor: UserContext): Promise<WsEvent> {
    await withPrivilegedDb(orgId, "test-lrv-user-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        orgId,
        userId: actor.userId,
        threadId,
        content: "@Liaison what is the deal status",
        requiredScopes: [],
      }),
    )
    const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral")
    AgentServiceTestAccess.setStreamText(toolCallingStream(TOOL) as never)
    try {
      const result = await runAgentChat({ threadId, content: "status please", actor, orgId })
      for await (const _chunk of result.fullStream) {
        // drain: the stub runs the tool inside the stream
      }
      await result.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "stop",
        text: REPLY,
        steps: [],
      })
      const replies = broadcastSpy.mock.calls
        .map(([e]) => e as WsEvent)
        .filter((e) => e.entity === "message" && e.action === "create")
      if (replies.length !== 1) {
        throw new Error(`expected one ephemeral message:create, saw ${replies.length}`)
      }
      return replies[0]
    } finally {
      broadcastSpy.mockRestore()
      AgentServiceTestAccess.setStreamText()
    }
  }

  /** required_scopes of the agent replies stored in a thread, oldest first. */
  async function persistedReplyScopes(threadId: string): Promise<string[][]> {
    const rows = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`
    return rows.map((r) => r.required_scopes)
  }

  function connect(
    threadId: string,
    holderId: string,
    lackerId: string,
  ): { manager: WebSocketManager; holder: FakeSocket; lacker: FakeSocket } {
    const manager = new WebSocketManager(redis)
    const holder: FakeSocket = { send: mock(() => {}), readyState: 1 }
    const lacker: FakeSocket = { send: mock(() => {}), readyState: 1 }
    manager.addConnection(holderId, holder as never, ["kernel", SCOPE], orgId)
    manager.addConnection(lackerId, lacker as never, ["kernel"], orgId)
    manager.setThreadMembership(holder as never, new Set([threadId]))
    manager.setThreadMembership(lacker as never, new Set([threadId]))
    return { manager, holder, lacker }
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    toolRegistry.set([orgId, "lrv", "dealTool"], {
      appName: "lrv",
      name: "dealTool",
      description: `Live reply probe requiring ${SCOPE}`,
      requiredScopes: [SCOPE],
      handler: async () => ({ ok: true }),
      params: z.object({}),
    })
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Live Reply', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([orgId, "lrv"])
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  test("the ephemeral reply reaches the connection holding the turn's scope and not the one lacking it", async () => {
    const holderId = await userWith([SCOPE])
    const lackerId = await userWith([])
    await seedPersonalAgent(holderId, [SCOPE])
    // The requester is alone in the room while the turn runs, so the room floor
    // leaves the scope on the agent's ceiling and the tool is callable. The
    // second member joins after, exactly as a later joiner would.
    const threadId = await seedThread(holderId, [holderId])

    const ephemeral = await turnEphemeralReply(threadId, await actorFor(holderId))
    await addParticipant(threadId, lackerId)

    const { manager, holder, lacker } = connect(threadId, holderId, lackerId)
    await manager.broadcast(ephemeral)

    expect(holder.send).toHaveBeenCalledTimes(1)
    expect(String(holder.send.mock.calls[0][0])).toContain(REPLY)
    // The reply quotes what the scoped tool read, so a connection without the
    // scope must not receive it live either.
    expect(lacker.send).not.toHaveBeenCalled()
  })

  test("the live copy and the persisted row are tagged with the same scopes", async () => {
    const holderId = await userWith([SCOPE])
    await seedPersonalAgent(holderId, [SCOPE])
    const threadId = await seedThread(holderId, [holderId])

    const ephemeral = await turnEphemeralReply(threadId, await actorFor(holderId))

    const data = ephemeral.data as Record<string, unknown>
    expect(data.requiredScopes).toEqual([SCOPE])
    // The one value both the broadcast and sendMessage were given: if these
    // ever disagreed, the live copy would show what the refetch takes away.
    expect(await persistedReplyScopes(threadId)).toEqual([[SCOPE]])
  })
})

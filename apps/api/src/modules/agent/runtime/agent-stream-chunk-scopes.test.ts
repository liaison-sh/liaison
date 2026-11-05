// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A2 (spec-security.md): an `agent_stream` chunk reaches only the connections
// whose grants hold the scopes the turn has accumulated SO FAR, re-evaluated
// per chunk. `websocket.ts` `hasStreamChunkAccess` is that gate, and it fails
// closed on a chunk carrying no `accumulatedScopes`: an emitter that does not
// tag its chunks takes live streaming away from every room member except the
// requester, silently, while the final message still arrives.
//
// So each emitter is driven for real here and BOTH halves are asserted: the tag
// the emitter actually put on the wire, and where a real WebSocketManager then
// delivers it. The turns are real turns: a real tool call, through the turn's
// real tool set, accumulates a real scope midway.
//
// The three emitters live in three files (the @-mention mirror in
// agent-service.ts, the chat SSE mirror in modules/agent/routes.ts, the mailbox
// request in mailbox-plaintext-broker.ts) but share one fixture and one rule,
// so they are covered together rather than in three copies of this setup.

import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import { app } from "~/app"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import * as eventBusModule from "~/infra/events/event-bus"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { fulfilMailboxMarker } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import { MailboxPlaintextRegistryTestAccess } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import {
  createTurnScopeAccumulator,
  type TurnScopeAccumulator,
} from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-stream-chunk-scopes"
const SCOPE = "asc:deals:read"
const TOOL = "asc__dealTool"
/** Streamed BEFORE the tool call: the turn has touched nothing scoped yet. */
const BEFORE = "let me look that up"
/** Streamed AFTER the tool result: this text is downstream of scoped data. */
const AFTER = "deal 42 closes Friday for 90k"

type WsEvent = Parameters<WebSocketManager["broadcast"]>[0]
type StreamTools = Record<string, { execute?: (args: unknown) => Promise<unknown> }>

interface FakeSocket {
  send: ReturnType<typeof mock>
  readyState: number
}

/**
 * A turn that answers, calls the scoped tool, then answers again. The scope is
 * recorded when the tool runs, so the two text deltas straddle the moment the
 * turn's accumulated set grows.
 */
function toolCallingStream(toolName: string) {
  return (opts: { tools?: StreamTools }) => ({
    fullStream: (async function* () {
      yield { type: "text-delta", text: BEFORE }
      const toolDef = opts.tools?.[toolName]
      if (!toolDef?.execute) throw new Error(`${toolName} is not in the turn tool set`)
      yield { type: "tool-call", toolCallId: "call-asc-0", toolName, input: {} }
      const output = await toolDef.execute({})
      yield { type: "tool-result", toolCallId: "call-asc-0", toolName, input: {}, output }
      yield { type: "text-delta", text: AFTER }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  })
}

describe("agent stream chunks carry the turn's accumulated scopes", () => {
  let orgId: string
  let requesterId: string
  let holderId: string
  let lackerId: string
  let requesterToken: string
  const previousWsManager = getWsManager()

  async function userWith(scopes: string[]): Promise<string> {
    const user = await minimal.person(orgId)
    for (const scope of scopes) await minimal.grantScope(user.id, scope)
    return user.id
  }

  async function actorFor(userId: string): Promise<UserContext> {
    const { scopes } = await withPrivilegedDb(orgId, "test-asc-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  }

  /** A thread whose only member during the turn is the requester. */
  async function seedThread(createdBy: string): Promise<string> {
    return withPrivilegedDb(orgId, "test-asc-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `asc-${crypto.randomUUID().slice(0, 8)}`,
          type: "agent_chat",
          createdBy,
        })
        .returning({ id: threads.id })
      await tx.insert(threadParticipants).values({ threadId: t.id, userId: createdBy, orgId })
      return t.id
    })
  }

  /** Every `agent_stream` event the body actually broadcast, in order. */
  async function captureChunks(body: () => Promise<void>): Promise<WsEvent[]> {
    const captured: WsEvent[] = []
    const spy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async (event) => {
      captured.push(event as WsEvent)
    })
    try {
      await body()
    } finally {
      spy.mockRestore()
    }
    return captured.filter((e) => e.entity === "agent_stream")
  }

  /** The tag on the chunk carrying this delta text. */
  function scopesOfDelta(chunks: WsEvent[], text: string): unknown {
    const chunk = chunks.find((c) => (c.data as Record<string, unknown>).delta === text)
    if (!chunk) throw new Error(`no delta chunk carrying "${text}"`)
    return (chunk.data as Record<string, unknown>).accumulatedScopes
  }

  /**
   * The room as three live connections: the requester who started the turn, a
   * teammate holding the scope and a teammate without it. Membership is
   * identical for all three, so only their grants and the chunk's tag can
   * explain a difference in delivery.
   */
  function connectRoom(threadId: string) {
    const manager = new WebSocketManager(redis)
    const sockets: Record<string, FakeSocket> = {
      requester: { send: mock(() => {}), readyState: 1 },
      holder: { send: mock(() => {}), readyState: 1 },
      lacker: { send: mock(() => {}), readyState: 1 },
    }
    manager.addConnection(requesterId, sockets.requester as never, ["kernel", SCOPE], orgId)
    manager.addConnection(holderId, sockets.holder as never, ["kernel", SCOPE], orgId)
    manager.addConnection(lackerId, sockets.lacker as never, ["kernel"], orgId)
    for (const s of Object.values(sockets)) {
      manager.setThreadMembership(s as never, new Set([threadId]))
    }
    return { manager, sockets }
  }

  /** The delta texts a socket was actually sent. */
  function deltasOf(socket: FakeSocket): string[] {
    return socket.send.mock.calls
      .map((call: unknown[]) => JSON.parse(String(call[0])))
      .filter(
        (frame: { payload?: { entity?: string } }) => frame.payload?.entity === "agent_stream",
      )
      .map((frame: { payload: { data?: Record<string, unknown> } }) => frame.payload.data?.delta)
      .filter((delta: unknown): delta is string => typeof delta === "string")
  }

  async function deliver(chunks: WsEvent[], manager: WebSocketManager): Promise<void> {
    for (const chunk of chunks) await manager.broadcast(chunk)
  }

  function mailboxFrame(accumulator?: TurnScopeAccumulator): RunContext {
    const runId = crypto.randomUUID()
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      mailboxTurnNonce: "nonce-asc-fx14",
      // A tiny wait budget: the request is emitted, nobody answers, and the
      // turn takes the locked path a few ms later. The emitted chunk is what
      // this file is about.
      mailbox: { remainingWaitMs: 25, requests: 0, releasedMessages: 0 },
      ...(accumulator ? { turnScopeAccumulator: accumulator } : {}),
    } as RunContext
  }

  /** One mailbox decrypt request, emitted through the broker's real deps. */
  async function mailboxRequestChunks(
    threadId: string,
    frame: RunContext,
    manager: WebSocketManager,
  ): Promise<WsEvent[]> {
    await manager.setMailboxUnlock(requesterId, {
      unlocked: true,
      keyIds: [1],
      expiresAt: Date.now() + 60_000,
    })
    setWsManager(manager)
    try {
      return await captureChunks(async () => {
        await fulfilMailboxMarker({
          result: {
            needsPlaintext: {
              requestKind: "mail.read",
              messageIds: ["m1"],
              purpose: "answer the question about this thread",
            },
          },
          orgId,
          userId: requesterId,
          threadId,
          frame,
        })
      })
    } finally {
      setWsManager(previousWsManager as WebSocketManager)
    }
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    requesterId = await userWith([SCOPE])
    holderId = await userWith([SCOPE])
    lackerId = await userWith([])

    // The acting agent's ceiling holds the scope, and the room is the requester
    // alone while the turn runs, so the room floor leaves it there and the
    // scoped tool is callable. The teammates watch the room over their own
    // sockets, exactly as a thread tab open on the same thread does.
    await withPrivilegedDb(orgId, "test-asc-agent", (tx) =>
      tx.insert(agents).values({
        orgId,
        kind: "personal",
        handle: `@asc-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Liaison",
        ownerUserId: requesterId,
        scopeCeiling: [SCOPE],
      }),
    )
    toolRegistry.set([orgId, "asc", "dealTool"], {
      appName: "asc",
      name: "dealTool",
      description: `Stream chunk probe requiring ${SCOPE}`,
      requiredScopes: [SCOPE],
      handler: async () => ({ ok: true }),
      params: z.object({}),
    })
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Stream Chunks', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`

    const { scopes } = await withPrivilegedDb(orgId, "test-asc-token", (tx) =>
      loadEffectivePermissions(tx, requesterId, orgId),
    )
    // Granting the scope bumps the row's permission_version, and the auth
    // middleware rejects a token whose versions do not match the row.
    const [versions] = await sql<{ auth_version: number; permission_version: number }[]>`
      SELECT auth_version, permission_version FROM kernel.users WHERE id = ${requesterId}`
    requesterToken = await signAccessToken(
      {
        userId: requesterId,
        orgId,
        name: "Stream Requester",
        authVersion: versions.auth_version,
        permissionVersion: versions.permission_version,
        scopes,
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([orgId, "asc"])
    AgentServiceTestAccess.setStreamText()
    setWsManager(previousWsManager as WebSocketManager)
    MailboxPlaintextRegistryTestAccess.reset()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  /** One @-mention turn through the real invokeAgentForThread. */
  async function mentionTurnChunks(threadId: string): Promise<WsEvent[]> {
    const actor = await actorFor(requesterId)
    const msg = await withPrivilegedDb(orgId, "test-asc-user-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId: requesterId,
        threadId,
        content: "@Liaison what is the deal status",
        authorType: "user",
      }),
    )
    if (!msg) throw new Error("the requester could not post into the test thread")
    AgentServiceTestAccess.setStreamText(toolCallingStream(TOOL) as never)
    try {
      return await captureChunks(async () => {
        await invokeAgentForThread(threadId, msg.id, actor, orgId)
      })
    } finally {
      AgentServiceTestAccess.setStreamText()
    }
  }

  test("the mention stream tags each chunk with the scopes accumulated when that chunk was emitted", async () => {
    const threadId = await seedThread(requesterId)

    const chunks = await mentionTurnChunks(threadId)

    // The set grows mid-turn, so the two deltas must NOT carry the same tag: an
    // empty array is a positive claim that nothing scoped has been read yet.
    expect(scopesOfDelta(chunks, BEFORE)).toEqual([])
    expect(scopesOfDelta(chunks, AFTER)).toEqual([SCOPE])
    const start = chunks.find((c) => c.action === "start")
    expect((start?.data as Record<string, unknown>)?.accumulatedScopes).toEqual([])
  })

  test("a teammate lacking the accumulated scope stops receiving chunks while the holder keeps them", async () => {
    const threadId = await seedThread(requesterId)
    const chunks = await mentionTurnChunks(threadId)

    const { manager, sockets } = connectRoom(threadId)
    await deliver(chunks, manager)

    // The teammate holding the scope follows the whole turn. This is the half an
    // untagged chunk destroys: the fan-out fails closed and hands them nothing,
    // so live streaming silently dies for everyone but the requester.
    expect(deltasOf(sockets.holder)).toEqual([BEFORE, AFTER])
    // Before the turn read anything scoped the room sees the stream too, and
    // after it did, only the grant-holders keep following it.
    expect(deltasOf(sockets.lacker)).toEqual([BEFORE])
    expect(deltasOf(sockets.requester)).toEqual([BEFORE, AFTER])
  })

  test("the chat route's mirrored chunks are tagged and gated the same way", async () => {
    const threadId = await seedThread(requesterId)
    AgentServiceTestAccess.setStreamText(toolCallingStream(TOOL) as never)
    let chunks: WsEvent[]
    try {
      chunks = await captureChunks(async () => {
        const res = await app.request("/api/agent/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${requesterToken}`,
          },
          body: JSON.stringify({ threadId, content: "what is the deal status" }),
        })
        expect(res.status).toBe(200)
        // Drain the SSE body so the route's stream loop runs to completion.
        await res.text()
      })
    } finally {
      AgentServiceTestAccess.setStreamText()
    }

    expect(scopesOfDelta(chunks, BEFORE)).toEqual([])
    expect(scopesOfDelta(chunks, AFTER)).toEqual([SCOPE])

    const { manager, sockets } = connectRoom(threadId)
    await deliver(chunks, manager)
    expect(deltasOf(sockets.holder)).toEqual([BEFORE, AFTER])
    expect(deltasOf(sockets.lacker)).toEqual([BEFORE])
  })

  test("a mailbox decrypt request carries the scopes its turn has accumulated", async () => {
    const threadId = await seedThread(requesterId)
    const accumulator = createTurnScopeAccumulator()
    accumulator.recordInjected([SCOPE])
    const { manager } = connectRoom(threadId)

    const chunks = await mailboxRequestChunks(threadId, mailboxFrame(accumulator), manager)

    expect(chunks).toHaveLength(1)
    expect((chunks[0].data as Record<string, unknown>).accumulatedScopes).toEqual([SCOPE])
  })

  test("a mailbox request, which carries its answer token, reaches the requester's connections only", async () => {
    const threadId = await seedThread(requesterId)
    const accumulator = createTurnScopeAccumulator()
    accumulator.recordInjected([SCOPE])
    const { manager, sockets } = connectRoom(threadId)

    const chunks = await mailboxRequestChunks(threadId, mailboxFrame(accumulator), manager)
    expect(typeof (chunks[0].data as Record<string, unknown>).answerToken).toBe("string")

    await deliver(chunks, manager)
    // The teammate holds every scope the turn accumulated, and still is not asked.
    expect(sockets.requester.send).toHaveBeenCalledTimes(1)
    expect(sockets.holder.send).not.toHaveBeenCalled()
    expect(sockets.lacker.send).not.toHaveBeenCalled()
  })

  test("a turn whose scopes cannot be known leaves the chunk untagged, so only the requester sees it", async () => {
    const threadId = await seedThread(requesterId)
    // No accumulator on the frame: this turn's set is genuinely unknown, and
    // guessing `[]` would publish the ask to the whole room.
    const { manager, sockets } = connectRoom(threadId)

    const chunks = await mailboxRequestChunks(threadId, mailboxFrame(), manager)

    expect(chunks).toHaveLength(1)
    const data = chunks[0].data as Record<string, unknown>
    expect("accumulatedScopes" in data).toBe(false)

    await deliver(chunks, manager)
    // The requester is the mailbox owner and must always be asked; nobody else
    // is, because the fan-out fails closed on an unknown set.
    expect(sockets.requester.send).toHaveBeenCalledTimes(1)
    expect(sockets.holder.send).not.toHaveBeenCalled()
    expect(sockets.lacker.send).not.toHaveBeenCalled()
  })
})

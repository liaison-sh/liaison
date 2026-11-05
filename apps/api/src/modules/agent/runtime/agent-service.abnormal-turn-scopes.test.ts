// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A turn that ends abnormally after a tool call is tagged with what it READ: the
// accumulator's record, which the tool bridge fills before each tool runs
// (spec-security.md A2). Until 2026-11-03 it was widened to the agent's whole
// effective scope instead, which on a `*` ceiling stamped `*`, re-propagated
// through history and hid replies from teammates. The ceiling (else the
// requester's scopes) is now only the fallback when no record survived. Every
// exit is covered here: a thrown stream, an in-band provider error, a cancelled
// request and the finally safety net that runs when the stream simply stops.
// The success path is pinned unchanged, and so is a failure that made no tool
// call at all.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages, threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import {
  AgentServiceTestAccess,
  invokeAgentForThread,
  runAgentChat,
} from "~/modules/agent/runtime/agent-service"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import * as toolBridgeModule from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-abnormal-turn"
const ALPHA = "abn:alpha:read"
const BETA = "abn:beta:read"
const GAMMA = "abn:gamma:read"
/** One probe tool per scope, registered under app `abn`. */
const ABN_TOOLS = { alphaTool: ALPHA, betaTool: BETA, gammaTool: GAMMA }

type StreamTools = Record<string, { execute?: (args: unknown) => Promise<unknown> }>

/** Calls each named tool through the turn's real tool set, in order. */
async function* callTools(toolNames: string[], tools: StreamTools | undefined) {
  for (const [i, toolName] of toolNames.entries()) {
    const toolDef = tools?.[toolName]
    if (!toolDef?.execute) throw new Error(`${toolName} is not in the turn tool set`)
    const toolCallId = `call-abn-${i}`
    yield { type: "tool-call", toolCallId, toolName, input: {} }
    const output = await toolDef.execute({})
    yield { type: "tool-result", toolCallId, toolName, input: {}, output }
  }
}

/** A clean turn: tool calls, then an answer and a finish chunk. */
function cleanStream(toolNames: string[]) {
  return (opts: { tools?: StreamTools }) => ({
    fullStream: (async function* () {
      yield* callTools(toolNames, opts.tools)
      yield { type: "text-delta", text: "ok" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  })
}

/** The stream THROWS after its tool calls: invokeAgentForThread's catch path. */
function throwingStream(toolNames: string[]) {
  return (opts: { tools?: StreamTools }) => ({
    fullStream: (async function* () {
      yield* callTools(toolNames, opts.tools)
      throw new Error("the tool call blew the stream up")
    })(),
  })
}

/** An in-band provider error after the tool calls: the BL-177 path. */
function inbandErrorStream(toolNames: string[]) {
  return (opts: { tools?: StreamTools }) => ({
    fullStream: (async function* () {
      yield* callTools(toolNames, opts.tools)
      yield { type: "error", error: new Error("provider returned 500") }
    })(),
  })
}

/** The stream just stops: no finish, no error, no throw. The finally safety net. */
function silentEndStream(toolNames: string[]) {
  return (opts: { tools?: StreamTools }) => ({
    fullStream: (async function* () {
      yield* callTools(toolNames, opts.tools)
    })(),
  })
}

/** The caller cancels mid turn, after the tool calls have run. */
function cancellingStream(toolNames: string[], controller: AbortController) {
  return (opts: { tools?: StreamTools }) => ({
    fullStream: (async function* () {
      yield* callTools(toolNames, opts.tools)
      yield { type: "text-delta", text: "partial answer so far" }
      controller.abort("client_disconnect")
    })(),
  })
}

describe("an errored turn still tags what it writes", () => {
  let orgId: string

  async function seedThread(type: string, createdBy: string, participantIds: string[]) {
    return withPrivilegedDb(orgId, "test-abnormal-turn-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({ orgId, handle: `abn-${crypto.randomUUID().slice(0, 8)}`, type, createdBy })
        .returning({ id: threads.id })
      for (const userId of participantIds) {
        await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      }
      return t.id
    })
  }

  async function seedPersonalAgent(ownerUserId: string, ceiling: string[]): Promise<string> {
    return withPrivilegedDb(orgId, "test-abnormal-turn-agent", async (tx) => {
      const [a] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "personal",
          handle: `@abn-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Liaison",
          ownerUserId,
          scopeCeiling: ceiling,
        })
        .returning({ id: agents.id })
      return a.id
    })
  }

  async function userWith(scopes: string[]): Promise<string> {
    const user = await minimal.person(orgId)
    await minimal.revokeRole(user.id, "member")
    for (const scope of scopes) await minimal.grantScope(user.id, scope)
    // Registration gave the person a personal agent; these scenarios start without one
    // and seed it (seedPersonalAgent) when they need it.
    await withPrivilegedDb(orgId, "test-abnormal-turn-drop-agent", (tx) =>
      tx
        .delete(agents)
        .where(
          and(
            eq(agents.orgId, orgId),
            eq(agents.kind, "personal"),
            eq(agents.ownerUserId, user.id),
          ),
        ),
    )
    return user.id
  }

  async function actorFor(userId: string): Promise<UserContext> {
    const { scopes } = await withPrivilegedDb(orgId, "test-abnormal-turn-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  }

  async function addParticipant(threadId: string, userId: string) {
    await withPrivilegedDb(orgId, "test-abnormal-turn-participant", (tx) =>
      tx.insert(threadParticipants).values({ threadId, userId, orgId }),
    )
  }

  /** required_scopes of every agent-authored message in a thread, oldest first. */
  async function agentReplyScopes(threadId: string): Promise<string[][]> {
    const rows = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`
    return rows.map((r) => r.required_scopes)
  }

  /** The agent messages of a thread this viewer can actually read, through RLS. */
  async function visibleAgentMessages(viewer: UserContext, threadId: string) {
    return withRlsContext(viewer, async (tx) =>
      (
        await tx
          .select({ authorType: messages.authorType })
          .from(messages)
          .where(eq(messages.threadId, threadId))
      ).filter((m) => m.authorType === "agent"),
    )
  }

  /**
   * One turn through the real invokeAgentForThread, which owns the catch and
   * the finally. Returns the run frame the turn actually ran under.
   */
  async function invokedTurn(
    threadId: string,
    actor: UserContext,
    stub: unknown,
  ): Promise<RunContext> {
    const msg = await withPrivilegedDb(orgId, "test-abnormal-turn-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId: actor.userId,
        threadId,
        content: "@Liaison do the thing",
        authorType: "user",
      }),
    )
    if (!msg) throw new Error("the requester could not post into the test thread")
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
    AgentServiceTestAccess.setStreamText(stub as never)
    try {
      await invokeAgentForThread(threadId, msg.id, actor, orgId)
      expect(buildSpy).toHaveBeenCalledTimes(1)
      const frame = buildSpy.mock.calls[0]?.[5]
      if (!frame) throw new Error("buildToolSet was called without a run frame")
      return frame
    } finally {
      buildSpy.mockRestore()
      AgentServiceTestAccess.setStreamText()
    }
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    for (const [name, scope] of Object.entries(ABN_TOOLS)) {
      toolRegistry.set([orgId, "abn", name], {
        appName: "abn",
        name,
        description: `Abnormal end probe requiring ${scope}`,
        requiredScopes: [scope],
        handler: async () => ({ ok: true }),
        params: z.object({}),
      })
    }
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Abnormal', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([orgId, "abn"])
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  test("a turn that calls one tool then throws tags the resulting message with exactly what it read", async () => {
    const requester = await userWith([ALPHA, BETA])
    await seedPersonalAgent(requester, [ALPHA, BETA])
    const threadId = await seedThread("agent_chat", requester, [requester])

    const frame = await invokedTurn(
      threadId,
      await actorFor(requester),
      throwingStream(["abn__alphaTool"]),
    )

    // Only the alpha tool ran: the ceiling also holds BETA, which the turn never read.
    expect(frame.effectiveScope).toEqual([ALPHA, BETA])
    expect(await agentReplyScopes(threadId)).toEqual([[ALPHA]])
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual([ALPHA])
  })

  test("a member who lacks what an errored turn read cannot see what it wrote", async () => {
    const alice = await userWith([ALPHA, BETA])
    const carol = await userWith([BETA])
    await seedPersonalAgent(alice, [ALPHA, BETA])
    const threadId = await seedThread("agent_chat", alice, [alice])

    await invokedTurn(threadId, await actorFor(alice), throwingStream(["abn__alphaTool"]))
    // Added after the turn, so the room floor of the turn itself is unchanged.
    await addParticipant(threadId, carol)

    expect(await visibleAgentMessages(await actorFor(alice), threadId)).toHaveLength(1)
    expect(await visibleAgentMessages(await actorFor(carol), threadId)).toHaveLength(0)
  })

  test("a member who holds what an errored turn read sees it, though they lack the rest of the ceiling", async () => {
    const alice = await userWith([ALPHA, BETA])
    const dave = await userWith([ALPHA])
    await seedPersonalAgent(alice, [ALPHA, BETA])
    const threadId = await seedThread("agent_chat", alice, [alice])

    await invokedTurn(threadId, await actorFor(alice), throwingStream(["abn__alphaTool"]))
    await addParticipant(threadId, dave)

    expect(await visibleAgentMessages(await actorFor(dave), threadId)).toHaveLength(1)
  })

  test("an errored turn on a `*` ceiling stamps what it read, never `*` or the ceiling", async () => {
    const requester = await userWith([ALPHA, BETA, GAMMA])
    await seedPersonalAgent(requester, ["*"])
    const threadId = await seedThread("agent_chat", requester, [requester])

    await invokedTurn(threadId, await actorFor(requester), throwingStream(["abn__alphaTool"]))

    expect(await agentReplyScopes(threadId)).toEqual([[ALPHA]])
  })

  test("a turn ended by an in-band provider error after a tool call is tagged with what it read", async () => {
    const requester = await userWith([ALPHA, BETA])
    await seedPersonalAgent(requester, [ALPHA, BETA])
    const threadId = await seedThread("agent_chat", requester, [requester])

    await invokedTurn(threadId, await actorFor(requester), inbandErrorStream(["abn__alphaTool"]))

    expect(await agentReplyScopes(threadId)).toEqual([[ALPHA]])
  })

  test("a turn whose stream stops with no terminal chunk is tagged by the finally safety net", async () => {
    const requester = await userWith([ALPHA, BETA])
    await seedPersonalAgent(requester, [ALPHA, BETA])
    const threadId = await seedThread("agent_chat", requester, [requester])

    await invokedTurn(threadId, await actorFor(requester), silentEndStream(["abn__alphaTool"]))

    expect(await agentReplyScopes(threadId)).toEqual([[ALPHA]])
  })

  test("a cancelled turn tags its partial reply with what it read", async () => {
    const requester = await userWith([ALPHA, BETA])
    await seedPersonalAgent(requester, [ALPHA, BETA])
    const threadId = await seedThread("agent_chat", requester, [requester])
    const actor = await actorFor(requester)
    const controller = new AbortController()

    AgentServiceTestAccess.setStreamText(cancellingStream(["abn__alphaTool"], controller) as never)
    try {
      const result = await runAgentChat({
        threadId,
        content: "cancel me",
        actor,
        orgId,
        requestSignal: controller.signal,
      })
      for await (const chunk of result.fullStream) void chunk
      // What invokeAgentForThread's finally does once the stream is exhausted:
      // the turn produced text but was cancelled before any finish chunk.
      await result.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "tool-calls",
        text: "partial answer so far",
        steps: [],
      })
    } finally {
      AgentServiceTestAccess.setStreamText()
    }

    expect(await agentReplyScopes(threadId)).toEqual([[ALPHA]])
  })

  test("an errored turn with no resolvable agent is tagged with what it read, not the requester's scopes", async () => {
    // No personal agent for this requester, so the turn runs at the actor's own
    // scopes and the frame carries no effective scope. The record survived, so
    // the requester fallback is not used.
    const requester = await userWith([ALPHA, BETA, GAMMA])
    const threadId = await seedThread("thread", requester, [requester])

    const frame = await invokedTurn(
      threadId,
      await actorFor(requester),
      throwingStream(["abn__alphaTool"]),
    )

    expect(frame.effectiveScope).toBeUndefined()
    expect(await agentReplyScopes(threadId)).toEqual([[ALPHA]])
  })

  test("a turn that ends cleanly is still tagged with what it accumulated, never widened", async () => {
    const requester = await userWith([ALPHA, BETA])
    await seedPersonalAgent(requester, [ALPHA, BETA])
    const threadId = await seedThread("agent_chat", requester, [requester])

    await invokedTurn(threadId, await actorFor(requester), cleanStream(["abn__alphaTool"]))

    expect(await agentReplyScopes(threadId)).toEqual([[ALPHA]])
  })

  test("a turn that fails before any tool call keeps the empty tag, which asserts it read nothing", async () => {
    const requester = await userWith([ALPHA, BETA])
    await seedPersonalAgent(requester, [ALPHA, BETA])
    const threadId = await seedThread("agent_chat", requester, [requester])

    await invokedTurn(threadId, await actorFor(requester), throwingStream([]))

    expect(await agentReplyScopes(threadId)).toEqual([[]])
  })

  describe("turnEndRequiredScopes", () => {
    test("an abnormal end after a tool call stamps exactly the accumulated reads, not the ceiling", async () => {
      const { turnEndRequiredScopes } = await import("~/modules/agent/runtime/agent-service")
      const accumulator = createTurnScopeAccumulator()
      accumulator.record({ requiredScopes: [ALPHA] })

      for (const ceiling of [[ALPHA, BETA, GAMMA], ["*", BETA], undefined]) {
        expect(
          turnEndRequiredScopes({
            accumulator,
            fullEffectiveScope: ceiling,
            requesterScopes: ["*", BETA, GAMMA],
          }),
        ).toEqual([ALPHA])
      }
    })

    test("a lost accumulator falls back to the ceiling when there is one", async () => {
      const { turnEndRequiredScopes } = await import("~/modules/agent/runtime/agent-service")
      expect(
        turnEndRequiredScopes({
          accumulator: undefined,
          fullEffectiveScope: [ALPHA],
          requesterScopes: [BETA, ALPHA, BETA],
        }),
      ).toEqual([ALPHA])
    })

    test("a lost accumulator on a `*` ceiling is projected: no `*` entry, every catalogued read", async () => {
      const { turnEndRequiredScopes } = await import("~/modules/agent/runtime/agent-service")
      const { taintReadCatalog } = await import("~/modules/agent/scopes/taint-read-scopes")
      const stamp = turnEndRequiredScopes({
        accumulator: undefined,
        fullEffectiveScope: ["*", ALPHA, "abn:alpha:write"],
        requesterScopes: [GAMMA],
      })
      expect(stamp.filter((s) => s.split(":").includes("*"))).toEqual([])
      expect(stamp).toContain(ALPHA)
      expect(stamp).not.toContain("abn:alpha:write")
      for (const read of taintReadCatalog()) expect(stamp).toContain(read)
    })

    test("a lost accumulator with no ceiling falls back to the requester scopes, projected, never empty", async () => {
      const { turnEndRequiredScopes } = await import("~/modules/agent/runtime/agent-service")
      expect(
        turnEndRequiredScopes({
          accumulator: undefined,
          fullEffectiveScope: undefined,
          requesterScopes: [GAMMA, "*:approve"],
        }),
      ).toEqual([GAMMA])
    })

    test("an effective scope that is present and empty is used as given", async () => {
      const { turnEndRequiredScopes } = await import("~/modules/agent/runtime/agent-service")
      expect(
        turnEndRequiredScopes({
          accumulator: undefined,
          fullEffectiveScope: [],
          requesterScopes: [ALPHA, BETA],
        }),
      ).toEqual([])
    })
  })
})

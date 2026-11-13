// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A real chat turn's run frame carries the D2 effective scope once an acting
// agent is resolvable for the thread, and buildToolSet filters the catalog by
// it. The frame tests stub the catalog builders and read the frame actually
// handed to buildToolSet; the catalog tests run the real buildToolSet.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages, routines, threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import * as eventBusModule from "~/infra/events/event-bus"
import {
  AgentServiceTestAccess,
  invokeAgentForThread,
  runAgentChat,
} from "~/modules/agent/runtime/agent-service"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { computeEffectiveScopeForTurn } from "~/modules/agent/scopes/effective-scope"
import * as toolBridgeModule from "~/modules/agent/tools/tool-bridge"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-effscope-chat"
const CEILING = ["a:b:read", "c:d:write"]
const ALPHA = "esc:alpha:read"
const BETA = "esc:beta:read"
const GAMMA = "esc:gamma:read"
const SHARED = "esc:shared:read"
/** One probe tool per scope, registered under app `esc`. */
const ESC_TOOLS = { alphaTool: ALPHA, betaTool: BETA, gammaTool: GAMMA, sharedTool: SHARED }

function stubStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

describe("runAgentChat run frame carries the effective scope", () => {
  let orgId: string

  async function seedThread(type: string, createdBy: string, participantIds: string[]) {
    return withPrivilegedDb(orgId, "test-effective-scope-chat-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({ orgId, handle: `esc-${crypto.randomUUID().slice(0, 8)}`, type, createdBy })
        .returning({ id: threads.id })
      for (const userId of participantIds) {
        await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      }
      return t.id
    })
  }

  /** A person without a personal agent: the one their registration created is removed. */
  async function dropPersonalAgent(ownerUserId: string): Promise<void> {
    await withPrivilegedDb(orgId, "test-effective-scope-chat-drop-agent", (tx) =>
      tx
        .delete(agents)
        .where(
          and(
            eq(agents.orgId, orgId),
            eq(agents.kind, "personal"),
            eq(agents.ownerUserId, ownerUserId),
          ),
        ),
    )
  }

  // Registration gives every person their personal agent (minimal.person registers
  // through an invitation); this replaces it with one holding `ceiling`.
  async function seedPersonalAgent(ownerUserId: string, ceiling = CEILING): Promise<string> {
    await dropPersonalAgent(ownerUserId)
    return withPrivilegedDb(orgId, "test-effective-scope-chat-agent", async (tx) => {
      const [a] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "personal",
          handle: `@esc-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Liaison",
          ownerUserId,
          scopeCeiling: ceiling,
        })
        .returning({ id: agents.id })
      return a.id
    })
  }

  async function seedPersonalAgentAt(ownerUserId: string, id: string, createdAt: Date) {
    await withPrivilegedDb(orgId, "test-effective-scope-chat-agent-at", (tx) =>
      tx.insert(agents).values({
        id,
        orgId,
        kind: "personal",
        handle: `@esc-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Liaison",
        ownerUserId,
        scopeCeiling: [ALPHA],
        createdAt,
      }),
    )
  }

  async function seedRoleAgent(ceiling: string[]): Promise<string> {
    return withPrivilegedDb(orgId, "test-effective-scope-chat-role-agent", async (tx) => {
      const [a] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "role",
          handle: `@esc-role-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Routine agent",
          scopeCeiling: ceiling,
        })
        .returning({ id: agents.id })
      return a.id
    })
  }

  async function seedRoutine(
    ownerUserId: string,
    ownerAgentId: string,
    outputThreadId: string,
    scopes: string[],
  ): Promise<string> {
    return withPrivilegedDb(orgId, "test-effective-scope-chat-routine", async (tx) => {
      const [r] = await tx
        .insert(routines)
        .values({
          orgId,
          ownerUserId,
          ownerAgentId,
          name: `esc-routine-${crypto.randomUUID().slice(0, 8)}`,
          description: "effective scope probe",
          prompt: "tick",
          cron: "0 9 * * *",
          timezone: "UTC",
          outputThreadId,
          scopes,
          createdByActorType: "user",
          createdByUserId: ownerUserId,
        })
        .returning({ id: routines.id })
      return r.id
    })
  }

  /**
   * Drives the real invokeAgentForThread path (channel mention, routine tick):
   * persists the user message the way the callers do, invokes, and returns the
   * frame buildToolSet received with the catalog the real buildToolSet built.
   */
  async function invokedTurn(
    threadId: string,
    actor: UserContext,
    opts: { routineId?: string } = {},
  ): Promise<{ frame: RunContext; catalog: Record<string, any> }> {
    const msg = await withPrivilegedDb(orgId, "test-effective-scope-chat-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId: actor.userId,
        threadId,
        content: "@Liaison hello",
        authorType: "user",
      }),
    )
    if (!msg) throw new Error("the requester could not post into the test thread")
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
    try {
      await invokeAgentForThread(
        threadId,
        msg.id,
        actor,
        orgId,
        opts.routineId !== undefined,
        undefined,
        opts.routineId,
      )
      expect(buildSpy).toHaveBeenCalledTimes(1)
      const frame = buildSpy.mock.calls[0]?.[5]
      if (!frame) throw new Error("buildToolSet was called without a run frame")
      return { frame, catalog: buildSpy.mock.results[0]?.value as Record<string, any> }
    } finally {
      buildSpy.mockRestore()
    }
  }

  async function actorFor(userId: string): Promise<UserContext> {
    const { scopes } = await withPrivilegedDb(orgId, "test-effective-scope-chat-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  }

  /** Runs one chat turn and returns the run frame buildToolSet received. */
  async function frameOfTurn(threadId: string, actor: UserContext): Promise<RunContext> {
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet").mockImplementation(() => ({}))
    const deferredSpy = spyOn(toolBridgeModule, "listDeferredTools").mockImplementation(() => [])
    try {
      const result = await runAgentChat({ threadId, content: "hello", actor, orgId })
      await result.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      expect(buildSpy).toHaveBeenCalledTimes(1)
      const frame = buildSpy.mock.calls[0]?.[5]
      if (!frame) throw new Error("buildToolSet was called without a run frame")
      return frame
    } finally {
      buildSpy.mockRestore()
      deferredSpy.mockRestore()
    }
  }

  /** Runs one chat turn through the real buildToolSet and returns its catalog. */
  async function catalogOfTurn(threadId: string, actor: UserContext): Promise<Record<string, any>> {
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
    try {
      const result = await runAgentChat({ threadId, content: "hello", actor, orgId })
      await result.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      expect(buildSpy).toHaveBeenCalledTimes(1)
      return buildSpy.mock.results[0]?.value as Record<string, any>
    } finally {
      buildSpy.mockRestore()
    }
  }

  /** The real buildToolSet for a frame carrying only the given effective scope. */
  function catalogForFrame(actor: UserContext, effectiveScope: string[] | undefined) {
    const runId = crypto.randomUUID()
    const frame: RunContext = {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      ...(effectiveScope ? { effectiveScope } : {}),
    }
    return toolBridgeModule.buildToolSet(
      orgId,
      actor,
      undefined,
      toolBridgeModule.ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      frame,
    )
  }

  /** The SDK names of this file's own read probes in a catalog, sorted. */
  function escTools(catalog: Record<string, any>): string[] {
    const probes = new Set(Object.keys(ESC_TOOLS).map((name) => `esc__${name}`))
    return Object.keys(catalog)
      .filter((name) => probes.has(name))
      .sort()
  }

  /** One scripted tool call: a tool name called with `{}`, or a name with explicit input. */
  type ToolCall = string | { toolName: string; input: unknown }

  /** A stream stub whose model calls the named tools, in order, through the turn's tool set. */
  function toolCallingStreamText(calls: ToolCall[]) {
    return (opts: {
      tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>
    }) => ({
      fullStream: (async function* () {
        for (const [i, call] of calls.entries()) {
          const { toolName, input } =
            typeof call === "string" ? { toolName: call, input: {} } : call
          const toolDef = opts.tools?.[toolName]
          if (!toolDef?.execute) throw new Error(`${toolName} is not in the turn tool set`)
          const toolCallId = `call-esc-${i}`
          yield { type: "tool-call", toolCallId, toolName, input }
          const output = await toolDef.execute(input)
          yield { type: "tool-result", toolCallId, toolName, input, output }
        }
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

  /** Runs one chat turn whose model calls the given tools; returns the frame it ran under. */
  async function frameOfToolTurn(
    threadId: string,
    actor: UserContext,
    toolNames: ToolCall[],
  ): Promise<RunContext> {
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
    AgentServiceTestAccess.setStreamText(toolCallingStreamText(toolNames) as never)
    try {
      const result = await runAgentChat({ threadId, content: "hello", actor, orgId })
      const chunks: Array<{ type?: string }> = []
      for await (const chunk of result.fullStream) chunks.push(chunk)
      await result.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      expect(chunks.filter((c) => c.type === "tool-result")).toHaveLength(toolNames.length)
      expect(buildSpy).toHaveBeenCalledTimes(1)
      const frame = buildSpy.mock.calls[0]?.[5]
      if (!frame) throw new Error("buildToolSet was called without a run frame")
      return frame
    } finally {
      buildSpy.mockRestore()
      AgentServiceTestAccess.setStreamText(stubStreamText as never)
    }
  }

  async function userWith(scopes: string[]): Promise<string> {
    const user = await minimal.person(orgId)
    await minimal.revokeRole(user.id, "member")
    for (const scope of scopes) await minimal.grantScope(user.id, scope)
    // The scenarios below start from a person with no personal agent and seed one when they need it.
    await dropPersonalAgent(user.id)
    return user.id
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(stubStreamText as never)
    orgId = (await createTestOrg()).id
    for (const [name, scope] of Object.entries(ESC_TOOLS)) {
      toolRegistry.set([orgId, "esc", name], {
        appName: "esc",
        name,
        description: `Effective scope probe requiring ${scope}`,
        requiredScopes: [scope],
        // A scoped READ: it taints the turn and is never itself a sink (scope-taint.ts, rule 1).
        readOnly: true,
        handler: async () => ({ ok: true }),
        params: z.object({}),
      })
    }
    // A GATED write under the shared scope: on a tainted turn it parks for approval, and is
    // refused only when nobody who holds its deciding scope (esc:approve) also holds the taint
    // (rule 8). Gated on purpose: an ungated write parked only by taint is decided by holders
    // of the taint (rule 8h), so the requester could always decide it and it never refuses.
    toolRegistry.set([orgId, "esc", "sharedWrite"], {
      appName: "esc",
      name: "sharedWrite",
      description: `Effective scope write probe requiring ${SHARED}`,
      requiredScopes: [SHARED],
      gated: true,
      handler: async () => ({ ok: true }),
      params: z.object({}),
    })
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku EffScope', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([orgId, "esc"])
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  test("runAgentChat resolves an agentId for an agent_chat thread and sets effectiveScope on the runFrame before buildToolSet is called", async () => {
    const requester = await minimal.person(orgId)
    await minimal.revokeRole(requester.id, "member")
    await minimal.grantScope(requester.id, "a:b:read")
    const agentId = await seedPersonalAgent(requester.id)
    const threadId = await seedThread("agent_chat", requester.id, [requester.id])
    const actor = await actorFor(requester.id)

    const expected = await withPrivilegedDb(orgId, "test-effective-scope-chat-expected", (tx) =>
      computeEffectiveScopeForTurn(tx, orgId, threadId, requester.id, CEILING),
    )
    // The requester's grants are narrower than the ceiling, so the scope narrows.
    expect(expected.effectiveScope).toEqual(["a:b:read"])

    const frame = await frameOfTurn(threadId, actor)

    expect(frame.agentId).toBe(agentId)
    expect(frame.agentCeiling).toEqual(CEILING)
    expect(frame.effectiveScope).toEqual(expected.effectiveScope)
  })

  test("a channel turn whose requester has no personal agent leaves the new RunContext fields unset", async () => {
    const alice = await minimal.person(orgId)
    const bob = await minimal.person(orgId)
    await dropPersonalAgent(alice.id)
    const threadId = await seedThread("thread", alice.id, [alice.id, bob.id])
    const actor = await actorFor(alice.id)

    const frame = await frameOfTurn(threadId, actor)

    expect(frame.agentId).toBeUndefined()
    expect(frame.agentCeiling).toBeUndefined()
    expect(frame.effectiveScope).toBeUndefined()
  })

  test("an agent turn effective scope never exceeds the scopes the actor carries into the turn", async () => {
    const requester = await minimal.person(orgId)
    await minimal.revokeRole(requester.id, "member")
    await minimal.grantScope(requester.id, "a:b:read")
    await minimal.grantScope(requester.id, "c:d:write")
    await seedPersonalAgent(requester.id)
    const threadId = await seedThread("agent_chat", requester.id, [requester.id])
    // The turn's actor carries less than the stored grants (a narrowed context).
    const actor = { ...(await actorFor(requester.id)), scopes: ["a:b:read"] }

    const stored = await withPrivilegedDb(orgId, "test-effective-scope-chat-stored", (tx) =>
      computeEffectiveScopeForTurn(tx, orgId, threadId, requester.id, CEILING),
    )
    expect(stored.effectiveScope).toEqual(CEILING)

    const frame = await frameOfTurn(threadId, actor)

    expect(frame.effectiveScope).toEqual(["a:b:read"])
  })

  test("a channel mention turn through invokeAgentForThread gets the members intersection as its tool catalog, not the union", async () => {
    const alice = await userWith([ALPHA, SHARED])
    const bob = await userWith([BETA, SHARED])
    const agentId = await seedPersonalAgent(alice, [ALPHA, BETA, SHARED])
    const threadId = await seedThread("thread", alice, [alice, bob])
    const actor = await actorFor(alice)

    const { frame, catalog } = await invokedTurn(threadId, actor)

    expect(frame.agentId).toBe(agentId)
    expect(frame.agentCeiling).toEqual([ALPHA, BETA, SHARED])
    // Alice's own exclusive scope is dropped because Bob lacks it.
    expect(frame.effectiveScope).toEqual([SHARED])
    expect(escTools(catalog)).toEqual(["esc__sharedTool"])
    expect(frame.turnScopeAccumulator).toBeDefined()
  })

  test("an approval thread mention through invokeAgentForThread is answered with the participants intersection as its scope", async () => {
    const requester = await userWith([ALPHA, SHARED])
    const approver = await userWith([BETA, SHARED])
    const agentId = await seedPersonalAgent(requester, [ALPHA, BETA, SHARED])
    const threadId = await seedThread("approval", requester, [requester, approver])
    const actor = await actorFor(requester)

    const { frame, catalog } = await invokedTurn(threadId, actor)

    expect(frame.agentId).toBe(agentId)
    expect(frame.effectiveScope).toEqual([SHARED])
    expect(escTools(catalog)).toEqual(["esc__sharedTool"])
    const rows = await sql`
      SELECT author_type, content FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent'`
    expect(rows.map((r) => r.content)).toEqual(["ok"])
  })

  test("a channel turn is capped by the agent ceiling even where every member holds the scope", async () => {
    const alice = await userWith([ALPHA, SHARED])
    const bob = await userWith([BETA, SHARED])
    await seedPersonalAgent(alice, [ALPHA, BETA])
    const threadId = await seedThread("thread", alice, [alice, bob])

    const { frame, catalog } = await invokedTurn(threadId, await actorFor(alice))

    expect(frame.effectiveScope).toEqual([])
    expect(escTools(catalog)).toEqual([])
  })

  test("a routine tick runs on the routine agent ceiling, unfloored, bounded by the tick actor scopes", async () => {
    const owner = await userWith([ALPHA, BETA])
    // The owner's personal agent must not be the one picked for the tick.
    await seedPersonalAgent(owner, [BETA])
    const routineAgentId = await seedRoleAgent([ALPHA, GAMMA])
    const threadId = await seedThread("routine", owner, [owner])
    const routineId = await seedRoutine(owner, routineAgentId, threadId, [ALPHA, BETA])
    const actor = { ...(await actorFor(owner)), scopes: [ALPHA, BETA] }

    const { frame, catalog } = await invokedTurn(threadId, actor, { routineId })

    expect(frame.routineId).toBe(routineId)
    expect(frame.agentId).toBe(routineAgentId)
    expect(frame.agentCeiling).toEqual([ALPHA, GAMMA])
    // Ceiling unchanged by any room floor, then never wider than the actor.
    expect(frame.effectiveScope).toEqual([ALPHA])
    expect(escTools(catalog)).toEqual(["esc__alphaTool"])
  })

  test("a requester with several personal agents always acts as the oldest one", async () => {
    const requester = await userWith([ALPHA])
    const older = crypto.randomUUID()
    const newer = crypto.randomUUID()
    // Physically insert the newer row first so heap order disagrees with age.
    await seedPersonalAgentAt(requester, newer, new Date("2026-02-01T00:00:00Z"))
    await seedPersonalAgentAt(requester, older, new Date("2026-01-01T00:00:00Z"))
    const threadId = await seedThread("agent_chat", requester, [requester])

    const frame = await frameOfTurn(threadId, await actorFor(requester))

    expect(frame.agentId).toBe(older)
  })

  test("an agent turn whose scope computation fails aborts before any tool set, reply or typing indicator", async () => {
    const requester = await userWith([ALPHA])
    await seedPersonalAgent(requester, [ALPHA])
    // No room floor case exists for a subrun thread, so the scope computation throws.
    const threadId = await seedThread("subrun", requester, [requester])
    const actor = await actorFor(requester)
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
    const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral")
    try {
      await expect(runAgentChat({ threadId, content: "abort me", actor, orgId })).rejects.toThrow(
        "E_ROOM_FLOOR_UNSUPPORTED_THREAD_TYPE",
      )
      expect(buildSpy).not.toHaveBeenCalled()
      const typingStarts = broadcastSpy.mock.calls.filter(
        ([e]) => e.entity === "typing" && e.entityId === threadId,
      )
      expect(typingStarts).toHaveLength(0)
    } finally {
      buildSpy.mockRestore()
      broadcastSpy.mockRestore()
    }
    // Pinned: the user message is persisted before the scope is computed and stays.
    const rows = await sql`
      SELECT author_type, content FROM kernel.messages WHERE thread_id = ${threadId} ORDER BY created_at`
    expect(rows.map((r) => [r.author_type, r.content])).toEqual([["user", "abort me"]])
  })

  test("the typing frames name the agent that is typing, not just the actor", async () => {
    // P4b-H6: a channel can have several agents in it, so "somebody is typing"
    // has to say WHICH one. The web presence store keys on this id and falls
    // back to the actor's id without it, which collapses two agents into one.
    const requester = await userWith([ALPHA])
    const agentId = await seedPersonalAgent(requester, [ALPHA])
    const threadId = await seedThread("agent_chat", requester, [requester])
    const actor = await actorFor(requester)
    AgentServiceTestAccess.setStreamText(stubStreamText)
    const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral")
    try {
      const run = await runAgentChat({ threadId, content: "type at me", actor, orgId })
      await run.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      const typing = broadcastSpy.mock.calls
        .map(([e]) => e as any)
        .filter((e) => e.entity === "typing" && e.entityId === threadId)
      expect(typing.length).toBeGreaterThan(0)
      for (const frame of typing) {
        expect(frame.data.authorType).toBe("agent")
        expect(frame.data.agentId).toBe(agentId)
      }
    } finally {
      broadcastSpy.mockRestore()
      AgentServiceTestAccess.setStreamText()
    }
  })

  test("a DM with one member gets ceiling intersected with that member alone", async () => {
    const requester = await userWith([ALPHA, BETA])
    await seedPersonalAgent(requester, [ALPHA, GAMMA])
    const threadId = await seedThread("agent_chat", requester, [requester])
    const actor = await actorFor(requester)

    const catalog = await catalogOfTurn(threadId, actor)

    // Not the member's BETA (outside the ceiling), not the ceiling's GAMMA
    // (outside the member's grants).
    expect(escTools(catalog)).toEqual(["esc__alphaTool"])
  })

  test("an empty effective scope yields only what every member may do and never falls back to the actor scopes", async () => {
    const actor = await actorFor(await userWith([ALPHA, SHARED]))

    // Every member may report a bug, export their own personal data, list, open,
    // see the history of, snapshot and print the dashboards they can see, and list,
    // open and read the dashboard tables they can see (row security filters which).
    expect(Object.keys(catalogForFrame(actor, [])).sort()).toEqual([
      "kernel__dashboards_get",
      "kernel__dashboards_history",
      "kernel__dashboards_list",
      "kernel__dashboards_pdf",
      "kernel__dashboards_snapshot",
      "kernel__data_subject_export",
      "kernel__report_bug",
      "kernel__tables_get",
      "kernel__tables_list",
      "kernel__tables_query",
    ])
    // Same actor without an effective scope on the frame: its own scopes apply.
    expect(escTools(catalogForFrame(actor, undefined))).toEqual([
      "esc__alphaTool",
      "esc__sharedTool",
    ])
  })

  test("an effective scope wider than the actor scopes never widens the catalog past the actor", async () => {
    const actor = await actorFor(await userWith([ALPHA]))

    const catalog = catalogForFrame(actor, [ALPHA, BETA, GAMMA])

    expect(escTools(catalog)).toEqual(["esc__alphaTool"])
  })

  test("a turn that calls two tools accumulates the union of both tools declared scopes", async () => {
    const requester = await userWith([ALPHA, BETA])
    const threadId = await seedThread("thread", requester, [requester])
    const actor = await actorFor(requester)

    const frame = await frameOfToolTurn(threadId, actor, ["esc__alphaTool", "esc__betaTool"])

    expect(frame.turnScopeAccumulator?.snapshot()).toEqual([ALPHA, BETA])
  })

  test("a turn that calls zero tools has an empty accumulator snapshot", async () => {
    const requester = await userWith([ALPHA, BETA])
    const threadId = await seedThread("thread", requester, [requester])
    const actor = await actorFor(requester)

    const frame = await frameOfToolTurn(threadId, actor, [])

    expect(frame.turnScopeAccumulator).toBeDefined()
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual([])
  })

  /** required_scopes of every agent-authored message in a thread, oldest first. */
  async function agentReplyScopes(threadId: string): Promise<string[][]> {
    const rows = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`
    return rows.map((r) => r.required_scopes)
  }

  test("a chat turn that called scoped tools writes its reply with the accumulated requiredScopes", async () => {
    const requester = await userWith([ALPHA, BETA])
    const threadId = await seedThread("thread", requester, [requester])

    await frameOfToolTurn(threadId, await actorFor(requester), ["esc__betaTool", "esc__alphaTool"])

    expect(await agentReplyScopes(threadId)).toEqual([[ALPHA, BETA]])
  })

  test("a chat turn that only called taint-free tools writes its reply with empty requiredScopes", async () => {
    const requester = await userWith([ALPHA, "kernel:threads:read"])
    const threadId = await seedThread("thread", requester, [requester])

    const frame = await frameOfToolTurn(threadId, await actorFor(requester), [
      "kernel__list_locked_capabilities",
    ])

    expect(frame.turnScopeAccumulator?.snapshot()).toEqual([])
    expect(await agentReplyScopes(threadId)).toEqual([[]])
  })

  test("a reply tagged by its turn is hidden by the messages RLS from a member who lacks the scope", async () => {
    const alice = await userWith([ALPHA])
    const bob = await userWith([BETA])
    const threadId = await seedThread("thread", alice, [alice, bob])

    await frameOfToolTurn(threadId, await actorFor(alice), ["esc__alphaTool"])

    const visibleAgentReplies = async (viewer: UserContext) =>
      withRlsContext(viewer, async (tx) =>
        (
          await tx
            .select({ authorType: messages.authorType })
            .from(messages)
            .where(eq(messages.threadId, threadId))
        ).filter((m) => m.authorType === "agent"),
      )
    expect(await visibleAgentReplies(await actorFor(alice))).toHaveLength(1)
    expect(await visibleAgentReplies(await actorFor(bob))).toHaveLength(0)
  })

  test("a threads_reply post made during a scoped turn carries the scopes read before it", async () => {
    const requester = await userWith([ALPHA, "kernel:threads:write"])
    const threadId = await seedThread("thread", requester, [requester])
    const otherThreadId = await seedThread("thread", requester, [requester])

    await frameOfToolTurn(threadId, await actorFor(requester), [
      "esc__alphaTool",
      {
        toolName: "kernel__threads_reply",
        input: { threadId: otherThreadId, content: "posted from a scoped turn" },
      },
    ])

    // The reply tool's own write scope is not data the turn read.
    expect(await agentReplyScopes(otherThreadId)).toEqual([[ALPHA]])
  })

  // 2026-11-03 (scope-taint.ts, rule 11): a post some participant could not read does not land
  // hidden. It parks for the requester, who holds what the turn read; approving it discloses
  // the message to the thread's people.
  // A group: a direct message never parks (rule 14c, 2026-11-12).
  test("a threads_reply post some participant cannot read parks for the requester, and approving it shows it to them", async () => {
    const requester = await userWith([ALPHA, "kernel:threads:write"])
    const bob = await userWith([BETA])
    const dan = await userWith([BETA])
    const threadId = await seedThread("thread", requester, [requester])
    const sharedThreadId = await seedThread("thread", requester, [requester, bob, dan])
    const outputs: unknown[] = []
    AgentServiceTestAccess.setStreamText(
      toolCallingStreamText([
        "esc__alphaTool",
        {
          toolName: "kernel__threads_reply",
          input: { threadId: sharedThreadId, content: "posted from a scoped turn" },
        },
      ]) as never,
    )
    try {
      const result = await runAgentChat({
        threadId,
        content: "hello",
        actor: await actorFor(requester),
        orgId,
      })
      for await (const chunk of result.fullStream) {
        const c = chunk as { type?: string; output?: unknown }
        if (c.type === "tool-result") outputs.push(c.output)
      }
      await result.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      AgentServiceTestAccess.setStreamText(stubStreamText as never)
    }
    const parked = outputs[1] as { blocked?: boolean; approvalRequestId?: string }
    expect(JSON.stringify(parked)).not.toContain("E_SCOPE_TAINT_BLOCKED")
    expect(parked.blocked).toBe(true)
    expect(typeof parked.approvalRequestId).toBe("string")
    // Nothing was posted yet.
    expect(await agentReplyScopes(sharedThreadId)).toEqual([])
    const [row] = await sql<
      {
        summary: { lines?: string[] }
        metadata: { taintAudienceMustHold?: string[]; taintDisclosureAudience?: string[] }
      }[]
    >`SELECT summary, metadata FROM kernel.approval_requests WHERE id = ${parked.approvalRequestId!}`
    expect(JSON.stringify(row?.summary)).toContain(
      "2 people in this conversation cannot see esc data this conversation read: approving shares this message, and later ones like it here, with them.",
    )
    expect(row?.metadata.taintAudienceMustHold).toEqual([ALPHA])
    // Rule 11b: the people the post would reach, as they were when it parked.
    expect([...(row?.metadata.taintDisclosureAudience ?? [])].sort()).toEqual(
      [requester, bob, dan].sort(),
    )

    // The requester decides it: holding what the turn read is the deciding authority (rule 8h).
    const decided = await decideApproval({
      orgId,
      requestId: parked.approvalRequestId!,
      actor: await actorFor(requester),
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    expect(await agentReplyScopes(sharedThreadId)).toEqual([[ALPHA]])
    const visibleToBob = await withRlsContext(await actorFor(bob), async (tx) =>
      (
        await tx
          .select({ authorType: messages.authorType, content: messages.content })
          .from(messages)
          .where(eq(messages.threadId, sharedThreadId))
      ).filter((m) => m.authorType === "agent"),
    )
    expect(visibleToBob.map((m) => m.content)).toEqual(["posted from a scoped turn"])
    // Someone who joins later and lacks the scope does not read what was disclosed before them.
    const carol = await userWith([BETA])
    await withPrivilegedDb(orgId, "test-effective-scope-chat-join", (tx) =>
      tx.insert(threadParticipants).values({ threadId: sharedThreadId, userId: carol, orgId }),
    )
    const visibleToCarol = await withRlsContext(await actorFor(carol), async (tx) =>
      (
        await tx
          .select({ authorType: messages.authorType })
          .from(messages)
          .where(eq(messages.threadId, sharedThreadId))
      ).filter((m) => m.authorType === "agent"),
    )
    expect(visibleToCarol).toHaveLength(0)
  })

  test("a threads_reply post every participant can read runs inline", async () => {
    const requester = await userWith([ALPHA, "kernel:threads:write"])
    const bob = await userWith([ALPHA])
    const threadId = await seedThread("thread", requester, [requester])
    const sharedThreadId = await seedThread("thread", requester, [requester, bob])
    await frameOfToolTurn(threadId, await actorFor(requester), [
      "esc__alphaTool",
      {
        toolName: "kernel__threads_reply",
        input: { threadId: sharedThreadId, content: "everyone may read this" },
      },
    ])
    expect(await agentReplyScopes(sharedThreadId)).toEqual([[ALPHA]])
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests
      WHERE org_id = ${orgId} AND tool_name = 'kernel:threads_reply'
        AND thread_id = ${threadId}`
    expect(n).toBe(0)
  })

  test("a turn whose requester holds `*` never stamps `*` on what it posts", async () => {
    const requester = await userWith(["*"])
    const threadId = await seedThread("thread", requester, [requester])
    const otherThreadId = await seedThread("thread", requester, [requester])
    AgentServiceTestAccess.setStreamText(
      toolCallingStreamText([
        "esc__alphaTool",
        {
          toolName: "kernel__threads_reply",
          input: { threadId: otherThreadId, content: "posted by a wildcard holder" },
        },
      ]) as never,
    )
    try {
      const result = await runAgentChat({
        threadId,
        content: "hello",
        actor: await actorFor(requester),
        orgId,
      })
      for await (const _chunk of result.fullStream) {
        // drained
      }
      // No text after a tool call: an abnormal end, widened to the turn's whole effective scope.
      await result.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "stop",
        text: "",
        steps: [],
      })
    } finally {
      AgentServiceTestAccess.setStreamText(stubStreamText as never)
      // A `*` holder decides every later case's approvals: it must not outlive this one.
      await minimal.revokeScope(requester, "*")
    }
    const stamps = await agentReplyScopes(otherThreadId)
    expect(stamps).toHaveLength(1)
    expect(stamps[0]).toContain(ALPHA)
    expect((stamps[0] ?? []).filter((s) => s.split(":").includes("*"))).toEqual([])
    // And the stop notice the turn itself ends with, widened to `*`: expanded, never `*`.
    const ending = await agentReplyScopes(threadId)
    expect(ending.length).toBeGreaterThan(0)
    for (const stamp of ending) {
      expect(stamp.filter((s) => s.split(":").includes("*"))).toEqual([])
      expect(stamp).toContain(ALPHA)
    }
  })

  // threads_create declares its real sink (2026-09-25): the initial message is a
  // kernel.messages row, stamped with what the turn read exactly like threads_reply.
  // 2026-11-03 (rule 11): it used to land hidden from a member lacking the scope; it now
  // parks for the requester instead, so nothing reaches the thread before a decision. A direct
  // message never parks (rule 14c, 2026-11-12): the next test.
  test("a threads_create after a scoped read, to a member lacking the scope, parks instead of posting hidden", async () => {
    const requester = await userWith([ALPHA, "kernel:threads:write"])
    const bob = await userWith([BETA])
    const dan = await userWith([BETA])
    const threadId = await seedThread("thread", requester, [requester])
    const existingThreadId = await seedThread("thread", requester, [requester, bob, dan])

    await frameOfToolTurn(threadId, await actorFor(requester), [
      "esc__alphaTool",
      {
        toolName: "kernel__threads_create",
        input: { participantIds: [bob, dan], initialMessage: "forwarded from a scoped turn" },
      },
    ])

    expect(await agentReplyScopes(existingThreadId)).toEqual([])
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests
      WHERE org_id = ${orgId} AND tool_name = 'kernel:threads_create' AND status = 'pending'
        AND requested_by = ${requester}`
    expect(n).toBe(1)
    const visibleToBob = await withRlsContext(await actorFor(bob), async (tx) =>
      (
        await tx
          .select({ authorType: messages.authorType })
          .from(messages)
          .where(eq(messages.threadId, existingThreadId))
      ).filter((m) => m.authorType === "agent"),
    )
    expect(visibleToBob).toHaveLength(0)
  })

  test("a threads_create DM after a scoped read posts inline and its addressee reads it", async () => {
    const requester = await userWith([ALPHA, "kernel:threads:write"])
    const bob = await userWith([BETA])
    const threadId = await seedThread("thread", requester, [requester])
    const dmId = await seedThread("thread", requester, [requester, bob])

    await frameOfToolTurn(threadId, await actorFor(requester), [
      "esc__alphaTool",
      {
        toolName: "kernel__threads_create",
        input: { participantIds: [bob], initialMessage: "told bob directly" },
      },
    ])

    expect(await agentReplyScopes(dmId)).toEqual([[ALPHA]])
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests
      WHERE org_id = ${orgId} AND tool_name = 'kernel:threads_create' AND requested_by = ${requester}`
    expect(n).toBe(0)
    const visibleToBob = await withRlsContext(await actorFor(bob), async (tx) =>
      (
        await tx
          .select({ authorType: messages.authorType, content: messages.content })
          .from(messages)
          .where(eq(messages.threadId, dmId))
      ).filter((m) => m.authorType === "agent"),
    )
    expect(visibleToBob.map((m) => m.content)).toEqual(["told bob directly"])
  })

  // The withheld card must not offer "Share anyway" on a turn a rerun would
  // refuse for the same reason. The taint is discovered by the REAL tool
  // bridge here, carried on the run frame, and read where the block is built.
  test("a turn refused by scope taint marks every withheld item on the stored reply", async () => {
    const alice = await userWith([ALPHA, SHARED, "kernel:threads:write"])
    const bob = await userWith([SHARED, "kernel:threads:write"])
    // The ceiling holds ALPHA, the room floor does not: ALPHA is withheld.
    await seedPersonalAgent(alice, [ALPHA, SHARED, "kernel:threads:write"])
    const threadId = await seedThread("thread", alice, [alice, bob])

    // Rule 8: the tainted gated write is refused only when nobody who may decide it (esc:approve)
    // holds the taint, so the org's admins (who hold every scope) step out of the admin role for
    // this turn. Neither alice nor bob holds esc:approve.
    const admins = await sql<{ user_id: string }[]>`
      SELECT ur.user_id FROM kernel.user_roles ur JOIN kernel.roles r ON r.id = ur.role_id
      WHERE r.org_id = ${orgId} AND r.name = 'admin'`
    for (const { user_id } of admins) await minimal.revokeRole(user_id, "admin")
    let frame: RunContext
    try {
      frame = await frameOfToolTurn(threadId, await actorFor(alice), [
        // A scoped read taints the turn, then a gated write nobody may decide is refused.
        // (threads_create used to be that write; it now declares kernel.messages.)
        "esc__sharedTool",
        "esc__sharedWrite",
      ])
    } finally {
      for (const { user_id } of admins) await minimal.privilegedAssignRole(user_id, "admin")
    }
    expect(frame.withheld).toEqual([ALPHA])
    expect(frame.scopeTaintRefused).toBe(true)

    const [reply] = await sql<{ metadata: Record<string, unknown> | null }[]>`
      SELECT metadata FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent'
      ORDER BY created_at DESC LIMIT 1`
    const withheld = (reply?.metadata as { withheld?: { items: Array<Record<string, unknown>> } })
      ?.withheld
    expect(withheld?.items.length).toBeGreaterThan(0)
    expect(withheld?.items.every((i) => i.scopeTainted === true)).toBe(true)
    // And the raw scope never rides along on the room's own row.
    expect(JSON.stringify(withheld)).not.toContain(ALPHA)
  })

  // The card must not offer a Share anyway the server gate then refuses. The
  // gate reads the ceiling entries the requester's DM scope leaves out on their
  // exact strings, so a glob ceiling over a closed scope refuses the share even
  // though the room only took a concrete scope the requester holds.
  test("a withheld card closes Share anyway when the server gate would refuse it", async () => {
    const alice = await userWith([ALPHA, SHARED, "kernel:threads:write"])
    const bob = await userWith([SHARED, "kernel:threads:write"])
    await seedPersonalAgent(alice, ["esc:*", "kernel:threads:write"])
    const threadId = await seedThread("thread", alice, [alice, bob])
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
      VALUES (${orgId}, 'esc:vault:read', false)
      ON CONFLICT DO NOTHING`
    try {
      const frame = await frameOfToolTurn(threadId, await actorFor(alice), ["esc__sharedTool"])
      expect(frame.withheld).toEqual([ALPHA])

      const [reply] = await sql<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata FROM kernel.messages
        WHERE thread_id = ${threadId} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1`
      const items = (reply?.metadata as { withheld?: { items: Array<Record<string, unknown>> } })
        ?.withheld?.items
      expect(items?.length).toBeGreaterThan(0)
      expect(items?.every((i) => i.nonDisclosable === true)).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.scope_disclosure_policy WHERE org_id = ${orgId} AND scope = 'esc:vault:read'`
    }
  })
})

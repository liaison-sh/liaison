// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Share anyway" wired end to end (spec-security.md D2, D4, A14): a channel
// turn whose room floor withheld the agent's capabilities puts the raw
// withheld list on its run frame and hands the requester only category labels;
// Share anyway then reruns that turn through the real agent entry point at
// `ceiling ∩ requester`, and the shared message carries the rerun's scopes and
// the disclosure snapshot, on the row and on its create event.
//
// The model is a scripted stream stub; everything else (tool catalog, scope
// accumulator, persistence, RLS) is the real code path.

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
import * as eventBusModule from "~/infra/events/event-bus"
import {
  AgentServiceTestAccess,
  invokeAgentForThread,
  runAgentChat,
} from "~/modules/agent/runtime/agent-service"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { GENERIC_WITHHELD_LABEL } from "~/modules/agent/scopes/withheld-capability"
import * as toolBridgeModule from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { shareAnyway } from "~/services/security/share-anyway"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-share-anyway-wired"
const NIL_UUID = "00000000-0000-0000-0000-000000000000"
// A distinctive app name, so any leak of it into a room artifact is unambiguous.
const APP = "wzq"
const A = `${APP}:alpha:read`
const B = `${APP}:beta:read`
const C = `${APP}:gamma:read`
const CEILING = [A, B]
const TOOLS = { alphaTool: A, betaTool: B, gammaTool: C }

type ToolCall = string | { toolName: string; input: unknown }
type ScriptedTurn = { calls: ToolCall[]; text: string }

/** Turns the stub model plays, in order; an empty script answers "ok". */
const script: ScriptedTurn[] = []
/** What each model call was handed. */
const seen: Array<{ tools: string[]; system: unknown; messages: unknown }> = []

function scriptedStreamText(opts: {
  tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>
  system?: unknown
  messages?: unknown
}) {
  const turn = script.shift() ?? { calls: [], text: "ok" }
  seen.push({ tools: Object.keys(opts.tools ?? {}), system: opts.system, messages: opts.messages })
  return {
    fullStream: (async function* () {
      for (const [i, call] of turn.calls.entries()) {
        const { toolName, input } = typeof call === "string" ? { toolName: call, input: {} } : call
        const toolDef = opts.tools?.[toolName]
        if (!toolDef?.execute) throw new Error(`${toolName} is not in the turn tool set`)
        const toolCallId = `call-wired-${i}`
        yield { type: "tool-call", toolCallId, toolName, input }
        const output = await toolDef.execute(input)
        yield { type: "tool-result", toolCallId, toolName, input, output }
      }
      yield { type: "text-delta", text: turn.text }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  }
}

describe("Share anyway wired through the agent entry point", () => {
  let orgId: string
  let requester: string // holds A and C
  let lacker: string // member at share time, holds nothing
  let late: string // joins after the share, holds nothing
  let agentId: string
  let threadId: string

  async function userWith(scopes: string[]): Promise<string> {
    const user = await minimal.person(orgId)
    await minimal.revokeRole(user.id, "member")
    for (const scope of scopes) await minimal.grantScope(user.id, scope)
    return user.id
  }

  async function actorFor(userId: string): Promise<UserContext> {
    const { scopes } = await withPrivilegedDb(orgId, "test-share-anyway-wired-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  }

  async function post(userId: string, content: string): Promise<string> {
    const msg = await withPrivilegedDb(orgId, "test-share-anyway-wired-post", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId,
        threadId,
        content,
        authorType: "user",
      }),
    )
    if (!msg) throw new Error("could not post into the test thread")
    return msg.id
  }

  async function visibleIds(userId: string): Promise<string[]> {
    return withRlsContext(await actorFor(userId), async (tx) =>
      (
        await tx.select({ id: messages.id }).from(messages).where(eq(messages.threadId, threadId))
      ).map((r) => r.id),
    )
  }

  async function agentMessageCount(): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent'`
    return row?.n ?? -1
  }

  /**
   * The org's events queued before the turns: setup's own (the admin's scope
   * grants to the test people), which no room sees.
   */
  let setupEventIds: string[] = []

  /** Every room-visible artifact of the thread, serialized: stored messages and queued events. */
  async function roomArtifacts(): Promise<string[]> {
    const rows = await sql<{ content: string; metadata: unknown }[]>`
      SELECT content, metadata FROM kernel.messages WHERE thread_id = ${threadId}`
    const events = await sql<{ payload: unknown }[]>`
      SELECT payload FROM kernel.pending_events WHERE org_id = ${orgId} AND NOT (id = ANY(${setupEventIds}::uuid[]))`
    return [
      ...rows.map((r) => JSON.stringify({ content: r.content, metadata: r.metadata })),
      ...events.map((e) => JSON.stringify(e.payload)),
    ]
  }

  function wzqTools(names: string[]): string[] {
    return names.filter((n) => n.startsWith(`${APP}__`)).sort()
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(scriptedStreamText as never)
    orgId = (await createTestOrg()).id
    for (const [name, scope] of Object.entries(TOOLS)) {
      toolRegistry.set([orgId, APP, name], {
        appName: APP,
        name,
        description: "Share anyway probe",
        requiredScopes: [scope],
        // Read probes. They stand in for the reads the room floor denied, and
        // a rerun admits only `readOnly` tools (FX7), so the marker is what
        // keeps them in the rerun's catalog.
        readOnly: true,
        handler: async () => ({ ok: true }),
        params: z.object({}),
      })
    }
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Share Anyway', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`

    requester = await userWith([A, C])
    lacker = await userWith([])
    late = await userWith([])
    agentId = await withPrivilegedDb(orgId, "test-share-anyway-wired-agent", async (tx) => {
      // The requester's own personal agent (registration made it), capped to
      // the ceiling: the agent a channel turn resolves for them.
      const [a] = await tx
        .update(agents)
        .set({ scopeCeiling: CEILING })
        .where(and(eq(agents.ownerUserId, requester), eq(agents.kind, "personal")))
        .returning({ id: agents.id })
      if (!a) throw new Error("the requester has no personal agent")
      return a.id
    })
    threadId = await withPrivilegedDb(orgId, "test-share-anyway-wired-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `wired-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy: requester,
        })
        .returning({ id: threads.id })
      for (const userId of [requester, lacker]) {
        await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      }
      return t.id
    })
    setupEventIds = (
      await sql<{ id: string }[]>`SELECT id FROM kernel.pending_events WHERE org_id = ${orgId}`
    ).map((r) => r.id)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([orgId, APP])
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  let turnId = ""

  test("a withheld channel turn carries the raw list on its run frame and returns only category labels", async () => {
    turnId = await post(requester, "@Liaison show the deal")
    script.push({ calls: [], text: "Some capabilities are unavailable here." })
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
    const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral")
    let frame: RunContext | undefined
    let outcome: { withheldCapabilities?: string[] }
    let broadcasts: unknown[]
    try {
      outcome = await invokeAgentForThread(threadId, turnId, await actorFor(requester), orgId)
      frame = buildSpy.mock.calls[0]?.[5]
      broadcasts = broadcastSpy.mock.calls.map(([e]) => e)
    } finally {
      buildSpy.mockRestore()
      broadcastSpy.mockRestore()
    }

    // The lacker floors the room to nothing. Withheld is what the requester
    // would have had in a DM: A. B was never theirs, so the room took nothing.
    expect(frame?.effectiveScope).toEqual([])
    expect(frame?.withheld).toEqual([A])
    // The requester's card gets categories only, never the scope or app names.
    expect(outcome.withheldCapabilities).toEqual([GENERIC_WITHHELD_LABEL])

    // No room artifact (stored message, queued event, live broadcast) and no
    // model context names a withheld scope or its app.
    expect(broadcasts.length).toBeGreaterThan(0)
    const room = [...(await roomArtifacts()), ...broadcasts.map((e) => JSON.stringify(e))]
    for (const artifact of room) {
      expect(artifact.includes(APP)).toBe(false)
    }
    const modelContext = JSON.stringify(seen.at(-1))
    expect(modelContext.includes(A)).toBe(false)
    expect(modelContext.includes(B)).toBe(false)
  })

  test("a scope override wider than ceiling and requester, or than the actor scopes, refuses the turn", async () => {
    const before = await agentMessageCount()
    const actor = await actorFor(requester)
    const rerun = (a: UserContext, effectiveScope: string[], overrideAgentId = agentId) =>
      runAgentChat({
        threadId,
        content: "",
        actor: a,
        orgId,
        skipUserPersist: true,
        userMessageId: turnId,
        scopeOverride: { agentId: overrideAgentId, effectiveScope },
        persistReply: false,
      })

    // B is in the ceiling but not in the requester's grants.
    await expect(rerun(actor, [A, B])).rejects.toThrow(/E_SCOPE_OVERRIDE_REFUSED/)
    // A glob wider than both sides.
    await expect(rerun(actor, [`${APP}:*`])).rejects.toThrow(/E_SCOPE_OVERRIDE_REFUSED/)
    // The actor carries less than its stored grants into this turn.
    await expect(rerun({ ...actor, scopes: [C] }, [A])).rejects.toThrow(/E_SCOPE_OVERRIDE_REFUSED/)
    // An agent that is not a live agent of this org.
    await expect(rerun(actor, [A], crypto.randomUUID())).rejects.toThrow(/E_SCOPE_OVERRIDE_REFUSED/)
    expect(script).toHaveLength(0)
    expect(await agentMessageCount()).toBe(before)
  })

  test("a non-persisting rerun returns the reply and its scopes and writes nothing to the room", async () => {
    const before = await agentMessageCount()
    script.push({ calls: [`${APP}__alphaTool`], text: "rerun reply" })
    const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral")
    let reply: unknown
    let broadcastCount = -1
    try {
      const chat = await runAgentChat({
        threadId,
        content: "",
        actor: await actorFor(requester),
        orgId,
        skipUserPersist: true,
        userMessageId: turnId,
        scopeOverride: { agentId, effectiveScope: [A] },
        persistReply: false,
      })
      for await (const _chunk of chat.fullStream) {
        // drain: the stub runs the tool inside the stream
      }
      const done = await chat.finalize({
        usage: { promptTokens: 10, completionTokens: 1 },
        finishReason: "stop",
        text: "rerun reply",
        steps: [],
      })
      expect(done.messageId).toBeNull()
      reply = done.reply
      broadcastCount = broadcastSpy.mock.calls.length
    } finally {
      broadcastSpy.mockRestore()
    }
    expect(reply).toMatchObject({ content: "rerun reply", requiredScopes: [A] })
    expect(broadcastCount).toBe(0)
    expect(await agentMessageCount()).toBe(before)
  })

  test("Share anyway through the real rerun stores the shared scope and the disclosure list, and the create event carries both", async () => {
    const before = await agentMessageCount()
    script.push({ calls: [`${APP}__alphaTool`], text: "The deal is 42." })
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
    const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral")
    let messageIds: string[]
    let rerunFrame: RunContext | undefined
    let rerunCatalog: Record<string, unknown> = {}
    let broadcastCount = -1
    try {
      ;({ messageIds } = await shareAnyway(await actorFor(requester), {
        turnId,
        requesterId: requester,
        roomId: threadId,
        agentId,
      }))
      rerunFrame = buildSpy.mock.calls[0]?.[5]
      rerunCatalog = (buildSpy.mock.results[0]?.value ?? {}) as Record<string, unknown>
      broadcastCount = broadcastSpy.mock.calls.length
    } finally {
      buildSpy.mockRestore()
      broadcastSpy.mockRestore()
    }
    expect(messageIds).toHaveLength(1)
    const sharedId = messageIds[0] ?? ""

    // The rerun ran as the named agent at ceiling ∩ requester, not the room floor.
    expect(rerunFrame?.agentId).toBe(agentId)
    expect(rerunFrame?.effectiveScope).toEqual([A])
    expect(wzqTools(Object.keys(rerunCatalog))).toEqual([`${APP}__alphaTool`])
    // Its model context ends at the requester's turn: the withheld reply written
    // after it is not in the history, and no assistant message follows the turn.
    const rerunMessages = seen.at(-1)?.messages as Array<{ role: string; content: unknown }>
    const turnIdx = rerunMessages.findIndex((m) =>
      JSON.stringify(m.content).includes("show the deal"),
    )
    expect(turnIdx).toBeGreaterThanOrEqual(0)
    expect(rerunMessages.slice(turnIdx + 1).filter((m) => m.role === "assistant")).toEqual([])
    expect(JSON.stringify(rerunMessages)).not.toContain("Some capabilities are unavailable here.")
    // The rerun itself is invisible to the room: no stream, typing or reply broadcast.
    expect(broadcastCount).toBe(0)

    // Exactly one new agent message: the shared one.
    expect(await agentMessageCount()).toBe(before + 1)
    const [row] = await sql<
      {
        content: string
        author_type: string
        required_scopes: string[]
        disclosure_list: string[] | null
      }[]
    >`SELECT content, author_type, required_scopes, disclosure_list FROM kernel.messages
      WHERE id = ${sharedId}`
    expect(row?.content).toBe("The deal is 42.")
    expect(row?.author_type).toBe("agent")
    expect(row?.required_scopes).toEqual([A])
    expect([...(row?.disclosure_list ?? [])].sort()).toEqual([requester, lacker].sort())

    // The create event carries the disclosure list for the live fan-out.
    const events = await sql<{ payload: any }[]>`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entityId' = ${sharedId}`
    const created = events
      .map((e) => e.payload)
      .find((p) => p?.entity === "message" && p?.action === "create")
    expect(created?.data?.requiredScopes).toEqual([A])
    expect([...(created?.data?.disclosureList ?? [])].sort()).toEqual([requester, lacker].sort())

    // Visibility through the real messages RLS: the requester and the disclosed
    // member see it; a member added afterwards does not.
    await withPrivilegedDb(orgId, "test-share-anyway-wired-late", (tx) =>
      tx.insert(threadParticipants).values({ threadId, userId: late, orgId }),
    )
    expect(await visibleIds(requester)).toContain(sharedId)
    expect(await visibleIds(lacker)).toContain(sharedId)
    expect(await visibleIds(late)).not.toContain(sharedId)
    // Control: the late member reads the room, so it is the scope that hides it.
    expect(await visibleIds(late)).toContain(turnId)
  })

  test("sendMessage refuses a disclosure list holding the NIL uuid or a non-uuid", async () => {
    const send = (disclosureList: string[]) =>
      withPrivilegedDb(orgId, "test-share-anyway-wired-nil", (tx) =>
        sendMessage(tx as unknown as RlsClient, {
          requiredScopes: [A],
          orgId,
          userId: requester,
          threadId,
          content: "nil probe",
          authorType: "agent",
          disclosureList,
        }),
      )
    await expect(send([requester, NIL_UUID])).rejects.toThrow(/E_DISCLOSURE_INVALID_MEMBER/)
    await expect(send(["system"])).rejects.toThrow(/E_DISCLOSURE_INVALID_MEMBER/)
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
      WHERE thread_id = ${threadId} AND content = 'nil probe'`
    expect(row?.n).toBe(0)
  })
})

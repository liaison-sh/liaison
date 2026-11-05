// SPDX-License-Identifier: FSL-1.1-ALv2
// A durable agent turn (P3 T10-T12, S10 / A8), driven through the real agent
// loop (runAgentChat, tool bridge, effect ledger) with the scripted provider:
// only the model's tokens are scripted.
//
//  - every complete step is journaled with the SDK's own response messages,
//    and each write tool call is keyed `tool:<turn>:<tool>:<argsHash>:<n>`;
//  - a draining process hands the turn off at the step boundary, and the
//    resume finishes it once: one reply, no write effect doubled;
//  - a write whose claimer died mid-call answers "outcome unknown", and an
//    identical re-call in the same turn gets the same answer (sticky);
//  - a resume of a person who was deactivated in between ends `failed`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { and, eq, like } from "drizzle-orm"
import { z } from "zod"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { effectLedger } from "~/db/schema/kernel"
import * as eventBusModule from "~/infra/events/event-bus"
import { INSTANCE_ID } from "~/infra/instance-id"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { setDraining } from "~/lib/readiness"
import * as shutdownModule from "~/lib/shutdown"
import * as mailRedaction from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import * as mailboxContext from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-context"
import {
  clearScriptedTurns,
  setScriptedTurn,
} from "~/modules/agent/providers/scripted-model-provider"
import { reattachTiming } from "~/modules/agent/routes"
import { invokeAgentForThread, runAgentChat } from "~/modules/agent/runtime/agent-service"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { toolEffectKey } from "~/modules/agent/runtime/tool-effect-key"
import { handOffRunningTurns, TurnHandoffTestAccess } from "~/modules/agent/runtime/turn-handoff"
import { parseJournal } from "~/modules/agent/runtime/turn-journal"
import {
  finishTurn,
  loadTurn,
  openTurn,
  TURN_STALE_AFTER_MS,
} from "~/modules/agent/runtime/turn-ledger"
import {
  resumeTurn,
  sweepOrphanTurns,
  TurnResumeTestAccess,
} from "~/modules/agent/runtime/turn-resume"
import {
  EFFECT_IN_FLIGHT_CODE,
  OUTCOME_UNKNOWN_CODE,
  ToolBridgeEffectTestAccess,
} from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { hashParams } from "~/modules/apps/idempotency"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  effectCount,
  registerTestEffectTools,
  TEST_EFFECT_TOOLS,
} from "../../../../test-support/harness/test-effect-tools"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const ORIG_PROVIDER = process.env.LIAISON_MODEL_PROVIDER

const EFFECT_THEN_WAIT = "kernel__test_effect_then_wait"
/**
 * A write that counts in this process (the journal test needs no second process).
 */
const COUNTER = "kernel__test_turn_counter"
const counted = new Map<string, number>()
/**
 * A tool that records the run frame it ran in: the restrictions a resumed
 * attempt runs under, as its tools see them (H1).
 */
const PROBE = "kernel__test_turn_probe"
interface ProbeSeen {
  sessionRestricted: boolean
  coordinated: boolean
  humanTurn: boolean
  effectiveScope: string[] | null
}
const probed = new Map<string, ProbeSeen>()
/** A read whose big result the stale-result clipper clips (H3). */
const BIG_READ = "kernel__test_turn_big_read"
/** What the big read's document starts with (never in the call's args). */
let bigReadMarker = ""

let owner: minimal.Session
let agentId: string
let threadId: string
/** The owner's own permissions, as the chat route hands them to a turn. */
let ownerScopes: string[] = []

interface TurnTrace {
  text: string
  results: Array<{ toolName: string; output: unknown }>
}

/** Consume a turn's stream the way the chat route does, then finalize it. */
async function drive(r: Awaited<ReturnType<typeof runAgentChat>>): Promise<TurnTrace> {
  const trace: TurnTrace = { text: "", results: [] }
  const steps: Array<{
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
    toolResults?: Array<{ toolCallId: string; result: unknown }>
  }> = []
  let calls: Array<{ toolCallId: string; toolName: string; args: unknown }> = []
  let results: Array<{ toolCallId: string; result: unknown }> = []
  for await (const part of r.fullStream) {
    if (part.type === "text-delta") trace.text += part.text
    if (part.type === "tool-call") {
      calls.push({ toolCallId: part.toolCallId, toolName: part.toolName, args: part.input })
    }
    if (part.type === "tool-result") {
      trace.results.push({ toolName: part.toolName, output: part.output })
      results.push({ toolCallId: part.toolCallId, result: part.output })
    }
    if (part.type === "finish-step") {
      steps.push({
        toolCalls: calls.length ? calls : undefined,
        toolResults: results.length ? results : undefined,
      })
      calls = []
      results = []
    }
  }
  await r.finalize({
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: "stop",
    text: trace.text,
    steps,
  })
  return trace
}

/**
 * A turn of the owner. `scopes` defaults to the wildcard (a turn with no other
 * person's audience to consider); a turn that is resumed starts with the
 * owner's real permissions, because the resume re-reads them (M11).
 */
const turn = (content: string, scopes: string[] = ["*"]) => ({
  threadId,
  content,
  actor: {
    actorType: "user" as const,
    userId: owner.userId,
    orgId: owner.orgId,
    scopes,
    dimensionGrants: {},
  },
  orgId: owner.orgId,
  actingAgentId: agentId,
})

async function freshThread(): Promise<void> {
  threadId = await minimal.thread(owner.orgId, owner.userId)
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${threadId}, ${agentId}, ${owner.orgId}, 'agent')`
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v) || Date.now() > end) return v
    await Bun.sleep(50)
  }
}

const turnRow = async (turnId: string) => {
  const [row] = await sql<
    { state: string; step_count: number; attempt: number; agent_message_id: string | null }[]
  >`SELECT state, step_count, attempt, agent_message_id FROM kernel.agent_turns WHERE id = ${turnId}`
  return row
}

const turnOfThread = async () => {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM kernel.agent_turns WHERE thread_id = ${threadId} ORDER BY created_at DESC LIMIT 1`
  return row?.id ?? null
}

const agentReplies = async () =>
  sql<{ id: string; content: string }[]>`
    SELECT id, content FROM kernel.messages
    WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`

/** The frames of an SSE body, in order. */
function sseFrames(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split("\n\n")
    .map((part) => {
      const event = /^event: (.*)$/m.exec(part)?.[1]
      const data = /^data: (.*)$/m.exec(part)?.[1]
      return event && data ? { event, data: JSON.parse(data) as Record<string, unknown> } : null
    })
    .filter((f): f is { event: string; data: Record<string, unknown> } => f !== null)
}

/** The ledger rows of a turn's write tool calls. */
async function ledgerRows(turnId: string) {
  return withPrivilegedDb(owner.orgId, "test:turn-resume-ledger", (tx) =>
    tx
      .select({ key: effectLedger.key, state: effectLedger.state })
      .from(effectLedger)
      .where(and(eq(effectLedger.orgId, owner.orgId), like(effectLedger.key, `tool:${turnId}:%`)))
      .orderBy(effectLedger.key),
  )
}

describe("a durable agent turn", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    process.env.LIAISON_MODEL_PROVIDER = "scripted"
    owner = await minimal.adminSession((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@tr-${crypto.randomUUID().slice(0, 8)}`}, 'Sam',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${owner.orgId}, '10.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
    registerTestEffectTools(owner.orgId)
    toolRegistry.set([owner.orgId, "kernel", "test_turn_counter"], {
      appName: "kernel",
      name: "test_turn_counter",
      description: "Test only: count one effect under key.",
      // The public web's scope: no org data, so nothing for a later write to leak.
      requiredScopes: ["kernel:agent:web"],
      params: z.object({ key: z.string() }),
      handler: async (raw: unknown) => {
        const { key } = z.object({ key: z.string() }).parse(raw)
        const count = (counted.get(key) ?? 0) + 1
        counted.set(key, count)
        return { key, count }
      },
    })
    toolRegistry.set([owner.orgId, "kernel", "test_turn_probe"], {
      appName: "kernel",
      name: "test_turn_probe",
      description: "Test only: record the run frame this call ran in.",
      requiredScopes: ["kernel:agent:web"],
      // It changes nothing outside this test: never gated, never on the ledger.
      readOnly: true,
      params: z.object({ key: z.string() }),
      handler: async (raw: unknown) => {
        const { key } = z.object({ key: z.string() }).parse(raw)
        const frame = currentRunContext()
        probed.set(key, {
          sessionRestricted: frame?.sessionRestricted === true,
          coordinated: frame?.coordinated === true,
          humanTurn: frame?.humanTurn === true,
          effectiveScope: frame?.effectiveScope ? [...frame.effectiveScope] : null,
        })
        return { key }
      },
    })
    toolRegistry.set([owner.orgId, "kernel", "test_turn_big_read"], {
      appName: "kernel",
      name: "test_turn_big_read",
      description: "Test only: read a big document.",
      requiredScopes: ["kernel:agent:web"],
      readOnly: true,
      params: z.object({ n: z.number() }),
      handler: async (raw: unknown) => {
        const { n } = z.object({ n: z.number() }).parse(raw)
        return { n, body: `${bigReadMarker} ${"x".repeat(30_000)}` }
      },
    })
    const perms = await withPrivilegedDb(owner.orgId, "test:turn-resume-owner", (tx) =>
      loadEffectivePermissions(tx, owner.userId, owner.orgId),
    )
    ownerScopes = perms.scopes
  })

  // A drain hands off every turn registered in this process: start from none,
  // whatever an earlier file in the same run left behind.
  beforeEach(() => {
    TurnHandoffTestAccess.clear()
  })

  afterEach(async () => {
    await clearScriptedTurns(threadId)
    TurnHandoffTestAccess.clear()
    ToolBridgeEffectTestAccess.setInFlightWaitMs(null)
  })

  afterAll(async () => {
    for (const name of TEST_EFFECT_TOOLS) toolRegistry.delete([owner.orgId, "kernel", name])
    toolRegistry.delete([owner.orgId, "kernel", "test_turn_counter"])
    toolRegistry.delete([owner.orgId, "kernel", "test_turn_probe"])
    toolRegistry.delete([owner.orgId, "kernel", "test_turn_big_read"])
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    if (ORIG_PROVIDER !== undefined) process.env.LIAISON_MODEL_PROVIDER = ORIG_PROVIDER
    else delete process.env.LIAISON_MODEL_PROVIDER
    broadcastSpy.mockRestore()
    await releaseTestLock()
  })

  it("journals every complete step with the SDK's messages and keys its write in the effect ledger", async () => {
    await freshThread()
    const key = `journal-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: COUNTER, args: { key } }] },
      { toolCalls: [{ name: "kernel__tool_search", args: { query: key } }] },
      // Step 3 waits before it answers, so the journal of steps 1-2 can be read.
      { text: "Recorded.", delayMs: 800 },
    ])
    const r = await runAgentChat(turn("record it"))
    const driving = drive(r)
    // The journal is privileged bookkeeping (RLS forced, no policy): read it as the ledger does.
    const journal = async () => parseJournal((await loadTurn(owner.orgId, r.turnId))?.steps ?? [])
    const events = await until(journal, (steps) => steps.length >= 2)
    // While the turn runs, its write is on the ledger under its turn key.
    const ledgerWhileRunning = await ledgerRows(r.turnId)
    const trace = await driving
    expect(trace.text).toBe("Recorded.")

    const row = await turnRow(r.turnId)
    expect({ state: row.state, steps: row.step_count, attempt: row.attempt }).toEqual({
      state: "done",
      steps: 3,
      attempt: 0,
    })
    const replies = await agentReplies()
    expect(replies.length).toBe(1)
    expect(row.agent_message_id).toBe(replies[0].id)

    // Steps 1-2 as the SDK produced them: each an assistant tool call and its tool result.
    expect(events.map((e) => [e.stepIndex, e.messages.map((m) => m.role)])).toEqual([
      [1, ["assistant", "tool"]],
      [2, ["assistant", "tool"]],
    ])
    expect(JSON.stringify(events[0].messages[0].content)).toContain(key)
    expect(JSON.stringify(events[0].messages[1].content)).toContain('"count":1')
    // A finished turn keeps no journal.
    expect(await journal()).toEqual([])

    // The write ran once, claimed under its turn key and marked done; the
    // read-only search took no ledger row.
    expect(counted.get(key)).toBe(1)
    expect(ledgerWhileRunning).toEqual([
      {
        key: toolEffectKey(r.turnId, "kernel:test_turn_counter", hashParams({ key }), 1),
        state: "done",
      },
    ])
    // M4: a finished turn keeps none of its write results either.
    expect(await ledgerRows(r.turnId)).toEqual([])
  })

  it("a draining process hands the turn off at the step boundary; the resume finishes it once, no write doubled", async () => {
    await freshThread()
    const first = `handoff-a-${crypto.randomUUID()}`
    const query = `handoff-search-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key: first } }], toolDelayMs: 600 },
      { toolCalls: [{ name: "kernel__tool_search", args: { query } }] },
      { text: "Recorded." },
    ])
    const r = await runAgentChat(turn("record it", ownerScopes))
    const driving = drive(r)
    // The drain arrives while step 1's write is running.
    await until(
      () => effectCount(first),
      (n) => n === 1,
    )
    const drained = handOffRunningTurns(10_000, 2_000)
    const trace = await driving
    expect((await drained).unsettled).toEqual([])
    expect(r.turnHandoff()).toBe(true)
    // The first process stopped at the boundary: step 1 journaled, step 2 not run.
    expect(trace.text).toBe("")
    const handed = await turnRow(r.turnId)
    expect({ state: handed.state, steps: handed.step_count }).toEqual({
      state: "handoff",
      steps: 1,
    })
    expect((await agentReplies()).length).toBe(0)

    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("resumed")
    const done = await until(
      () => turnRow(r.turnId),
      (row) => row.state === "done",
    )
    expect({ state: done.state, steps: done.step_count, attempt: done.attempt }).toEqual({
      state: "done",
      steps: 3,
      attempt: 1,
    })
    const replies = await agentReplies()
    expect(replies.map((m) => m.content)).toEqual(["Recorded."])
    expect(done.agent_message_id).toBe(replies[0].id)
    // The write of the complete step 1 is not run again by the resume.
    expect(await effectCount(first)).toBe(1)
    // The one reply carries all three steps: step 1 from the first process.
    const [reply] = await sql<
      { metadata: { toolCalls?: Array<{ toolName: string; status: string }> } }[]
    >`
      SELECT metadata FROM kernel.messages WHERE id = ${replies[0].id}`
    expect((reply.metadata.toolCalls ?? []).map((c) => [c.toolName, c.status])).toEqual([
      [EFFECT_THEN_WAIT, "completed"],
      ["kernel__tool_search", "completed"],
    ])
    // A second resume of the finished turn does nothing.
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("gone")
    expect((await agentReplies()).length).toBe(1)
  })

  it("B4: a journaled turn that read decrypted mail holds no plaintext (raw, JSON-escaped, base64)", async () => {
    await freshThread()
    const marker = `PLAINTEXT-MARKER-${crypto.randomUUID()}`
    const body = `Subject: "Quarterly" \\ ${marker}\nline two`
    // The browser-decrypted mail rides every step's request tail (prepareStep).
    const mailSpy = spyOn(mailboxContext, "getEphemeralMailboxContext").mockImplementation(() => [
      `<mailbox_message>${body}</mailbox_message>`,
    ])
    try {
      await setScriptedTurn(threadId, [
        { toolCalls: [{ name: "kernel__tool_search", args: { query: "mail" } }] },
        { toolCalls: [{ name: COUNTER, args: { key: `b4-${marker.slice(-8)}` } }] },
        // Step 3 proves the model was shown the mail; it waits so steps 1-2 can be read.
        { echo: "PLAINTEXT-MARKER-[0-9a-f-]+", delayMs: 800 },
      ])
      const r = await runAgentChat(turn("summarize my mail"))
      const driving = drive(r)
      const journal = async () => (await loadTurn(owner.orgId, r.turnId))?.steps ?? []
      const rows = await until(journal, (steps) => steps.length >= 2)
      // The write's ledger row while the turn runs (a finished turn keeps none, M4).
      const ledger = await withPrivilegedDb(owner.orgId, "test:turn-resume-ledger", (tx) =>
        tx
          .select({ result: effectLedger.result })
          .from(effectLedger)
          .where(like(effectLedger.key, `tool:${r.turnId}:%`)),
      )
      const trace = await driving
      expect(trace.text).toBe(marker)
      expect(rows.length).toBe(2)
      // The rows as stored, and the steps parsed back out of them.
      const stored =
        JSON.stringify(rows.map((row) => row.payload)) + JSON.stringify(parseJournal(rows))
      for (const form of [
        marker,
        JSON.stringify(marker).slice(1, -1),
        JSON.stringify(body).slice(1, -1),
        Buffer.from(marker).toString("base64"),
        Buffer.from(body).toString("base64"),
      ]) {
        expect(stored.includes(form)).toBe(false)
      }
      // Nor does the effect ledger: the write's stored result is the tool's own.
      expect(ledger.length).toBe(1)
      expect(JSON.stringify(ledger).includes(marker)).toBe(false)
    } finally {
      mailSpy.mockRestore()
    }
  })

  it("a write whose claimer died answers outcome unknown, sticky for an identical re-call in the turn", async () => {
    await freshThread()
    const key = `unknown-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      // Step 1 waits before its call, so the test can plant the dead claim.
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], delayMs: 800 },
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }] },
      { text: "Could not confirm." },
    ])
    const r = await runAgentChat(turn("record it"))
    const driving = drive(r)
    const turnId = await until(turnOfThread, (id) => id !== null)
    expect(turnId).toBe(r.turnId)
    // The call's process died mid-way: its claim is pending under a gone instance.
    await sql`INSERT INTO kernel.effect_ledger (org_id, key, state, claimed_by)
      VALUES (${owner.orgId}, ${toolEffectKey(r.turnId, "kernel:test_effect_then_wait", hashParams({ key }), 1)},
              'pending', ${`gone-${crypto.randomUUID()}`})`
    const trace = await driving
    expect(trace.text).toBe("Could not confirm.")
    const outputs = trace.results.map((t) => JSON.stringify(t.output))
    expect(outputs.length).toBe(2)
    for (const out of outputs) expect(out).toContain(OUTCOME_UNKNOWN_CODE)
    // Neither the cut call nor its re-call ran the effect.
    expect(await effectCount(key)).toBe(0)
    expect((await turnRow(r.turnId)).state).toBe("done")
  })

  it("a resume of a person deactivated in between ends the turn failed, no tool run", async () => {
    await freshThread()
    const key = `inactive-${crypto.randomUUID()}`
    const person = await minimal.session(owner.orgId, { role: "admin" })
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 600 },
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key: `${key}-2` } }] },
      { text: "never" },
    ])
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${threadId}, ${person.userId}, ${owner.orgId}, 'user') ON CONFLICT DO NOTHING`
    const personScopes = (
      await withPrivilegedDb(owner.orgId, "test:turn-resume-person", (tx) =>
        loadEffectivePermissions(tx, person.userId, owner.orgId),
      )
    ).scopes
    const base = turn("record", personScopes)
    const r = await runAgentChat({ ...base, actor: { ...base.actor, userId: person.userId } })
    const driving = drive(r)
    await until(
      () => effectCount(key),
      (n) => n === 1,
    )
    const drained = handOffRunningTurns(10_000, 2_000)
    await driving
    await drained
    expect((await turnRow(r.turnId)).state).toBe("handoff")
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${person.userId}`
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("failed")
    expect((await turnRow(r.turnId)).state).toBe("failed")
    expect(await effectCount(`${key}-2`)).toBe(0)
    expect((await agentReplies()).length).toBe(0)
  })

  it("M10: the person re-attaches to a handed-off turn and follows it to its reply; nobody else can", async () => {
    await freshThread()
    const key = `reattach-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 400 },
      { text: "Followed to the end.", delayMs: 300 },
    ])
    const r = await runAgentChat(turn("record it", ownerScopes))
    const driving = drive(r)
    await until(
      () => effectCount(key),
      (n) => n === 1,
    )
    const drained = handOffRunningTurns(10_000, 2_000)
    await driving
    expect((await drained).unsettled).toEqual([])
    expect((await turnRow(r.turnId)).state).toBe("handoff")

    const events = (bearer: string) =>
      app.request(`/api/agent/turns/${r.turnId}/events`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
    // A member of the same org who is in the room, but did not ask: the turn does not exist.
    const teammate = await minimal.person(owner.orgId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${threadId}, ${teammate.id}, ${owner.orgId})`
    expect((await events(await minimal.token(teammate.id))).status).toBe(404)
    // Someone of another org holding every scope: the same 404.
    const strangerOrg = crypto.randomUUID()
    const strangerId = crypto.randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${strangerOrg}, 'Other Org', ${`other-${strangerOrg.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${strangerId}, ${strangerOrg}, ${`s-${strangerId.slice(0, 8)}@t.co`}, 'Stranger', 'active', 1)`
    const strangerToken = await signAccessToken(
      {
        userId: strangerId,
        orgId: strangerOrg,
        name: "Stranger",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    expect((await events(strangerToken)).status).toBe(404)
    // Not a turn id at all.
    expect(
      (
        await app.request("/api/agent/turns/not-a-turn/events", {
          headers: { Authorization: `Bearer ${owner.bearer}` },
        })
      ).status,
    ).toBe(404)

    const res = await events(owner.bearer)
    expect(res.status).toBe(200)
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("resumed")
    const body = await res.text()
    const frames = body
      .split("\n\n")
      .map((part) => {
        const event = /^event: (.*)$/m.exec(part)?.[1]
        const data = /^data: (.*)$/m.exec(part)?.[1]
        return event && data ? { event, data: JSON.parse(data) as Record<string, unknown> } : null
      })
      .filter((f): f is { event: string; data: Record<string, unknown> } => f !== null)
    expect(frames[0]?.event).toBe("attached")
    const last = frames[frames.length - 1]
    expect(last?.event).toBe("done")
    expect(last?.data.text).toBe("Followed to the end.")
    const replies = await agentReplies()
    expect(replies.map((m) => m.content)).toEqual(["Followed to the end."])
    expect(last?.data.messageId).toBe(replies[0]?.id)
    expect(frames.some((f) => f.event === "error")).toBe(false)
    expect(await effectCount(key)).toBe(1)
  })

  it("closing the tab does not stop the answer: a /chat request cut mid-turn still finishes and stores its reply", async () => {
    await freshThread()
    await setScriptedTurn(threadId, [{ text: "Answered anyway.", delayMs: 1_500 }])
    const abort = new AbortController()
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, content: "answer me" }),
      signal: abort.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body?.getReader()
    // The turn has started (message-start), then the tab goes away.
    const first = await reader?.read()
    const start = sseFrames(new TextDecoder().decode(first?.value)).find(
      (f) => f.event === "message-start",
    )
    expect(start).toBeDefined()
    abort.abort()
    await reader?.cancel().catch(() => {})
    const turnId = await until(turnOfThread, (id) => id !== null)
    expect(turnId).not.toBeNull()
    // M1: message-start names the turn, so a client whose stream stops without
    // its end (the process died) can still follow it.
    expect(start?.data.turnId).toBe(turnId)
    const done = await until(
      () => turnRow(turnId as string),
      (row) => row.state === "done",
    )
    expect(done.state).toBe("done")
    const replies = await agentReplies()
    expect(replies.map((m) => m.content)).toEqual(["Answered anyway."])
    expect(done.agent_message_id).toBe(replies[0]?.id)
  })

  /** Open the re-attach stream of a turn and read it to its end. */
  async function reattach(turnId: string, bearer = owner.bearer) {
    const res = await app.request(`/api/agent/turns/${turnId}/events`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(200)
    return sseFrames(await res.text())
  }

  it("M1: a re-attach stream that reaches its deadline ends with reattach_timeout, never silently", async () => {
    await freshThread()
    const key = `deadline-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 400 },
      { text: "Later.", delayMs: 50 },
    ])
    const r = await handedOff(turn("record it", ownerScopes), key)
    const saved = { ...reattachTiming }
    reattachTiming.maxMs = 700
    try {
      const frames = await reattach(r.turnId)
      expect(frames[0]?.event).toBe("attached")
      const last = frames[frames.length - 1]
      expect(last?.event).toBe("error")
      expect(last?.data.code).toBe("reattach_timeout")
    } finally {
      Object.assign(reattachTiming, saved)
    }
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("resumed")
    await until(
      () => turnRow(r.turnId),
      (row) => row.state === "done",
    )
  })

  it("M1: a re-attach stream on a draining process ends with restart naming the turn", async () => {
    await freshThread()
    const key = `drain-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 400 },
      { text: "Elsewhere.", delayMs: 50 },
    ])
    const r = await handedOff(turn("record it", ownerScopes), key)
    // Draining past its edge grace: the process refuses new work
    // (lib/readiness.ts refusesNewWork), so the stream sends the client elsewhere.
    const shuttingDown = spyOn(shutdownModule, "isShuttingDown").mockReturnValue(true)
    const gracePassed = spyOn(shutdownModule, "edgeGracePassed").mockReturnValue(true)
    setDraining(true)
    try {
      const frames = await reattach(r.turnId)
      expect(frames.map((f) => f.event)).toEqual(["attached", "restart"])
      expect(frames[1]?.data.turnId).toBe(r.turnId)
    } finally {
      setDraining(false)
      gracePassed.mockRestore()
      shuttingDown.mockRestore()
    }
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("resumed")
    await until(
      () => turnRow(r.turnId),
      (row) => row.state === "done",
    )
  })

  it("L1: the re-attach done frame never serves a stored reply the viewer may not read", async () => {
    await freshThread()
    await setScriptedTurn(threadId, [{ text: "Scoped answer only some may read." }])
    const r = await runAgentChat(turn("answer me", ownerScopes))
    await drive(r)
    const done = await until(
      () => turnRow(r.turnId),
      (row) => row.state === "done",
    )
    expect(done.agent_message_id).not.toBeNull()
    // The reply now needs a scope the person's session does not hold.
    await sql`UPDATE kernel.messages SET required_scopes = ARRAY['test:never-held:read']
      WHERE id = ${done.agent_message_id}`
    const [versions] = await sql<{ auth_version: number; permission_version: number }[]>`
      SELECT auth_version, permission_version FROM kernel.users WHERE id = ${owner.userId}`
    const narrow = await signAccessToken(
      {
        userId: owner.userId,
        orgId: owner.orgId,
        name: "Owner",
        authVersion: versions?.auth_version ?? 1,
        permissionVersion: versions?.permission_version ?? 1,
        // Everything the route needs, nothing that covers the reply's scope.
        scopes: ["kernel:*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    const frames = await reattach(r.turnId, narrow)
    expect(frames.some((f) => f.event === "done")).toBe(false)
    const last = frames[frames.length - 1]
    expect(last?.event).toBe("error")
    expect(last?.data.code).toBe("reply_hidden")
    expect(JSON.stringify(frames)).not.toContain("Scoped answer")
  })

  /** Start a turn, let step 1's write run, and hand the turn off at the step boundary. */
  async function handedOff(
    params: Parameters<typeof runAgentChat>[0],
    key: string,
  ): Promise<Awaited<ReturnType<typeof runAgentChat>>> {
    const r = await runAgentChat(params)
    const driving = drive(r)
    await until(
      () => effectCount(key),
      (n) => n === 1,
    )
    const drained = handOffRunningTurns(10_000, 2_000)
    await driving
    expect((await drained).unsettled).toEqual([])
    expect((await turnRow(r.turnId)).state).toBe("handoff")
    return r
  }

  /** A message of the owner in the thread, to hang an ask under. */
  async function seedMessage(content: string): Promise<string> {
    const row = await withRlsContext(
      {
        actorType: "user",
        userId: owner.userId,
        orgId: owner.orgId,
        scopes: ["*"],
        dimensionGrants: {},
      },
      (tx) =>
        sendMessage(tx, {
          requiredScopes: [],
          orgId: owner.orgId,
          userId: owner.userId,
          threadId,
          content,
          authorType: "user",
        }),
    )
    if (!row) throw new Error("seed message not written")
    return row.id
  }

  it("H1: a resumed delegated ask keeps its delegated scope: a tool outside it does not run", async () => {
    await freshThread()
    const key = `ask-${crypto.randomUUID()}`
    const parentMessageId = await seedMessage("ask the agent")
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 600 },
      { toolCalls: [{ name: PROBE, args: { key: `${key}-probe` } }] },
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key: `${key}-outside` } }] },
      { text: "Answered." },
    ])
    // The ask starts at a scope that still holds the write; the delegation
    // narrows the RESUMED attempt's tools only through the stored record.
    const delegatedScope = ["kernel:agent:web", "kernel:threads:read"]
    const r = await handedOff(
      {
        ...turn("question", ownerScopes),
        skipUserPersist: true,
        userMessageId: parentMessageId,
        coordination: { callerAgentId: agentId, parentMessageId, delegatedScope },
        agentDispatched: true,
      },
      key,
    )
    // Between the handoff and the resume the delegation's scope is what the
    // record holds: narrow it to the probe's scope alone, as a caller whose
    // own effective scope did not include the write would have delegated.
    await sql`UPDATE kernel.agent_turns
      SET resume_input = jsonb_set(resume_input, '{restrictions,coordination,delegatedScope}', '["kernel:agent:web"]'::jsonb)
      WHERE id = ${r.turnId}`
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("resumed")
    await until(
      () => turnRow(r.turnId),
      (row) => row.state === "done" || row.state === "failed",
    )
    const seen = probed.get(`${key}-probe`)
    expect(seen?.coordinated).toBe(true)
    expect(seen?.humanTurn).toBe(false)
    expect(seen?.effectiveScope).toEqual(["kernel:agent:web"])
    // The write outside the delegated scope was never run.
    expect(await effectCount(`${key}-outside`)).toBe(0)
  })

  it("H1: a restricted session's turn resumes restricted", async () => {
    await freshThread()
    const key = `restricted-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 600 },
      { toolCalls: [{ name: PROBE, args: { key: `${key}-probe` } }] },
      { text: "Done." },
    ])
    const r = await handedOff({ ...turn("record", ownerScopes), sessionRestricted: true }, key)
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("resumed")
    await until(
      () => turnRow(r.turnId),
      (row) => row.state === "done",
    )
    expect(probed.get(`${key}-probe`)?.sessionRestricted).toBe(true)
  })

  it("H1: a Share anyway rerun (reply held by its caller) is never handed off nor resumed, and posts nothing", async () => {
    await freshThread()
    const asked = await seedMessage("the withheld question")
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: "kernel__tool_search", args: { query: "x" } }], delayMs: 600 },
      { text: "rerun answer" },
    ])
    const r = await runAgentChat({
      ...turn("", ownerScopes),
      skipUserPersist: true,
      userMessageId: asked,
      persistReply: false,
      readOnlyTools: true,
    })
    const driving = drive(r)
    await until(turnOfThread, (id) => id !== null)
    // A drain does not hand it off: its caller holds the reply.
    expect((await handOffRunningTurns(50, 50)).requested).toEqual([])
    await driving
    // Its process died before the end: the record still says running there.
    await sql`UPDATE kernel.agent_turns
      SET state = 'running', runner_instance_id = ${`gone-${crypto.randomUUID()}`},
          heartbeat_at = now() - make_interval(secs => ${TURN_STALE_AFTER_MS / 1000 + 5}),
          finished_at = NULL
      WHERE id = ${r.turnId}`
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("gone")
    const row = await turnRow(r.turnId)
    expect(row.state).toBe("interrupted")
    expect((await agentReplies()).length).toBe(0)
  })

  it("H2: a write another runner still holds is never run again, however often the model re-calls it", async () => {
    await freshThread()
    const key = `inflight-${crypto.randomUUID()}`
    const call = { name: COUNTER, args: { key } }
    await setScriptedTurn(threadId, [
      // Step 1 waits before its call, so the test can plant the live claim.
      { toolCalls: [call], delayMs: 800 },
      // The model retries the identical call twice.
      { toolCalls: [call] },
      { toolCalls: [call] },
      { text: "Still running elsewhere." },
    ])
    // The resumed calls wait only briefly for the first call's result.
    ToolBridgeEffectTestAccess.setInFlightWaitMs(200)
    const r = await runAgentChat(turn("record it"))
    const driving = drive(r)
    const turnId = await until(turnOfThread, (id) => id !== null)
    expect(turnId).toBe(r.turnId)
    // The cut call of the turn's earlier attempt is still running on a live
    // process (this one): its claim is pending and live (handoff, M2).
    await sql`INSERT INTO kernel.effect_ledger (org_id, key, state, claimed_by)
      VALUES (${owner.orgId}, ${toolEffectKey(r.turnId, "kernel:test_turn_counter", hashParams({ key }), 1)},
              'pending', ${INSTANCE_ID})`
    const trace = await driving
    expect(trace.text).toBe("Still running elsewhere.")
    const outputs = trace.results.map((t) => JSON.stringify(t.output))
    expect(outputs.length).toBe(3)
    // Every call met the same key, held elsewhere: "in progress", never run.
    for (const out of outputs) expect(out).toContain(EFFECT_IN_FLIGHT_CODE)
    expect(counted.get(key) ?? 0).toBe(0)
  })

  it("H2: a resumed call whose identical write finishes elsewhere while it waits gets that write's result", async () => {
    await freshThread()
    const key = `inflight-done-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: COUNTER, args: { key } }], delayMs: 800 },
      { text: "Recorded." },
    ])
    ToolBridgeEffectTestAccess.setInFlightWaitMs(5_000)
    const r = await runAgentChat(turn("record it"))
    const driving = drive(r)
    await until(turnOfThread, (id) => id !== null)
    const ledgerKey = toolEffectKey(r.turnId, "kernel:test_turn_counter", hashParams({ key }), 1)
    await sql`INSERT INTO kernel.effect_ledger (org_id, key, state, claimed_by)
      VALUES (${owner.orgId}, ${ledgerKey}, 'pending', ${INSTANCE_ID})`
    // The other runner finishes the write while this call waits.
    setTimeout(() => {
      void sql`UPDATE kernel.effect_ledger
        SET state = 'done', result = ${JSON.stringify({ key, count: 1, elsewhere: true })}::jsonb, done_at = now()
        WHERE org_id = ${owner.orgId} AND key = ${ledgerKey}`.then(() => {})
    }, 1_200)
    const trace = await driving
    expect(trace.text).toBe("Recorded.")
    expect(trace.results.map((t) => t.output)).toEqual([{ key, count: 1, elsewhere: true }])
    expect(counted.get(key) ?? 0).toBe(0)
  })

  it("H3: a long turn's clipped results are journaled redacted (raw, JSON-escaped, base64)", async () => {
    await freshThread()
    const marker = `CLIP-MARKER-${crypto.randomUUID()}`
    bigReadMarker = marker
    // The big read stands for a read of an encrypted mailbox: its results redact.
    const realRedact = mailRedaction.redactMailToolResult
    const redactSpy = spyOn(mailRedaction, "redactMailToolResult").mockImplementation(
      async (orgId, toolName, result) =>
        toolName.includes("test_turn_big_read")
          ? { redacted: true }
          : realRedact(orgId, toolName, result),
    )
    try {
      const reads = Array.from({ length: 9 }, (_, n) => ({
        toolCalls: [{ name: BIG_READ, args: { n } }],
      }))
      await setScriptedTurn(threadId, [...reads, { text: "Read them all.", delayMs: 1_500 }])
      const r = await runAgentChat(turn("read everything"))
      const driving = drive(r)
      const journal = async () => (await loadTurn(owner.orgId, r.turnId))?.steps ?? []
      const rows = await until(journal, (steps) => steps.length >= 9, 60_000)
      await driving
      expect(rows.length).toBe(9)
      const parsed = parseJournal(rows)
      // The clipper did clip (the batch is past its threshold by step 8).
      const clips = parsed[parsed.length - 1]?.prep.clippedResultIds ?? []
      expect(clips.filter(([, output]) => output !== null).length).toBeGreaterThan(0)
      const stored = JSON.stringify(rows.map((row) => row.payload)) + JSON.stringify(parsed)
      for (const form of [
        marker,
        JSON.stringify(marker).slice(1, -1),
        Buffer.from(marker).toString("base64"),
      ]) {
        expect(stored.includes(form)).toBe(false)
      }
    } finally {
      redactSpy.mockRestore()
    }
  })

  it("M2: an open turn past its maximum age is never resumed: it ends interrupted", async () => {
    await freshThread()
    const { turn: old } = await openTurn({
      orgId: owner.orgId,
      threadId,
      origin: "thread",
      runner: `gone-${crypto.randomUUID()}`,
      resumeInput: { actor: { userId: owner.userId, scopes: ownerScopes } },
    })
    await sql`UPDATE kernel.agent_turns
      SET created_at = now() - interval '2 hours', heartbeat_at = now() - interval '2 hours'
      WHERE id = ${old.id}`
    await sweepOrphanTurns()
    const row = await turnRow(old.id)
    expect(row.state).toBe("interrupted")
    expect(await resumeTurn(owner.orgId, old.id)).toBe("gone")
    expect((await agentReplies()).length).toBe(0)
  })

  it("M3: a turn still running in this process is not claimed by a resume here, stale heartbeat or not", async () => {
    await freshThread()
    await setScriptedTurn(threadId, [{ text: "Slow answer.", delayMs: 1_500 }])
    const r = await runAgentChat(turn("answer slowly"))
    const driving = drive(r)
    await until(turnOfThread, (id) => id !== null)
    await sql`UPDATE kernel.agent_turns
      SET heartbeat_at = now() - make_interval(secs => ${TURN_STALE_AFTER_MS / 1000 + 5})
      WHERE id = ${r.turnId}`
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("not_claimable")
    await driving
    const row = await turnRow(r.turnId)
    expect({ state: row.state, attempt: row.attempt }).toEqual({ state: "done", attempt: 0 })
    expect((await agentReplies()).length).toBe(1)
  })

  it("M6: a resume whose acting agent was archived in between ends failed, no tool run", async () => {
    await freshThread()
    const key = `archived-${crypto.randomUUID()}`
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'role', ${`@ar-${crypto.randomUUID().slice(0, 8)}`}, 'Ari',
              '["*"]'::jsonb, NULL)
      RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${threadId}, ${other.id}, ${owner.orgId}, 'agent')`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 600 },
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key: `${key}-2` } }] },
      { text: "never" },
    ])
    const r = await handedOff({ ...turn("record", ownerScopes), actingAgentId: other.id }, key)
    await sql`UPDATE kernel.agents SET archived_at = now() WHERE id = ${other.id}`
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("failed")
    const [row] = await sql<{ state: string; error_code: string | null }[]>`
      SELECT state, error_code FROM kernel.agent_turns WHERE id = ${r.turnId}`
    expect(row).toEqual({ state: "failed", error_code: "agent_unavailable" })
    expect(await effectCount(`${key}-2`)).toBe(0)
  })

  it("M6: a resume of a routine's turn whose routine was disabled in between ends failed, no tool run", async () => {
    await freshThread()
    const key = `routine-off-${crypto.randomUUID()}`
    const routineId = crypto.randomUUID()
    await sql`INSERT INTO kernel.routines
        (id, org_id, owner_user_id, name, description, kind, event, prompt, scopes, created_by_actor_type)
      VALUES (${routineId}, ${owner.orgId}, ${owner.userId}, 'resume-gate', 'resume-gate', 'event',
              'mail:message:create', 'react', ${sql.array(["kernel:agent:web"])}, 'user')`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 400 },
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key: `${key}-2` } }] },
      { text: "never" },
    ])
    const r = await handedOff(turn("record", ownerScopes), key)
    // The turn is the routine's: what its resume input names.
    await sql`UPDATE kernel.agent_turns
      SET resume_input = jsonb_set(resume_input, '{routineId}', to_jsonb(${routineId}::text))
      WHERE id = ${r.turnId}`
    await sql`UPDATE kernel.routines SET enabled = false WHERE id = ${routineId}`
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("failed")
    const [row] = await sql<{ state: string; error_code: string | null }[]>`
      SELECT state, error_code FROM kernel.agent_turns WHERE id = ${r.turnId}`
    expect(row).toEqual({ state: "failed", error_code: "routine_disabled" })
    expect(await effectCount(`${key}-2`)).toBe(0)
    await sql`DELETE FROM kernel.routines WHERE id = ${routineId}`
  })

  it("L7: a resume whose pinned model is gone ends failed model_unavailable, never on another model", async () => {
    await freshThread()
    const key = `model-gone-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key } }], toolDelayMs: 400 },
      { toolCalls: [{ name: EFFECT_THEN_WAIT, args: { key: `${key}-2` } }] },
      { text: "never" },
    ])
    const r = await handedOff(turn("record", ownerScopes), key)
    await sql`UPDATE kernel.agent_turns
      SET resume_input = jsonb_set(resume_input, '{modelId}', '"removed-model-for-test"'::jsonb)
      WHERE id = ${r.turnId}`
    expect(await resumeTurn(owner.orgId, r.turnId)).toBe("failed")
    const [row] = await sql<{ state: string; error_code: string | null }[]>`
      SELECT state, error_code FROM kernel.agent_turns WHERE id = ${r.turnId}`
    expect(row).toEqual({ state: "failed", error_code: "model_unavailable" })
    expect(await effectCount(`${key}-2`)).toBe(0)
  })

  it("M5: a job retry after its turn failed answers again, as a new attempt; a done one is not answered twice", async () => {
    await freshThread()
    const asked = await seedMessage("job question")
    const originRef = `job:test:${crypto.randomUUID()}`
    const { turn: failed } = await openTurn({
      orgId: owner.orgId,
      threadId,
      origin: "job",
      originRef,
      userMessageId: asked,
      resumeInput: { actor: { userId: owner.userId, scopes: ownerScopes } },
    })
    await finishTurn({
      orgId: owner.orgId,
      turnId: failed.id,
      runner: INSTANCE_ID,
      state: "failed",
      failureReason: "turn",
      errorCode: "provider_error",
    })
    await setScriptedTurn(threadId, [{ text: "Answered on retry." }])
    const actor = { userId: owner.userId, orgId: owner.orgId, scopes: ownerScopes }
    const retry = () =>
      invokeAgentForThread(
        threadId,
        asked,
        actor,
        owner.orgId,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        agentId,
        undefined,
        { originRef },
      )
    await retry()
    const row = await turnRow(failed.id)
    expect({ state: row.state, attempt: row.attempt }).toEqual({ state: "done", attempt: 1 })
    expect((await agentReplies()).map((m) => m.content)).toEqual(["Answered on retry."])
    // Done now: a further re-run of the job does not answer again.
    expect((await retry()).finishReason).toBe("stop")
    expect((await agentReplies()).length).toBe(1)
  })

  // THE PRODUCING SIDE of "your agent tells you once, when it is done"
  // (notification etiquette, rule 1). The push fan-out notifies the person a
  // turn worked for only on the row whose `message:create` event carries
  // `endsTurn: true`; these cases prove which rows the runtime marks, read
  // back off the outbox as every consumer reads it.
  describe("which rows end a turn (endsTurn on message:create)", () => {
    /** The `data` of every `message:create` event of this thread by `authorType`, oldest first. */
    const messageEvents = async (authorType: string) =>
      (
        await sql<{ data: Record<string, unknown> }[]>`
          SELECT payload->'data' AS data FROM kernel.pending_events
           WHERE org_id = ${owner.orgId}
             AND payload->>'entity' = 'message' AND payload->>'action' = 'create'
             AND payload->'data'->>'threadId' = ${threadId}
             AND payload->'data'->>'authorType' = ${authorType}
           ORDER BY seq`
      ).map((r) => r.data)

    /** The person's own message a nested turn hangs under. */
    const personPost = async (content: string) => {
      const m = await withRlsContext(turn(content).actor, (tx) =>
        sendMessage(tx, {
          orgId: owner.orgId,
          userId: owner.userId,
          threadId,
          content,
          requiredScopes: [],
        }),
      )
      if (!m) throw new Error("the person could not post")
      return m.id
    }

    afterEach(() => {
      _setEdition(null)
    })

    it("the final answer of a person's turn ends it", async () => {
      await freshThread()
      await setScriptedTurn(threadId, [{ text: "Here is the summary." }])
      await drive(await runAgentChat(turn("summarise my week")))
      const rows = await messageEvents("agent")
      expect(rows.map((d) => [d.content, d.endsTurn])).toEqual([["Here is the summary.", true]])
    })

    // An external (MCP) client posting for the person dispatches the turn with
    // a stated ceiling and the post as its parent, so it runs nested. It is
    // still the person's turn: its answer is theirs to be told of.
    it("the final answer of a turn a person started over MCP ends it", async () => {
      await freshThread()
      const parent = await personPost("what is due today?")
      await setScriptedTurn(threadId, [{ text: "Two tasks are due." }])
      await drive(
        await runAgentChat({
          ...turn("what is due today?"),
          coordination: { callerAgentId: null, parentMessageId: parent, delegatedScope: ["*"] },
        }),
      )
      const rows = await messageEvents("agent")
      expect(rows.map((d) => [d.content, d.endsTurn])).toEqual([["Two tasks are due.", true]])
    })

    it("an agent answering another agent does not end anybody's turn", async () => {
      await freshThread()
      const [other] = await sql<{ id: string }[]>`
        INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${owner.orgId}, 'role', ${`@te-${crypto.randomUUID().slice(0, 8)}`}, 'Ops',
                '["*"]'::jsonb)
        RETURNING id`
      const parent = await personPost("question relayed by another agent")
      await setScriptedTurn(threadId, [{ text: "Answer for the asking agent." }])
      await drive(
        await runAgentChat({
          ...turn("question relayed by another agent"),
          coordination: { callerAgentId: other.id, parentMessageId: parent, delegatedScope: ["*"] },
        }),
      )
      const rows = await messageEvents("agent")
      expect(rows.map((d) => d.content)).toEqual(["Answer for the asking agent."])
      expect(rows[0].endsTurn).not.toBe(true)
    })

    it("an out-of-credits refusal ends the person's turn", async () => {
      await freshThread()
      _setEdition("managed")
      await sql`UPDATE kernel.credit_balances SET included_balance = 0, purchased_balance = 0
        WHERE org_id = ${owner.orgId}`
      try {
        await expect(runAgentChat(turn("are you there?"))).rejects.toThrow()
      } finally {
        await sql`UPDATE kernel.credit_balances SET included_balance = 10 WHERE org_id = ${owner.orgId}`
      }
      const rows = await messageEvents("system")
      expect(rows).toHaveLength(1)
      expect(rows[0].endsTurn).toBe(true)
    })

    it("the notice of a resumed turn that failed ends the person's turn", async () => {
      await freshThread()
      const r = await runAgentChat(turn("long job"))
      // The turn is never driven here: the resume gives up on it.
      await TurnResumeTestAccess.failTurn(
        owner.orgId,
        r.turnId,
        threadId,
        owner.userId,
        "resume_failed",
        { scopes: ["*"], dimensionGrants: {} },
      )
      const rows = await messageEvents("system")
      expect(rows).toHaveLength(1)
      expect(rows[0].endsTurn).toBe(true)
    })
  })
})

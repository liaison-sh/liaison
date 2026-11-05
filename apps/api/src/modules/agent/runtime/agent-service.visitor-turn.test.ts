// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo visitor's turn through the real runAgentChat wiring, on the box key:
//
// - its step budget says when the last step with tools is due, so the writes
//   the request asks for go out before the tools-off check-in (live demo: a
//   support routine read for five steps and wrote nothing);
// - a newer request from the visitor in the same conversation stops it
//   before its next model call (live demo: a 200,000 token turn was billed
//   after the tour that asked for it had moved on). A regular org's turn
//   keeps running;
// - the stopped turn is closed, whatever it wrote, and every later turn's
//   history shows it closed, at its own turn (live demo: the next turns read
//   its tool results as unfinished work and wrote its summary instead of
//   answering). The turn that replaced it is told to answer its own message.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { TURN_SYSTEM_PROMPT_TOKEN_CAP } from "~/modules/agent/context/context"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { recordAgentTurnAccepted } from "~/modules/agent/runtime/stream-registry"
import {
  SUPERSEDED_FINISH_REASON,
  SUPERSEDED_TURN_TEXT,
  supersededEarlierWorkNote,
  waitForEarlierLiveTurn,
} from "~/modules/agent/runtime/superseded-turn"
import {
  TURN_BUDGET_ANSWER_ONLY_RESULT,
  TURN_BUDGET_CHECK_IN_NOTE,
  TURN_BUDGET_LAST_TOOL_STEP_NOTE,
} from "~/modules/agent/runtime/turn-input-budget"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoBudgetTestAccess } from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo } from "~/modules/demo/demo-org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000f30001"
const USER_ID = "00000000-0000-0000-0000-000000f30002"
const THREAD_ID = "00000000-0000-0000-0000-000000f30003"
const REGULAR_ORG_ID = "00000000-0000-0000-0000-000000f30011"
const REGULAR_USER_ID = "00000000-0000-0000-0000-000000f30012"
const REGULAR_THREAD_ID = "00000000-0000-0000-0000-000000f30013"
const REGULAR_MODEL_ID = "claude-haiku-4-5-visitor-turn"
const CLOSURE_THREAD_ID = "00000000-0000-0000-0000-000000f30005"
const WAIT_THREAD_ID = "00000000-0000-0000-0000-000000f30006"

let capturedParams: any = null

function capturingStreamText(params: any) {
  capturedParams = params
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1000, outputTokens: 10 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

type StepOut = { toolChoice?: unknown; messages?: Array<{ role: string; content: unknown }> }

async function prepare(stepNumber: number): Promise<StepOut> {
  return (await capturedParams.prepareStep({
    steps: [],
    stepNumber,
    messages: [{ role: "user", content: "draft the reply" }],
  })) as StepOut
}

async function finishStep(): Promise<void> {
  await capturedParams.onStepFinish({
    usage: { inputTokens: 20_000, outputTokens: 50 },
    toolCalls: [{ toolName: "kernel__contacts_search" }],
  })
}

const carries = (out: StepOut, note: string) => JSON.stringify(out.messages ?? []).includes(note)

const saved = {
  key: process.env.OPENROUTER_API_KEY,
  anthropic: process.env.LIAISON_ANTHROPIC_API_KEY,
  alert: env.LIAISON_DEMO_ALERT_EMAIL,
  capture: env.LIAISON_DEMO_MAIL_CAPTURE,
  budgets: {
    perEmail: env.LIAISON_DEMO_BUDGET_PER_EMAIL_EUR,
    perNetwork: env.LIAISON_DEMO_BUDGET_PER_NETWORK_EUR,
    daily: env.LIAISON_DEMO_BOX_DAILY_EUR,
    hourly: env.LIAISON_DEMO_BOX_HOURLY_EUR,
  },
}

async function startTurn(
  orgId: string,
  userId: string,
  threadId: string,
  currentView?: { tabType: string; entityId: string },
  budget?: { timeoutMs: number },
  ask?: { content: string; userMessageId?: string },
) {
  capturedParams = null
  const { runAgentChat } = await import("./agent-service")
  const result = await runAgentChat({
    threadId,
    content: ask?.content ?? "draft the reply",
    ...(ask?.userMessageId ? { skipUserPersist: true, userMessageId: ask.userMessageId } : {}),
    actor: { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
    orgId,
    ...(currentView ? { currentView } : {}),
    ...(budget ? { budget } : {}),
  } as never)
  expect(capturedParams).not.toBeNull()
  return result as unknown as {
    finalize: (p: never) => Promise<unknown>
    stepCtx: { answerOnly?: string | null }
  }
}

async function postNewer(orgId: string, userId: string, threadId: string): Promise<void> {
  await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, created_at)
    VALUES (${threadId}, ${orgId}, ${userId}, 'user', 'draft the reply', '{}'::text[], now() + interval '1 second')`
}

const OTHER_USER_ID = "00000000-0000-0000-0000-000000f30004"
const FOCUS_APP = "vtfocus"
const FOCUS_SKILL_MARKER = "VTFOCUS-PLAYBOOK-BODY-MARKER"

describe("a demo visitor's turn", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(capturingStreamText as never)
    DemoModeTestAccess.set(true)
    process.env.OPENROUTER_API_KEY = "sk-or-visitor-turn-box-key"
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    env.LIAISON_DEMO_BUDGET_PER_EMAIL_EUR = 10_000
    env.LIAISON_DEMO_BUDGET_PER_NETWORK_EUR = 10_000
    env.LIAISON_DEMO_BOX_DAILY_EUR = 10_000
    env.LIAISON_DEMO_BOX_HOURLY_EUR = 10_000
    env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
    env.LIAISON_DEMO_MAIL_CAPTURE = true
    registerDemoAlertMailer(async () => {})
    DemoBudgetTestAccess.setVerifiedIdentity(async () => ({
      emailNormalized: `visitor-turn-${Date.now()}@example.com`,
      network: "192.0.2.0/24",
    }))

    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'VisitorTurnOrg', 'visitor-turn-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'visitor-turn@visitor.demo.invalid', 'Visitor') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER_ID}, ${ORG_ID}, '*') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'visitor-turn-chat', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${CLOSURE_THREAD_ID}, ${ORG_ID}, 'visitor-turn-closure', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${CLOSURE_THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${WAIT_THREAD_ID}, ${ORG_ID}, 'visitor-turn-wait', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${WAIT_THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER_USER_ID}, ${ORG_ID}, 'visitor-turn-other@visitor.demo.invalid', 'Other') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${OTHER_USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    // An app the visitor's view names, with an anchored playbook larger than
    // the system prompt cap allows beside the rest.
    toolRegistry.set([ORG_ID, FOCUS_APP, "ping"], {
      appName: FOCUS_APP,
      name: "ping",
      description: "Ping the focus app.",
      requiredScopes: ["kernel:threads:read"],
      handler: async () => ({ ok: true }),
    } as never)
    await sql`INSERT INTO kernel.skills (org_id, name, description, body, enabled, auto_attach, created_by_actor_type)
      VALUES (${ORG_ID}, 'vtfocus-playbook', 'How to work the focus app', ${`${FOCUS_SKILL_MARKER} ${"step ".repeat(Math.round((TURN_SYSTEM_PROMPT_TOKEN_CAP * 0.75 * 4) / 5))}`}, true, ${JSON.stringify({ apps: [FOCUS_APP] })}::jsonb, 'user')`
    await markOrgAsDemo(ORG_ID, {
      variant: "visitor",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    })
    invalidateDemoMarker(ORG_ID)

    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${REGULAR_ORG_ID}, 'RegularTurnOrg', 'regular-turn-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${REGULAR_USER_ID}, ${REGULAR_ORG_ID}, 'regular-turn@test.com', 'Regular') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${REGULAR_USER_ID}, ${REGULAR_ORG_ID}, '*') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id) VALUES (${REGULAR_THREAD_ID}, ${REGULAR_ORG_ID}, 'regular-turn-chat', 'agent_chat', ${REGULAR_USER_ID}, ${REGULAR_MODEL_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${REGULAR_THREAD_ID}, ${REGULAR_USER_ID}, ${REGULAR_ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${REGULAR_ORG_ID}, '10.00000000', '0', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${REGULAR_MODEL_ID}, 'Visitor turn test', '1.00', '5.00', 200000, true, 'starter') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await clearRedisPatterns(["demo:*"])
    if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = saved.key
    if (saved.anthropic === undefined) delete process.env.LIAISON_ANTHROPIC_API_KEY
    else process.env.LIAISON_ANTHROPIC_API_KEY = saved.anthropic
    env.LIAISON_DEMO_ALERT_EMAIL = saved.alert
    env.LIAISON_DEMO_MAIL_CAPTURE = saved.capture
    env.LIAISON_DEMO_BUDGET_PER_EMAIL_EUR = saved.budgets.perEmail
    env.LIAISON_DEMO_BUDGET_PER_NETWORK_EUR = saved.budgets.perNetwork
    env.LIAISON_DEMO_BOX_DAILY_EUR = saved.budgets.daily
    env.LIAISON_DEMO_BOX_HOURLY_EUR = saved.budgets.hourly
    registerDemoAlertMailer(null)
    DemoBudgetTestAccess.setVerifiedIdentity(null)
    DemoModeTestAccess.set(null)
    toolRegistry.delete([ORG_ID, FOCUS_APP, "ping"])
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
    for (const org of [ORG_ID, REGULAR_ORG_ID]) {
      await sql`DELETE FROM kernel.messages WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.pending_events WHERE org_id = ${org}`
    }
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${REGULAR_MODEL_ID}`
    await releaseTestLock()
  })

  it("is told its last step with tools is due, the step before the answer-only check-in", async () => {
    const result = await startTurn(ORG_ID, USER_ID, THREAD_ID)
    const steps = env.LIAISON_DEMO_STEPS_PER_TURN
    // The prompt states the budget, so the model can plan its reads.
    expect(JSON.stringify(capturedParams.system)).toContain(`at most ${steps} steps`)
    for (let step = 0; step < steps - 1; step++) {
      const out = await prepare(step)
      expect(out.toolChoice).toBeUndefined()
      expect(carries(out, TURN_BUDGET_LAST_TOOL_STEP_NOTE)).toBe(step === steps - 2)
      expect(carries(out, TURN_BUDGET_CHECK_IN_NOTE)).toBe(false)
      await finishStep()
    }
    const checkIn = await prepare(steps - 1)
    // Answer only: the turn's tools stay in the request (the prompt cache), a call is not run.
    expect(checkIn.toolChoice).toBeUndefined()
    expect(result.stepCtx.answerOnly).toBe(TURN_BUDGET_ANSWER_ONLY_RESULT)
    expect(carries(checkIn, TURN_BUDGET_CHECK_IN_NOTE)).toBe(true)
    await result.finalize({
      usage: { promptTokens: 1000, completionTokens: 10 },
      finishReason: "stop",
      text: "ok",
      steps: [],
    } as never)
  }, 60_000)

  it("stops before its next model call once the visitor sent a newer request here", async () => {
    const result = await startTurn(ORG_ID, USER_ID, THREAD_ID)
    const signal = capturedParams.abortSignal as AbortSignal
    await prepare(0)
    await finishStep()
    expect(signal.aborted).toBe(false)
    await postNewer(ORG_ID, USER_ID, THREAD_ID)
    await prepare(1)
    await finishStep()
    // The loop's abort signal is what the SDK checks before every model call.
    expect(signal.aborted).toBe(true)
    expect(String(signal.reason)).toBe(SUPERSEDED_FINISH_REASON)
    await result.finalize({
      usage: { promptTokens: 1000, completionTokens: 10 },
      finishReason: "tool-calls",
      text: "",
      steps: [],
    } as never)
    const [row] = await sql<{ content: string }[]>`
      SELECT content FROM kernel.messages
      WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
      ORDER BY created_at DESC LIMIT 1`
    expect(row?.content).toBe(SUPERSEDED_TURN_TEXT)
  }, 60_000)

  // Live demo: a turn the visitor had replaced, still inside a long step when its clock ran
  // out, told them "I ran out of time (this run's limit is 300s)".
  it("says it was replaced, not that it ran out of time, when a newer request replaced it before its time limit hit", async () => {
    const result = await startTurn(ORG_ID, USER_ID, THREAD_ID, undefined, { timeoutMs: 1_000 })
    const signal = capturedParams.abortSignal as AbortSignal
    await prepare(0)
    await postNewer(ORG_ID, USER_ID, THREAD_ID)
    await Bun.sleep(1_300)
    expect(String(signal.reason)).toBe("timeout")
    await result.finalize({
      usage: { promptTokens: 1000, completionTokens: 10 },
      finishReason: "stop",
      text: "",
      steps: [],
    } as never)
    const [row] = await sql<{ content: string }[]>`
      SELECT content FROM kernel.messages
      WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
      ORDER BY created_at DESC LIMIT 1`
    expect(row?.content).toBe(SUPERSEDED_TURN_TEXT)
  }, 60_000)

  it("a regular org's turn keeps running when a newer message arrives", async () => {
    DemoModeTestAccess.set(false)
    try {
      const result = await startTurn(REGULAR_ORG_ID, REGULAR_USER_ID, REGULAR_THREAD_ID)
      const signal = capturedParams.abortSignal as AbortSignal
      await prepare(0)
      await finishStep()
      await postNewer(REGULAR_ORG_ID, REGULAR_USER_ID, REGULAR_THREAD_ID)
      await prepare(1)
      await finishStep()
      expect(signal.aborted).toBe(false)
      // And no step budget: no last-tool-step note however many steps.
      for (let step = 2; step < 12; step++) {
        expect(carries(await prepare(step), TURN_BUDGET_LAST_TOOL_STEP_NOTE)).toBe(false)
        await finishStep()
      }
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      } as never)
    } finally {
      DemoModeTestAccess.set(true)
    }
  }, 60_000)
  it("keeps running when someone else in the conversation posts a newer message", async () => {
    const result = await startTurn(ORG_ID, USER_ID, THREAD_ID)
    const signal = capturedParams.abortSignal as AbortSignal
    await prepare(0)
    await finishStep()
    await postNewer(ORG_ID, OTHER_USER_ID, THREAD_ID)
    await prepare(1)
    await finishStep()
    expect(signal.aborted).toBe(false)
    await result.finalize({
      usage: { promptTokens: 1000, completionTokens: 10 },
      finishReason: "stop",
      text: "ok",
      steps: [],
    } as never)
  }, 60_000)

  it("loads the app its view names from the first step, with that app's playbook", async () => {
    const result = await startTurn(ORG_ID, USER_ID, THREAD_ID, {
      tabType: `${FOCUS_APP}:thing`,
      entityId: crypto.randomUUID(),
    })
    const step0 = (await capturedParams.prepareStep({ steps: [], stepNumber: 0 })) as {
      activeTools: string[]
    }
    expect(step0.activeTools).toContain(`${FOCUS_APP}__ping`)
    // The playbook arrives before the first step, as the turn's note (a
    // surfaced skill body is not in the system prompt: which skills surface
    // changes with the request, and the system prompt must not).
    expect(JSON.stringify(capturedParams.system)).not.toContain(FOCUS_SKILL_MARKER)
    expect(JSON.stringify(capturedParams.messages)).toContain(FOCUS_SKILL_MARKER)
    await result.finalize({
      usage: { promptTokens: 1000, completionTokens: 10 },
      finishReason: "stop",
      text: "ok",
      steps: [],
    } as never)
  }, 60_000)

  it("a regular org's turn on a demo box keeps running when a newer message arrives", async () => {
    const result = await startTurn(REGULAR_ORG_ID, REGULAR_USER_ID, REGULAR_THREAD_ID)
    const signal = capturedParams.abortSignal as AbortSignal
    await prepare(0)
    await finishStep()
    await postNewer(REGULAR_ORG_ID, REGULAR_USER_ID, REGULAR_THREAD_ID)
    await prepare(1)
    await finishStep()
    expect(signal.aborted).toBe(false)
    expect(JSON.stringify(capturedParams.system)).not.toContain("This turn can take at most")
    await result.finalize({
      usage: { promptTokens: 1000, completionTokens: 10 },
      finishReason: "stop",
      text: "ok",
      steps: [],
    } as never)
  }, 60_000)

  describe("a turn a newer request replaced after it wrote text and called tools", () => {
    const REQUEST_A = "Break PREAMP-11 into subtasks for the preamp board bring-up, one per stage"
    const REQUEST_B = "Which EU rules on battery passports apply to us? Start with one web search"
    const REQUEST_C = "Where does order #1097 stand? Book its shipment"
    const NARRATION = "I'll read the task and split it."
    const CALL_ID = "call-superseded-create-1"
    type Core = { role: string; content: unknown }
    const isClosure = (m: Core) => m.role === "assistant" && m.content === SUPERSEDED_TURN_TEXT
    // The replay renames call ids for the provider, so the call is found by its tool.
    const callsTool = (m: Core) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string; toolName?: string }>).some(
        (p) => p.type === "tool-call" && p.toolName === "projects__create",
      )
    const saysUser = (text: string) => (m: Core) =>
      m.role === "user" && typeof m.content === "string" && m.content.includes(text)

    /** The stopped turn, its tool call, its result, its closing line, then the newer request. */
    function expectClosedAtItsTurn(history: Core[]) {
      const asked = history.findIndex(saysUser(REQUEST_A))
      const call = history.findIndex(callsTool)
      const closure = history.findIndex(isClosure)
      const newer = history.findIndex(saysUser(REQUEST_B))
      expect(asked).toBeGreaterThanOrEqual(0)
      expect(call).toBe(asked + 1)
      expect(history[call + 1]?.role).toBe("tool")
      expect(closure).toBe(call + 2)
      expect(newer).toBe(closure + 1)
      // The narration replays before the call, the closing line only after the result.
      expect(JSON.stringify(history[call])).toContain(NARRATION)
      expect(JSON.stringify(history[call])).not.toContain(SUPERSEDED_TURN_TEXT)
    }

    it("is saved with its work and closed, and the next turns see it closed", async () => {
      // Turn A: narrates, calls a tool, and is replaced before its summary.
      const turnA = await startTurn(ORG_ID, USER_ID, CLOSURE_THREAD_ID, undefined, undefined, {
        content: REQUEST_A,
      })
      const signal = capturedParams.abortSignal as AbortSignal
      await prepare(0)
      await finishStep()
      const [newer] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${CLOSURE_THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', ${REQUEST_B}, '{}'::text[])
        RETURNING id`
      await prepare(1)
      await finishStep()
      expect(String(signal.reason)).toBe(SUPERSEDED_FINISH_REASON)
      await turnA.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "tool-calls",
        text: NARRATION,
        timeline: [
          { kind: "text", text: NARRATION },
          { kind: "tool", toolCallId: CALL_ID },
        ],
        steps: [
          {
            toolCalls: [
              { toolCallId: CALL_ID, toolName: "projects__create", args: { title: "Stage 1" } },
            ],
            toolResults: [{ toolCallId: CALL_ID, result: { id: "task-1", title: "Stage 1" } }],
          },
        ],
      } as never)

      // Saved: what it wrote, its tool call (the subtask is real), then the closing line.
      const [saved] = await sql<{ content: string; metadata: any }[]>`
        SELECT content, metadata FROM kernel.messages
        WHERE thread_id = ${CLOSURE_THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1`
      expect(saved?.content).toBe(`${NARRATION}\n\n${SUPERSEDED_TURN_TEXT}`)
      expect(saved?.metadata.finishReason).toBe(SUPERSEDED_FINISH_REASON)
      expect(saved?.metadata.toolCalls.map((c: { toolName: string }) => c.toolName)).toEqual([
        "projects__create",
      ])
      expect(saved?.metadata.timeline.at(-1)).toEqual({ kind: "text", text: SUPERSEDED_TURN_TEXT })

      // Turn B, the newer request: its history shows A closed at A's own turn,
      // and every step is told to answer B.
      const turnB = await startTurn(ORG_ID, USER_ID, CLOSURE_THREAD_ID, undefined, undefined, {
        content: REQUEST_B,
        userMessageId: newer!.id,
      })
      expectClosedAtItsTurn(capturedParams.messages as Core[])
      const note = supersededEarlierWorkNote(REQUEST_A)
      expect(note).toContain(
        "Your earlier work on 'Break PREAMP-11 into subtasks for the preamp board bring-up,…' was stopped when this message arrived",
      )
      // The step's messages, as the model gets them (carries() compares JSON text).
      const stepB = await prepare(0)
      expect((stepB.messages ?? []).some((m) => m.content === note)).toBe(true)
      await turnB.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "Battery passports: the EU Battery Regulation applies.",
        steps: [],
      } as never)

      // Turn C, two asks later and a normal one: A still reads closed, and no note.
      const turnC = await startTurn(ORG_ID, USER_ID, CLOSURE_THREAD_ID, undefined, undefined, {
        content: REQUEST_C,
      })
      const historyC = capturedParams.messages as Core[]
      expectClosedAtItsTurn(historyC)
      expect(historyC.findIndex(saysUser(REQUEST_C))).toBeGreaterThan(
        historyC.findIndex(saysUser(REQUEST_B)),
      )
      expect(carries(await prepare(0), "Your earlier work on")).toBe(false)
      await turnC.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      } as never)
    }, 90_000)

    // Live demo: the newer message arrives while the earlier turn is inside a
    // model step; it stops only at that step's end. The newer turn waits for it.
    it("a newer turn started while the earlier one is still live waits for it, then sees it closed", async () => {
      const turnA = await startTurn(ORG_ID, USER_ID, WAIT_THREAD_ID, undefined, undefined, {
        content: REQUEST_A,
      })
      const paramsA = capturedParams
      const [askedA] = await sql<{ id: string }[]>`
        SELECT id FROM kernel.messages
        WHERE thread_id = ${WAIT_THREAD_ID} AND author_type = 'user' ORDER BY created_at DESC LIMIT 1`
      // A is live, as the stream loop records it.
      const liveA = await recordAgentTurnAccepted(WAIT_THREAD_ID, ORG_ID, {
        agentId: null,
        turnId: askedA!.id,
        requesterId: USER_ID,
      })
      await paramsA.prepareStep({ steps: [], stepNumber: 0, messages: [] })
      const [newer] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${WAIT_THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', ${REQUEST_B}, '{}'::text[])
        RETURNING id`
      // B starts while A is mid-step: it must not assemble yet.
      let bStarted = false
      const turnBPromise = startTurn(ORG_ID, USER_ID, WAIT_THREAD_ID, undefined, undefined, {
        content: REQUEST_B,
        userMessageId: newer!.id,
      }).then((r) => {
        bStarted = true
        return r
      })
      await Bun.sleep(800)
      expect(bStarted).toBe(false)
      // A's step ends, it sees B and stops, is saved closed, and leaves the registry.
      await paramsA.onStepFinish({
        usage: { inputTokens: 20_000, outputTokens: 50 },
        toolCalls: [{ toolName: "projects__create" }],
      })
      expect(String((paramsA.abortSignal as AbortSignal).reason)).toBe(SUPERSEDED_FINISH_REASON)
      await turnA.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "tool-calls",
        text: NARRATION,
        steps: [
          {
            toolCalls: [
              { toolCallId: CALL_ID, toolName: "projects__create", args: { title: "Stage 1" } },
            ],
            toolResults: [{ toolCallId: CALL_ID, result: { id: "task-1", title: "Stage 1" } }],
          },
        ],
      } as never)
      await liveA.withdraw()
      const turnB = await turnBPromise
      expectClosedAtItsTurn(capturedParams.messages as Core[])
      const stepB = await prepare(0)
      expect(
        (stepB.messages ?? []).some((m) => m.content === supersededEarlierWorkNote(REQUEST_A)),
      ).toBe(true)
      await turnB.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      } as never)
    }, 90_000)

    it("the wait is bounded, and ignores the newer turn's own entry and other people's turns", async () => {
      const own = await recordAgentTurnAccepted(WAIT_THREAD_ID, ORG_ID, {
        agentId: null,
        turnId: "00000000-0000-0000-0000-00000000aaa1",
        requesterId: USER_ID,
      })
      const other = await recordAgentTurnAccepted(WAIT_THREAD_ID, ORG_ID, {
        agentId: null,
        turnId: "00000000-0000-0000-0000-00000000aaa2",
        requesterId: OTHER_USER_ID,
      })
      try {
        const base = { threadId: WAIT_THREAD_ID, senderId: USER_ID, agentId: null }
        expect(
          await waitForEarlierLiveTurn({
            ...base,
            messageId: "00000000-0000-0000-0000-00000000aaa1",
          }),
        ).toBe("none")
        const started = Date.now()
        expect(
          await waitForEarlierLiveTurn({
            ...base,
            messageId: "00000000-0000-0000-0000-00000000aaa9",
            timeoutMs: 400,
          }),
        ).toBe("timeout")
        expect(Date.now() - started).toBeLessThan(2_000)
      } finally {
        await own.withdraw()
        await other.withdraw()
      }
    }, 30_000)
  })
})

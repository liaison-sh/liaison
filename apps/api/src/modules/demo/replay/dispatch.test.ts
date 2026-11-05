// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The developer scenario's dispatch is the agent's own: `run_on_my_computer`,
// in a demo org whose visitor has the recorded laptop and no computer of
// their own, starts the recorded session there as a dispatch of that agent
// from that conversation (its card posted, the session's source thread set,
// so the finished session reports back), and the scenario's dispatch beat
// completes on that session's creation, whether the call ran at once or
// parked for approval first. Outside a demo org, or before the scenario's
// start created the laptop, it starts nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { effectiveBeats, RUN_CONVERSATION, SCENARIO_TOURS } from "@liaison/shared"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import type { AppEvent } from "~/infra/events/event-bus"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { prepareDemoScenario } from "~/modules/demo/demo-seeder"
import { handleRunOnMyComputer, summarizeRunOnMyComputer } from "~/modules/nodes/run-on-my-computer"
import { actorSatisfies, bindingMatches } from "~/modules/tours/consumer"
import { completeDoBeat, type TourState } from "~/modules/tours/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { RECORDING, REPLAY_NODE_NAME, REPLAY_SOURCE_REF } from "./replay"

interface Who {
  session: minimal.Session
  agentId: string
  threadId: string
}

describe("the developer scenario's dispatch goes through the agent's tool", () => {
  let visitor: Who
  let regular: Who
  let manager: WebSocketManager
  let previous: WebSocketManager | null

  const actor = (s: minimal.Session): UserContext => ({
    actorType: "user",
    userId: s.userId,
    orgId: s.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  function frame(agentId: string, turnMessageId: string): RunContext {
    const runId = crypto.randomUUID()
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      agentId,
      agentCeiling: ["*"],
      effectiveScope: ["*"],
      turnScopeAccumulator: createTurnScopeAccumulator(),
      turnMessageId,
    }
  }

  function dispatch(who: Who, turnMessageId: string, extra: { approvalRequestId?: string } = {}) {
    return withRlsContext(actor(who.session), (tx) =>
      runContextStore.run(frame(who.agentId, turnMessageId), () =>
        handleRunOnMyComputer(
          {
            task: "Run a fix for the battery bug stuck at 99% on my computer, the Demo laptop (recorded).",
          },
          {
            userId: who.session.userId,
            orgId: who.session.orgId,
            db: tx,
            agentExecutionThreadId: who.threadId,
            scopes: ["*"],
            actingAgentId: who.agentId,
            ...extra,
          },
        ),
      ),
    )
  }

  async function setUp(s: minimal.Session): Promise<Who> {
    // The personal agent the person's registration gave them.
    const [agent] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.agents
       WHERE org_id = ${s.orgId} AND kind = 'personal' AND owner_user_id = ${s.userId}`
    const threadId = await minimal.thread(s.orgId, s.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${threadId}, ${agent.id}, ${s.orgId}, 'agent')`
    return { session: s, agentId: agent.id, threadId }
  }

  async function cleanup() {
    for (const who of [visitor, regular]) {
      if (!who) continue
      const orgId = who.session.orgId
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${orgId}`
    }
  }

  /** The `kernel:node_session:create` event the dispatch queued, as the tour consumer reads it. */
  async function createdEvent(sessionId: string): Promise<AppEvent> {
    const [row] = await sql<Array<{ payload: AppEvent }>>`
      SELECT payload FROM kernel.pending_events
       WHERE payload->>'entity' = 'node_session' AND payload->>'action' = 'create'
         AND payload->>'entityId' = ${sessionId}`
    expect(row).toBeDefined()
    return row.payload
  }

  const devTour = SCENARIO_TOURS.find((t) => t.id === "kernel.scenario-dev")
  if (!devTour) throw new Error("no developer scenario")
  const beats = effectiveBeats(devTour, { installedApps: [], isDemo: true })
  const beat = (id: string) => {
    const b = beats.find((x) => x.id === id)
    if (!b?.event) throw new Error(`no do beat ${id}`)
    return b
  }

  beforeAll(async () => {
    await acquireTestLock()
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    // createTestOrg truncates every org: the regular org first, the demo org beside it.
    const regularOrg = await createTestOrg()
    regular = await setUp(await minimal.session(regularOrg.id))
    const demoOrgId = (await minimal.secondOrg({ name: "Dispatch Demo" })).orgId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    invalidateDemoMarker(demoOrgId)
    visitor = await setUp(await minimal.adminSession(demoOrgId))
    DemoModeTestAccess.set(true)
  })

  beforeEach(cleanup)

  afterAll(async () => {
    await cleanup()
    DemoModeTestAccess.set(null)
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("the scenario's start creates the recorded laptop, before anything is dispatched", async () => {
    await prepareDemoScenario(visitor.session.orgId, visitor.session.userId, "dev")
    const nodes = await sql<Array<{ name: string; simulated: boolean }>>`
      SELECT name, simulated FROM kernel.nodes WHERE org_id = ${visitor.session.orgId}`
    expect([...nodes]).toEqual([{ name: REPLAY_NODE_NAME, simulated: true }])
    expect(
      await sql`SELECT 1 FROM kernel.node_sessions WHERE org_id = ${visitor.session.orgId}`,
    ).toHaveLength(0)
  })

  it("run_on_my_computer on the recorded laptop starts the replay as this agent's dispatch", async () => {
    await prepareDemoScenario(visitor.session.orgId, visitor.session.userId, "dev")
    const ask = crypto.randomUUID()
    const res = await dispatch(visitor, ask)
    expect(res).toMatchObject({
      status: "started",
      on: REPLAY_NODE_NAME,
      folder: RECORDING.repo,
      model: RECORDING.model,
    })
    const [session] = await sql<
      Array<{
        id: string
        source: string
        agent_id: string
        source_thread_id: string | null
        source_message_id: string | null
        title: string
      }>
    >`SELECT id, source, agent_id, source_thread_id, source_message_id, title
        FROM kernel.node_sessions WHERE org_id = ${visitor.session.orgId}`
    expect(session).toMatchObject({
      id: res.sessionId,
      source: "dispatch",
      agent_id: visitor.agentId,
      source_thread_id: visitor.threadId,
      title: RECORDING.title,
    })
    const [job] = await sql<Array<{ source: string; thread_id: string; source_ref: string }>>`
      SELECT source, thread_id, source_ref FROM kernel.node_jobs WHERE id = (
        SELECT job_id FROM kernel.node_sessions WHERE id = ${session.id})`
    expect(job).toEqual({
      source: "dispatch",
      thread_id: visitor.threadId,
      source_ref: REPLAY_SOURCE_REF,
    })
    // The one card in the conversation, which the finished session reports under.
    const cards = await sql<Array<{ id: string; metadata: Record<string, unknown> }>>`
      SELECT id, metadata FROM kernel.messages
       WHERE thread_id = ${visitor.threadId} AND author_type = 'agent'`
    expect(cards).toHaveLength(1)
    expect(cards[0].metadata).toMatchObject({ kind: "node_session", sessionId: session.id })
    expect(session.source_message_id).toBe(cards[0].id)

    // The scenario's dispatch beat completes on it, and only for this run's ask.
    const event = await createdEvent(session.id)
    const created = { "ask-dispatch": ask, [RUN_CONVERSATION]: visitor.threadId }
    const binding = beat("dispatch").event!
    expect(bindingMatches(binding, event, created)).toBe(true)
    expect(actorSatisfies(binding, event, visitor.session.userId)).toBe(true)
    expect(
      bindingMatches(binding, event, { ...created, "ask-dispatch": crypto.randomUUID() }),
    ).toBe(false)
  })

  it("a dispatch that parked for approval: approved, its session completes the approve beat and becomes {dispatch}", async () => {
    await prepareDemoScenario(visitor.session.orgId, visitor.session.userId, "dev")
    const [approval] = await sql<{ id: string }[]>`
      INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, status, reason)
      VALUES (${visitor.session.orgId}, ${`dev-${crypto.randomUUID()}`}, ${visitor.threadId},
              ${visitor.threadId}, 'kernel:run_on_my_computer', '{}'::jsonb, '{}'::jsonb,
              now() + interval '1 day', ${visitor.session.userId}, 'approved', 'taint_escalation')
      RETURNING id`
    // The approval runs in its own turn, which answers no message of this run.
    const res = await dispatch(visitor, crypto.randomUUID(), { approvalRequestId: approval.id })
    expect(res).toMatchObject({ status: "started", on: REPLAY_NODE_NAME })
    const [meta] = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM kernel.approval_requests WHERE id = ${approval.id}`
    expect(meta.metadata).toMatchObject({ nodeSessionId: res.sessionId })

    // The run stands on approve-dispatch: dispatch completed on the approval (held).
    const state: TourState = {
      status: "active",
      beatId: "approve-dispatch",
      beatIndex: beats.findIndex((b) => b.id === "approve-dispatch"),
      beatStates: {
        [RUN_CONVERSATION]: { state: "done", entityId: visitor.threadId },
        "ask-dispatch": { state: "done", entityId: crypto.randomUUID() },
        dispatch: { state: "done", entityId: approval.id, held: true },
      },
    }
    const event = await createdEvent(res.sessionId as string)
    const binding = beat("approve-dispatch").event!
    const created = { [RUN_CONVERSATION]: visitor.threadId, dispatch: approval.id }
    expect(bindingMatches(binding, event, created)).toBe(true)
    expect(actorSatisfies(binding, event, visitor.session.userId)).toBe(true)
    // Another conversation's session does not complete it.
    expect(
      bindingMatches(binding, event, { ...created, [RUN_CONVERSATION]: crypto.randomUUID() }),
    ).toBe(false)
    const move = completeDoBeat(beats, state, event.entityId)
    expect(move?.next.beatStates.dispatch).toEqual({
      state: "done",
      entityId: res.sessionId as string,
    })
    expect(move?.next.beatId).toBe("stream")
  })

  it("the approval card names the recorded laptop", async () => {
    await prepareDemoScenario(visitor.session.orgId, visitor.session.userId, "dev")
    const card = await summarizeRunOnMyComputer(
      { task: "Fix the battery bug" },
      { orgId: visitor.session.orgId, userId: visitor.session.userId },
    )
    expect(card).toMatchObject({ title: `Run on ${REPLAY_NODE_NAME}`, subtitle: REPLAY_NODE_NAME })
  })

  it("before the scenario's start, a demo visitor's dispatch starts nothing", async () => {
    const res = await dispatch(visitor, crypto.randomUUID())
    expect(res).toMatchObject({ status: "refused", reason: "no_node" })
    expect(
      await sql`SELECT 1 FROM kernel.node_sessions WHERE org_id = ${visitor.session.orgId}`,
    ).toHaveLength(0)
  })

  it("outside a demo org: no recorded laptop is made, the dispatch is refused and writes nothing", async () => {
    await prepareDemoScenario(regular.session.orgId, regular.session.userId, "dev")
    const res = await dispatch(regular, crypto.randomUUID())
    expect(res).toMatchObject({ status: "refused", reason: "no_node" })
    const [n] = await sql<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM kernel.nodes WHERE org_id = ${regular.session.orgId})
           + (SELECT count(*) FROM kernel.node_jobs WHERE org_id = ${regular.session.orgId})
           + (SELECT count(*) FROM kernel.node_sessions WHERE org_id = ${regular.session.orgId}) AS n`
    expect(Number(n.n)).toBe(0)
  })
})

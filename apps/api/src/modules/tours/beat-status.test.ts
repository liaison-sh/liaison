// SPDX-License-Identifier: FSL-1.1-ALv2
// The tour step status (`TourBeatStatus`) is computed by the server from its
// own rows, in one place. Live demo 2026-10-26: the support scenario's card
// kept saying the routine ran after its step was done (it read remembered
// frames), and a web search the agent parked for approval left a step waiting
// with nothing telling the person to approve.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  defineTour,
  type EffectiveBeat,
  effectiveBeats,
  RUN_CONVERSATION,
  type TourProgress,
} from "@liaison/shared"
import { sql } from "~/db"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { redis } from "~/lib/redis"
import {
  AgentStreamRegistryTestAccess,
  LiveTurnRegistry,
  LiveTurnTimeout,
  recordAgentStreamEvent,
  recordAgentTurnAccepted,
} from "~/modules/agent/runtime/stream-registry"
import {
  BeatStatusTestAccess,
  computeBeatStatus,
  noteRoutineRunEnded,
  noteRoutineRunStarted,
  withBeatStatus,
} from "~/modules/tours/beat-status"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const tour = defineTour({
  id: "kernel.beat-status-fixture",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "live-ticket",
      kind: "world",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      injector: "fixture-injector",
    },
    {
      id: "routine-note",
      kind: "do",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      event: {
        app: "tickets",
        entity: "note",
        action: "create",
        match: { ticketId: "{live-ticket}" },
        actor: "any",
      },
      autoplay: [{ waitEvent: true }],
    },
    {
      // Approving the draft the routine staged on this run's ticket.
      id: "approve-draft",
      kind: "do",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      event: {
        app: "kernel",
        entity: "approval_request",
        action: "update",
        match: { status: "approved", "currentPayload.ticketId": "{live-ticket}" },
      },
      waitsOn: "routine",
      autoplay: [{ waitEvent: true }],
    },
    {
      // The routine's work shown on screen: no event of its own, it reads the
      // run the step before names (the reply the routine drafted).
      id: "routine-drafted",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-draft",
      waitsOn: "routine",
    },
    {
      id: "ask",
      kind: "do",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ waitEvent: true }],
    },
    {
      id: "answer",
      kind: "do",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      event: {
        app: "kernel",
        entity: "message",
        action: "create",
        actor: "user-or-agent",
        causedBy: "ask",
      },
      autoplay: [{ waitEvent: true }],
    },
    {
      id: "searching",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-answer",
      waitsOn: "agent",
    },
    {
      // The answer to the question `ask` recorded (support's "Its answer").
      id: "read-answer",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-answer[data-turn-id={ask}]",
      waitsOn: "agent",
    },
  ],
})

const beats = effectiveBeats(tour, { installedApps: [], isDemo: true })
const beat = (id: string) => beats.find((b) => b.id === id) as EffectiveBeat

let orgId: string
let userId: string
let dm: string
let ticket: string
let routineId: string

function at(beatId: string, beatStates: TourProgress["beatStates"] = {}): TourProgress {
  return {
    tourId: tour.id,
    status: "active",
    beatId,
    beatIndex: beats.findIndex((b) => b.id === beatId),
    beatCount: beats.length,
    beatStates: {
      "live-ticket": { state: "done", entityId: ticket },
      [RUN_CONVERSATION]: { state: "done", entityId: dm },
      ...beatStates,
    },
    source: "demo",
    // The run began a minute ago: rows from before it are another run's.
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const status = (progress: TourProgress) =>
  computeBeatStatus({ orgId, userId, progress, beat: beat(progress.beatId as string) })

async function runRow(status: string, error: string | null, startedAgoMs: number): Promise<void> {
  await sql`INSERT INTO kernel.routine_runs
      (org_id, routine_id, status, ran_at, started_at, duration_ms, error, event_entity_id)
    VALUES (${orgId}, ${routineId}, ${status}, now(),
      now() - (${startedAgoMs} || ' milliseconds')::interval, ${startedAgoMs}, ${error}, ${ticket})`
}

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  userId = crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${userId}, ${orgId}, ${`beat-status-${userId}@test.com`}, 'Alice')`
  dm = await minimal.thread(orgId, userId)
  ticket = crypto.randomUUID()
  routineId = crypto.randomUUID()
  await sql`INSERT INTO kernel.routines
      (id, org_id, owner_user_id, name, description, kind, event, prompt, scopes, created_by_actor_type)
    VALUES (${routineId}, ${orgId}, ${userId}, 'Draft a reply to new tickets', 'support', 'event',
      'tickets:ticket:create', 'reply', ${sql.array(["tickets:tickets:read"])}, 'user')`
})

afterEach(async () => {
  await AgentStreamRegistryTestAccess.reset()
})

describe("a step waiting on a routine", () => {
  it("a long run that succeeded: running while it runs, then succeeded, never running again", async () => {
    expect((await status(at("routine-note"))).kind).toBe("pending")
    const startedAt = new Date(Date.now() - 77_000).toISOString()
    await noteRoutineRunStarted({
      orgId,
      routineId,
      routineName: "Draft a reply to new tickets",
      eventEntityId: ticket,
      startedAt,
    })
    expect(await status(at("routine-note"))).toEqual({
      kind: "routine-running",
      routineName: "Draft a reply to new tickets",
      startedAt,
    })
    await runRow("succeeded", null, 77_000)
    // The row alone already says it finished, before its end frame landed.
    expect((await status(at("routine-note"))).kind).toBe("routine-succeeded")
    await noteRoutineRunEnded({ orgId, routineId, eventEntityId: ticket })
    expect(await status(at("routine-note"))).toEqual({
      kind: "routine-succeeded",
      routineName: "Draft a reply to new tickets",
    })
  })

  it("the step recorded done is done, whatever still runs", async () => {
    await noteRoutineRunStarted({
      orgId,
      routineId,
      routineName: "Draft a reply to new tickets",
      eventEntityId: ticket,
      startedAt: new Date().toISOString(),
    })
    const done = at("routine-note", { "routine-note": { state: "done", entityId: "n-1" } })
    expect(await status(done)).toEqual({ kind: "done", held: false })
  })

  it("failed and skipped runs say so, with the reason the run row keeps", async () => {
    await runRow("failed", "The model provider refused the request.", 5_000)
    expect(await status(at("routine-note"))).toEqual({
      kind: "routine-failed",
      routineName: "Draft a reply to new tickets",
      error: "The model provider refused the request.",
    })
    await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${orgId}`
    await runRow("skipped_no_credits", "No model is set up for this workspace.", 0)
    expect(await status(at("routine-note"))).toEqual({
      kind: "routine-skipped",
      routineName: "Draft a reply to new tickets",
      status: "skipped_no_credits",
      error: "No model is set up for this workspace.",
    })
  })

  // Sales walk 2026-10-27: the step approving what the routine staged showed
  // "The routine has finished" with a check while its card still waited, and
  // the person read the step as done.
  it("a step approving what the routine staged waits on the person once the run succeeded", async () => {
    const startedAt = new Date(Date.now() - 5_000).toISOString()
    await noteRoutineRunStarted({
      orgId,
      routineId,
      routineName: "Draft a reply to new tickets",
      eventEntityId: ticket,
      startedAt,
    })
    // Still running: the card is not there yet, the step says the routine works.
    expect((await status(at("approve-draft"))).kind).toBe("routine-running")
    await runRow("succeeded", null, 5_000)
    await noteRoutineRunEnded({ orgId, routineId, eventEntityId: ticket })
    expect(await status(at("approve-draft"))).toEqual({ kind: "pending" })
    // A run paused on the approval it asked for waits on the person, never "failed".
    await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${orgId}`
    await runRow("waiting_approval", null, 5_000)
    expect(await status(at("approve-draft"))).toEqual({ kind: "pending" })
    expect(await status(at("routine-note"))).toEqual({ kind: "pending" })
    // A run that failed still says so: there may be nothing to approve.
    await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${orgId}`
    await runRow("failed", "The model provider refused the request.", 5_000)
    expect((await status(at("approve-draft"))).kind).toBe("routine-failed")
  })

  it("a run on another ticket, or from before the run began, says nothing", async () => {
    await sql`INSERT INTO kernel.routine_runs (org_id, routine_id, status, ran_at, event_entity_id)
      VALUES (${orgId}, ${routineId}, 'failed', now(), ${crypto.randomUUID()}),
             (${orgId}, ${routineId}, 'failed', now() - interval '1 hour', ${ticket})`
    expect((await status(at("routine-note"))).kind).toBe("pending")
  })
})

describe("a show step waiting on a routine, naming no run", () => {
  const shown = (progress: TourProgress) =>
    computeBeatStatus({ orgId, userId, progress, beat: beat("routine-drafted"), beats })

  it("reads the run the earlier routine step names", async () => {
    expect((await shown(at("routine-drafted"))).kind).toBe("pending")
    await noteRoutineRunStarted({
      orgId,
      routineId,
      routineName: "Draft a reply to new tickets",
      eventEntityId: ticket,
      startedAt: new Date().toISOString(),
    })
    expect((await shown(at("routine-drafted"))).kind).toBe("routine-running")
    await noteRoutineRunEnded({ orgId, routineId, eventEntityId: ticket })
  })

  it("a run resumed after its approval works again; paused again, it waits", async () => {
    const resumingAt = new Date().toISOString()
    await sql`INSERT INTO kernel.routine_runs (org_id, routine_id, status, ran_at, event_entity_id, pause_state)
      VALUES (${orgId}, ${routineId}, 'waiting_approval', now(), ${ticket},
        ${JSON.stringify({ approvalIds: ["a-1"], resumeCount: 0 })}::jsonb)`
    expect((await shown(at("routine-drafted"))).kind).toBe("pending")
    await sql`UPDATE kernel.routine_runs
      SET pause_state = pause_state || ${JSON.stringify({ resumingAt, approvalIds: [] })}::jsonb
      WHERE org_id = ${orgId}`
    expect(await shown(at("routine-drafted"))).toEqual({
      kind: "routine-running",
      routineName: "Draft a reply to new tickets",
      startedAt: resumingAt,
    })
    // A re-pause writes a fresh pause state, without `resumingAt`.
    await sql`UPDATE kernel.routine_runs
      SET pause_state = ${JSON.stringify({ approvalIds: ["a-2"], resumeCount: 1 })}::jsonb
      WHERE org_id = ${orgId}`
    expect((await shown(at("routine-drafted"))).kind).toBe("pending")
  })
})

describe("a step waiting on the person's agent", () => {
  const asked = async () => {
    const id = crypto.randomUUID()
    await sql`INSERT INTO kernel.messages (id, org_id, thread_id, author_id, author_type, content, required_scopes)
      VALUES (${id}, ${orgId}, ${dm}, ${userId}, 'user', 'Break it down', '{}')`
    return id
  }

  it("agent-working while the server runs the turn, pending once it ended", async () => {
    const ask = await asked()
    const progress = at("answer", { ask: { state: "done", entityId: ask } })
    expect((await status(progress)).kind).toBe("pending")
    const turn = await recordAgentTurnAccepted(dm, orgId, {
      agentId: null,
      turnId: ask,
      requesterId: userId,
    })
    expect((await status(progress)).kind).toBe("agent-working")
    await turn.withdraw()
    expect((await status(progress)).kind).toBe("pending")
    // Another person's turn in the room is not this step's.
    await recordAgentStreamEvent(dm, orgId, "start", {}, { requesterId: crypto.randomUUID() })
    expect((await status(progress)).kind).toBe("pending")
  })

  it("a step showing the answer is agent-working while the question's turn runs, in the question's own conversation", async () => {
    const ask = await asked()
    // No run conversation recorded (a tour asking from the dock's agent row):
    // the conversation is the one the question was posted in.
    const progress = at("read-answer", { ask: { state: "done", entityId: ask } })
    delete progress.beatStates[RUN_CONVERSATION]
    expect((await status(progress)).kind).toBe("pending")
    const turn = await recordAgentTurnAccepted(dm, orgId, {
      agentId: null,
      turnId: ask,
      requesterId: userId,
    })
    expect((await status(progress)).kind).toBe("agent-working")
    await turn.withdraw()
    expect((await status(progress)).kind).toBe("pending")
  })

  it("a tool call the turn parked for approval: held-for-approval with that request, then working, then done", async () => {
    const ask = await asked()
    const searching = at("searching", { ask: { state: "done", entityId: ask } })
    const [req] = await sql`INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, reason)
      VALUES (${orgId}, ${`req-${crypto.randomUUID()}`}, ${dm}, ${dm}, 'web_search', '{}'::jsonb,
        '{}'::jsonb, now() + interval '1 day', ${userId}, 'The conversation read data others cannot see')
      RETURNING id`
    const requestId = (req as { id: string }).id
    expect(await status(searching)).toEqual({
      kind: "held-for-approval",
      requestId,
      toolName: "web_search",
      reason: "The conversation read data others cannot see",
    })
    // A do step waiting on the turn is held the same way.
    const answer = at("answer", { ask: { state: "done", entityId: ask } })
    expect((await status(answer)).kind).toBe("held-for-approval")
    await sql`UPDATE kernel.approval_requests SET status = 'approved' WHERE id = ${requestId}`
    await recordAgentTurnAccepted(dm, orgId, { agentId: null, turnId: ask, requesterId: userId })
    expect((await status(answer)).kind).toBe("agent-working")
    const done = at("answer", {
      ask: { state: "done", entityId: ask },
      answer: { state: "done", entityId: "m-2" },
    })
    expect(await status(done)).toEqual({ kind: "done", held: false })
  })

  it("an approval from before the run began, or someone else's, holds nothing", async () => {
    const ask = await asked()
    const other = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${other}, ${orgId}, ${`beat-status-${other}@test.com`}, 'Bob')`
    await sql`INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, created_at)
      VALUES (${orgId}, ${`req-${crypto.randomUUID()}`}, ${dm}, ${dm}, 'web_search', '{}'::jsonb,
        '{}'::jsonb, now() + interval '1 day', ${userId}, now() - interval '1 hour'),
             (${orgId}, ${`req-${crypto.randomUUID()}`}, ${dm}, ${dm}, 'web_search', '{}'::jsonb,
        '{}'::jsonb, now() + interval '1 day', ${other}, now())`
    expect((await status(at("searching", { ask: { state: "done", entityId: ask } }))).kind).toBe(
      "pending",
    )
  })
})

describe("the agent status reads the cell-wide registry", () => {
  it("agentStatus reads the cell-wide registry: a turn another process runs is agent-working", async () => {
    const instanceId = `other-${crypto.randomUUID()}`
    await redis.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 30_000)
    const other = new LiveTurnRegistry({ instanceId })
    const vis = { agentId: null, turnId: crypto.randomUUID(), requesterId: userId }
    expect((await BeatStatusTestAccess.agentStatus(orgId, userId, [dm])).kind).toBe("pending")
    await other.record(dm, orgId, "start", {}, vis)
    expect((await BeatStatusTestAccess.agentStatus(orgId, userId, [dm])).kind).toBe("agent-working")
    await other.record(dm, orgId, "done", {}, vis)
    expect((await BeatStatusTestAccess.agentStatus(orgId, userId, [dm])).kind).toBe("pending")
  })

  it("a registry read Redis does not answer says pending", async () => {
    const status = await BeatStatusTestAccess.agentStatus(orgId, userId, [dm], () =>
      Promise.reject(new LiveTurnTimeout("list live turns", 1_000)),
    )
    expect(status).toEqual({ kind: "pending" })
  })
})

describe("the progress the routes return", () => {
  it("carries the step's status on an active run, none on a paused one", async () => {
    const active = await withBeatStatus(orgId, userId, at("routine-note"), beats)
    expect(active.beatStatus).toEqual({ kind: "pending" })
    const paused = await withBeatStatus(
      orgId,
      userId,
      { ...at("routine-note"), status: "paused" },
      beats,
    )
    expect(paused.beatStatus).toBeUndefined()
  })
})

// Live demo: the question the support scenario asks was refused before its
// turn ran (a demo spend refusal); the step showing the answer kept saying
// the agent was working, and still did after the person asked "?" and got an
// answer. A turn that ended without an answer says so (`agent-failed`), and a
// later answered message of the person's takes the step over.
describe("a step waiting on the answer to a question whose turn got none", () => {
  /** A message of the person's in the DM, `agoMs` ago. */
  const said = async (content: string, agoMs: number) => {
    const id = crypto.randomUUID()
    await sql`INSERT INTO kernel.messages
        (id, org_id, thread_id, author_id, author_type, content, required_scopes, created_at)
      VALUES (${id}, ${orgId}, ${dm}, ${userId}, 'user', ${content}, '{}',
        now() - (${agoMs} || ' milliseconds')::interval)`
    return id
  }
  /** The person's agent's answer to `askId`, in `threadId`. */
  const answered = async (askId: string, agoMs: number, threadId = dm) => {
    const [agent] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${orgId}, 'role', ${`@bs-${crypto.randomUUID().slice(0, 8)}`}, 'Agent', '["*"]'::jsonb)
      RETURNING id`
    await sql`INSERT INTO kernel.messages
        (org_id, thread_id, author_id, author_type, author_agent_id, content, required_scopes, metadata, created_at)
      VALUES (${orgId}, ${threadId}, ${userId}, 'agent', ${(agent as { id: string }).id},
        'Two orders last spring.', '{}', ${JSON.stringify({ askId })}::jsonb,
        now() - (${agoMs} || ' milliseconds')::interval)`
  }
  const refusedLine = async (agoMs: number) => {
    await sql`INSERT INTO kernel.messages
        (org_id, thread_id, author_id, author_type, content, required_scopes, metadata, created_at)
      VALUES (${orgId}, ${dm}, ${userId}, 'system', 'The demo budget is used up for today.', '{}',
        ${JSON.stringify({ demoRefusal: "demo_budget_exhausted" })}::jsonb,
        now() - (${agoMs} || ' milliseconds')::interval)`
  }
  const readAnswer = (ask: string) => {
    const progress = at("read-answer", { ask: { state: "done", entityId: ask } })
    delete progress.beatStates[RUN_CONVERSATION]
    return progress
  }

  it("a turn refused before it ran: agent-failed with the refusal's words and the question", async () => {
    const ask = await said("What did this customer buy?", 3_000)
    expect((await status(readAnswer(ask))).kind).toBe("pending")
    await refusedLine(2_000)
    expect(await status(readAnswer(ask))).toEqual({
      kind: "agent-failed",
      threadId: dm,
      askId: ask,
      question: "What did this customer buy?",
      message: "The demo budget is used up for today.",
      code: "demo_budget_exhausted",
    })
    // A do step whose turn the question started says the same.
    expect((await status(at("answer", { ask: { state: "done", entityId: ask } }))).kind).toBe(
      "agent-failed",
    )
  })

  it("a turn that failed (its audit row, its turn row) says so; one before the question does not", async () => {
    await sql`INSERT INTO kernel.audit_log (org_id, actor_id, actor_type, app, entity_type, entity_id, action, metadata, timestamp)
      VALUES (${orgId}, ${userId}, 'agent', 'kernel', 'thread', ${dm}, 'agent.turn.failed',
        ${JSON.stringify({ threadId: dm, error: "earlier" })}::jsonb, now() - interval '1 hour')`
    const ask = await said("What did this customer buy?", 3_000)
    expect((await status(readAnswer(ask))).kind).toBe("pending")
    await sql`INSERT INTO kernel.agent_turns (org_id, thread_id, origin, user_message_id, state, runner_instance_id, error_code)
      VALUES (${orgId}, ${dm}, 'thread', ${ask}, 'failed', 'gone', 'provider_error')`
    expect(await status(readAnswer(ask))).toMatchObject({ kind: "agent-failed", message: null })
    await sql`INSERT INTO kernel.audit_log (org_id, actor_id, actor_type, app, entity_type, entity_id, action, metadata)
      VALUES (${orgId}, ${userId}, 'agent', 'kernel', 'thread', ${dm}, 'agent.turn.failed',
        ${JSON.stringify({ threadId: dm, error: "No model is set up." })}::jsonb)`
    expect(await status(readAnswer(ask))).toMatchObject({
      kind: "agent-failed",
      askId: ask,
      message: "No model is set up.",
      code: null,
    })
  })

  it("asked again (Try again): the step waits on the new message's turn, not the refused one", async () => {
    const ask = await said("What did this customer buy?", 5_000)
    await refusedLine(4_000)
    expect((await status(readAnswer(ask))).kind).toBe("agent-failed")
    const again = await said("What did this customer buy?", 1_000)
    expect((await status(readAnswer(ask))).kind).toBe("pending")
    const turn = await recordAgentTurnAccepted(dm, orgId, {
      agentId: null,
      turnId: again,
      requesterId: userId,
    })
    expect((await status(readAnswer(ask))).kind).toBe("agent-working")
    await turn.withdraw()
  })

  it("a later message of the person's that got an answer takes the step over (its anchor follows it)", async () => {
    const ask = await said("What did this customer buy?", 5_000)
    await refusedLine(4_000)
    const progress = readAnswer(ask)
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source, started_at)
      VALUES (${orgId}, ${userId}, ${tour.id}, 'active', 'read-answer', ${progress.beatIndex},
        ${JSON.stringify(progress.beatStates)}::jsonb, 'demo', ${progress.startedAt})`
    const failed = await withBeatStatus(orgId, userId, progress, beats)
    expect(failed.beatStatus?.kind).toBe("agent-failed")
    expect(failed.beatStates.ask).toEqual({ state: "done", entityId: ask })

    const later = await said("?", 2_000)
    await answered(later, 1_000)
    const followed = await withBeatStatus(orgId, userId, progress, beats)
    expect(followed.beatStates.ask).toEqual({ state: "done", entityId: later })
    expect(followed.beatStatus).toEqual({ kind: "pending" })
    const [row] = await sql`SELECT beat_states FROM kernel.tour_progress
      WHERE org_id = ${orgId} AND user_id = ${userId} AND tour_id = ${tour.id}`
    expect((row as { beat_states: TourProgress["beatStates"] }).beat_states.ask).toEqual({
      state: "done",
      entityId: later,
    })
  })

  it("someone else's message, or one in another conversation, takes nothing over", async () => {
    const ask = await said("What did this customer buy?", 5_000)
    await refusedLine(4_000)
    const elsewhere = await minimal.thread(orgId, userId)
    const other = crypto.randomUUID()
    await sql`INSERT INTO kernel.messages (id, org_id, thread_id, author_id, author_type, content, required_scopes)
      VALUES (${other}, ${orgId}, ${elsewhere}, ${userId}, 'user', '?', '{}')`
    await answered(other, 0, elsewhere)
    const progress = readAnswer(ask)
    const read = await withBeatStatus(orgId, userId, progress, beats)
    expect(read.beatStates.ask).toEqual({ state: "done", entityId: ask })
    expect(read.beatStatus?.kind).toBe("agent-failed")
  })
})

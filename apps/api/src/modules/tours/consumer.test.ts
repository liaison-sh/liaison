// SPDX-License-Identifier: FSL-1.1-ALv2
// tour-progress: a do beat completes on its product event (S23), by any path,
// only for the tour's owner, only once per event, and the owner is told.
import { beforeEach, describe, expect, it } from "bun:test"
import {
  bindingScopedToRun,
  findTour,
  RUN_CONVERSATION,
  type Tour,
  type TourEventBinding,
} from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { AppEvent } from "~/infra/events/event-bus"
import {
  AgentStreamRegistryTestAccess,
  recordAgentStreamEvent,
} from "~/modules/agent/runtime/stream-registry"
import { setTaintFlag, untrustedTurnNeedsApproval } from "~/modules/agent/scopes/taint"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import {
  actorSatisfies,
  beatDoneAhead,
  bindingMatches,
  eventMayOwnTour,
  handleTourProgressEvent,
  reconcileCurrentBeat,
  settleTurnsEndedBeats,
  turnFollowsAsk,
} from "~/modules/tours/consumer"
import { personalAgentDmId } from "~/modules/tours/conversation"
import {
  applyTourMove,
  loadTourOrgContext,
  progressOf,
  startTour,
  tourBeats,
} from "~/modules/tours/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const TOUR = findTour("kernel.sample", { includeTestTours: true }) as Tour

let orgId: string
let otherOrgId: string
let alice: string
let bob: string

/**
 * Alice presses Next in `tourId`: a step that announced someone else's work
 * (a routine's, the agent's) stays on screen once it arrived, to be read.
 */
async function aliceNext(tourId: string, isDemo?: boolean): Promise<void> {
  const ctx = await loadTourOrgContext(orgId)
  const beats = tourBeats(findTour(tourId) as Tour, { ...ctx, isDemo: isDemo ?? ctx.isDemo })
  const [r] = await sql`SELECT status, beat_id, beat_index, beat_states FROM kernel.tour_progress
    WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
  const row = r as {
    status: "active"
    beat_id: string
    beat_index: number
    beat_states: Record<string, never>
  }
  const move = applyTourMove(
    beats,
    {
      status: row.status,
      beatId: row.beat_id,
      beatIndex: row.beat_index,
      beatStates: row.beat_states,
    },
    { advance: true },
  )
  if (!move.ok) throw new Error(`Next refused: ${move.code}`)
  await sql`UPDATE kernel.tour_progress SET status = ${move.next.status},
      beat_id = ${move.next.beatId}, beat_index = ${move.next.beatIndex},
      beat_states = ${JSON.stringify(move.next.beatStates)}::jsonb
    WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
}

async function user(org: string, name: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${id}, ${org}, ${`tour-c-${id}@test.com`}, ${name})`
  return id
}

/** Alice's sample tour, standing on the post-message do beat. */
async function aliceOnDoBeat(status: "active" | "paused" = "active"): Promise<void> {
  const ctx = await loadTourOrgContext(orgId)
  await withPrivilegedDb(orgId, "tour-consumer-test", (tx) =>
    startTour(tx, {
      orgId,
      userId: alice,
      tour: TOUR,
      beats: tourBeats(TOUR, ctx),
      source: "cli",
      actor: { userId: alice, actorType: "user" },
    }),
  )
  await sql`UPDATE kernel.tour_progress
    SET beat_id = 'post-message', beat_index = 1, beat_states = '{"welcome":"done"}'::jsonb,
        status = ${status}
    WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${TOUR.id}`
}

async function aliceRow(): Promise<{
  beat_id: string | null
  status: string
  beat_states: unknown
}> {
  const [row] = await sql`SELECT beat_id, status, beat_states FROM kernel.tour_progress
    WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${TOUR.id}`
  return row as { beat_id: string | null; status: string; beat_states: unknown }
}

function messageEvent(over: Partial<AppEvent> = {}): AppEvent {
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: crypto.randomUUID(),
    orgId,
    actorId: alice,
    actorType: "user",
    data: { threadId: crypto.randomUUID(), content: "hi" },
    ...over,
  }
}

const deliver = (event: AppEvent, eventId: string = crypto.randomUUID()) =>
  handleTourProgressEvent({ eventId, event })

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  // createTestOrg truncates the org tables, so the second org is a plain row.
  otherOrgId = crypto.randomUUID()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${otherOrgId}, 'Other', ${`tour-other-${otherOrgId}`})`
  alice = await user(orgId, "Alice")
  bob = await user(orgId, "Bob")
})

describe("tour-progress consumer", () => {
  it("the owner's matching event completes the do beat and pushes kernel/tour:update to them", async () => {
    await aliceOnDoBeat()
    const event = messageEvent()
    await deliver(event)
    // The completed beat keeps the entity its event named, so a later beat's
    // autoplay works on what the tour created.
    expect(await aliceRow()).toMatchObject({
      beat_id: "tickets-inbox",
      status: "active",
      beat_states: {
        welcome: "done",
        "post-message": { state: "done", entityId: event.entityId },
      },
    })
    const frames = await sql`SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'tour' AND payload->>'action' = 'update'`
    expect(frames).toHaveLength(1)
    expect(frames[0]!.payload.data).toMatchObject({
      ownerUserId: alice,
      tourId: TOUR.id,
      status: "active",
      beatId: "tickets-inbox",
      beatIndex: 2,
    })
  })

  it("a redelivered event advances once", async () => {
    await aliceOnDoBeat()
    const eventId = crypto.randomUUID()
    const event = messageEvent()
    await deliver(event, eventId)
    // Put Alice back on the do beat: the same event, delivered again, is not news.
    await sql`UPDATE kernel.tour_progress SET beat_id = 'post-message', beat_index = 1
      WHERE org_id = ${orgId} AND user_id = ${alice}`
    await deliver(event, eventId)
    expect((await aliceRow()).beat_id).toBe("post-message")
    // A new event does advance.
    await deliver(messageEvent())
    expect((await aliceRow()).beat_id).toBe("tickets-inbox")
  })

  it("another member's event, another org's, an agent's (actor user), another action and a paused tour change nothing", async () => {
    await aliceOnDoBeat()
    await deliver(messageEvent({ actorId: bob }))
    await deliver(messageEvent({ orgId: otherOrgId }))
    await deliver(messageEvent({ actorType: "agent" }))
    await deliver(messageEvent({ actorType: "system" }))
    await deliver(messageEvent({ action: "update" }))
    await deliver(messageEvent({ actorId: null }))
    // Fail closed: no actor type is not the person's own action, and a
    // routine's run never acts for them on a tour.
    await deliver(messageEvent({ actorType: undefined }))
    await deliver(messageEvent({ metadata: { firedByRoutineId: crypto.randomUUID() } }))
    expect((await aliceRow()).beat_id).toBe("post-message")
    await aliceOnDoBeat("paused")
    await deliver(messageEvent())
    expect(await aliceRow()).toMatchObject({ beat_id: "post-message", status: "paused" })
  })

  it("the Messages tour's @agent beat completes on a message mentioning an agent, never a plain one", async () => {
    const threads = findTour("kernel.threads") as Tour
    const ctx = await loadTourOrgContext(orgId)
    await withPrivilegedDb(orgId, "tour-consumer-test", (tx) =>
      startTour(tx, {
        orgId,
        userId: alice,
        tour: threads,
        beats: tourBeats(threads, ctx),
        source: "cli",
        actor: { userId: alice, actorType: "user" },
      }),
    )
    await sql`UPDATE kernel.tour_progress SET beat_id = 'mention-agent', beat_index = 3
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${threads.id}`
    const beatOf = async () =>
      (
        await sql`SELECT beat_id FROM kernel.tour_progress
          WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${threads.id}`
      )[0]?.beat_id
    await deliver(messageEvent({ data: { threadId: crypto.randomUUID(), mentionsAgent: false } }))
    await deliver(messageEvent({ data: { threadId: crypto.randomUUID() } }))
    expect(await beatOf()).toBe("mention-agent")
    await deliver(messageEvent({ data: { threadId: crypto.randomUUID(), mentionsAgent: true } }))
    expect(await beatOf()).toBe("agent-answers")
  })

  it("the Tickets tour's note beat completes on tickets/note:create, never on a message:create", async () => {
    const tickets = findTour("tickets.basics") as Tour
    const ctx = await loadTourOrgContext(orgId)
    await withPrivilegedDb(orgId, "tour-consumer-test", (tx) =>
      startTour(tx, {
        orgId,
        userId: alice,
        tour: tickets,
        beats: tourBeats(tickets, ctx),
        source: "cli",
        actor: { userId: alice, actorType: "user" },
        conversationId: crypto.randomUUID(),
      }),
    )
    await sql`UPDATE kernel.tour_progress SET beat_id = 'note', beat_index = 4
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tickets.id}`
    const beatOf = async () =>
      (
        await sql`SELECT beat_id FROM kernel.tour_progress
          WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tickets.id}`
      )[0]?.beat_id
    const ticketEvent = (entity: string) =>
      messageEvent({
        app: "tickets",
        entity,
        data: { ticketId: crypto.randomUUID(), kind: "note" },
      })
    await deliver(ticketEvent("message"))
    expect(await beatOf()).toBe("note")
    // The agent writes it for Alice, who asked (actorType agent, Alice the actor).
    // Written at once, nothing waits for approval: approve-note is passed.
    await deliver({ ...ticketEvent("note"), actorType: "agent" })
    expect(await beatOf()).toBe("yourself")
  })

  // Walk 5 (D42): the agent's note read about the customer, so it parked for
  // approval, and the tour waited for a note no beat could make land.
  it("the Tickets tour's note may ask first: its approval completes the beat, approve-note approves exactly that one", async () => {
    const tickets = findTour("tickets.basics") as Tour
    const ctx = await loadTourOrgContext(orgId)
    const beats = tourBeats(tickets, ctx)
    await withPrivilegedDb(orgId, "tour-consumer-test", (tx) =>
      startTour(tx, {
        orgId,
        userId: alice,
        tour: tickets,
        beats,
        source: "cli",
        actor: { userId: alice, actorType: "user" },
        conversationId: crypto.randomUUID(),
      }),
    )
    const noteIndex = beats.findIndex((b) => b.id === "note")
    await sql`UPDATE kernel.tour_progress SET beat_id = 'note', beat_index = ${noteIndex}
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tickets.id}`
    const row = async () =>
      (
        await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
          WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tickets.id}`
      )[0] as { beat_id: string; beat_states: Record<string, unknown> }
    const approvalEvent = (action: string, data: Record<string, unknown>, over = {}) =>
      messageEvent({ entity: "approval_request", action, data, ...over })

    // Another tool's approval, or one a routine parked, is not this note's.
    await deliver(
      approvalEvent(
        "create",
        { toolName: "tickets:reply", status: "pending" },
        { actorType: "agent" },
      ),
    )
    await deliver(
      approvalEvent(
        "create",
        { toolName: "tickets:addNote", status: "pending" },
        { actorType: "agent", metadata: { firedByRoutineId: crypto.randomUUID() } },
      ),
    )
    expect((await row()).beat_id).toBe("note")

    const held = approvalEvent(
      "create",
      { toolName: "tickets:addNote", status: "pending" },
      { actorType: "agent" },
    )
    await deliver(held)
    const afterHeld = await row()
    expect(afterHeld.beat_id).toBe("approve-note")
    expect(afterHeld.beat_states.note).toEqual({
      state: "done",
      entityId: held.entityId,
      held: true,
    })

    // Approving another request does not; approving this one does.
    await deliver(
      approvalEvent(
        "update",
        { toolName: "tickets:addNote", status: "approved" },
        {
          entityId: crypto.randomUUID(),
        },
      ),
    )
    expect((await row()).beat_id).toBe("approve-note")
    await deliver(
      approvalEvent(
        "update",
        { toolName: "tickets:addNote", status: "approved" },
        {
          entityId: held.entityId,
        },
      ),
    )
    expect((await row()).beat_id).toBe("yourself")
  })

  // Walk D42: in its own turn the Projects tour's agent read data some readers
  // of a project cannot see, so creating the project parked for approval and
  // the tour, with no step to approve it, waited for ever. The ask completes
  // on that approval; approve-plan approves it, completes when the project is
  // created, and the project is what the ask's later pins then name.
  it("the Projects tour's plan may ask first: approve-plan approves it, and the created project is the run's", async () => {
    const projects = findTour("projects.basics") as Tour
    const ctx = await loadTourOrgContext(orgId)
    const beats = tourBeats(projects, ctx)
    await withPrivilegedDb(orgId, "tour-consumer-test", (tx) =>
      startTour(tx, {
        orgId,
        userId: alice,
        tour: projects,
        beats,
        source: "cli",
        actor: { userId: alice, actorType: "user" },
        conversationId: crypto.randomUUID(),
      }),
    )
    const askIndex = beats.findIndex((b) => b.id === "ask-plan")
    await sql`UPDATE kernel.tour_progress SET beat_id = 'ask-plan', beat_index = ${askIndex}
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${projects.id}`
    const row = async () =>
      (
        await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
          WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${projects.id}`
      )[0] as { beat_id: string; beat_states: Record<string, { entityId?: string }> }
    const held = messageEvent({
      entity: "approval_request",
      action: "create",
      data: { toolName: "projects:createProject", status: "pending" },
      actorType: "agent",
    })
    await deliver(held)
    expect((await row()).beat_id).toBe("approve-plan")
    // The approved write runs for Alice and creates the project.
    const created = messageEvent({
      app: "projects",
      entity: "project",
      action: "created",
      data: { name: "Autumn webinar series" },
      actorType: "agent",
    })
    await deliver(created)
    const after = await row()
    expect(after.beat_id).toBe("review")
    expect(after.beat_states["approve-plan"]?.entityId).toBe(created.entityId)
    // What the later steps pin to the plan is the project, not its approval.
    expect(after.beat_states["ask-plan"]?.entityId).toBe(created.entityId)
  })

  it("the Tickets tour's draft beat completes on the agent's reply draft, the review beat on Alice approving it", async () => {
    const tickets = findTour("tickets.basics") as Tour
    const ctx = await loadTourOrgContext(orgId)
    const beats = tourBeats(tickets, ctx)
    await withPrivilegedDb(orgId, "tour-consumer-test", (tx) =>
      startTour(tx, {
        orgId,
        userId: alice,
        tour: tickets,
        beats,
        source: "cli",
        actor: { userId: alice, actorType: "user" },
        conversationId: crypto.randomUUID(),
      }),
    )
    const askIndex = beats.findIndex((b) => b.id === "ask-draft")
    await sql`UPDATE kernel.tour_progress SET beat_id = 'ask-draft', beat_index = ${askIndex}
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tickets.id}`
    const row = async () =>
      (
        await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
          WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tickets.id}`
      )[0] as { beat_id: string; beat_states: Record<string, unknown> }
    // The approval request's create event names the requester (Alice) as a user actor.
    const approvalEvent = (action: string, data: Record<string, unknown>, over = {}) =>
      messageEvent({ entity: "approval_request", action, data, ...over })

    // Another tool's draft, and the same tool's draft parked by a routine's run, complete nothing.
    await deliver(approvalEvent("create", { toolName: "mail:reply", status: "pending" }))
    await deliver(
      approvalEvent(
        "create",
        { toolName: "tickets:reply", status: "pending" },
        { metadata: { firedByRoutineId: crypto.randomUUID() } },
      ),
    )
    expect((await row()).beat_id).toBe("ask-draft")

    const draft = approvalEvent("create", { toolName: "tickets:reply", status: "pending" })
    await deliver(draft)
    const afterDraft = await row()
    expect(afterDraft.beat_id).toBe("review")
    // The draft is kept: the approve beat's autoplay presses Approve on this request only.
    expect(afterDraft.beat_states["ask-draft"]).toMatchObject({ entityId: draft.entityId })

    // Approving needs Alice's own decision on that tool: not a pending edit, not an agent.
    await deliver(approvalEvent("update", { toolName: "tickets:reply", status: "pending" }))
    await deliver(
      approvalEvent(
        "update",
        { toolName: "tickets:reply", status: "approved" },
        { actorType: "agent" },
      ),
    )
    expect((await row()).beat_id).toBe("review")
    await deliver(approvalEvent("update", { toolName: "tickets:reply", status: "approved" }))
    expect((await row()).beat_id).toBe("note")
  })

  // A sync job emits as a system actor whose id is a label, not a uuid: the progress read
  // rejected it ("invalid input syntax for type uuid") and logged an error on every sync.
  // D10: a scenario's agent and approve beats complete on what THIS run caused,
  // never on another turn's work or an approval some other scenario left.
  it("commerce: only the approval proposed by the turn answering its own ask completes, and only that one is approved", async () => {
    const tourId = "kernel.scenario-commerce"
    const askId = crypto.randomUUID()
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
      VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'prepare', 3,
        ${JSON.stringify({ "ask-agent": { state: "done", entityId: askId } })}::jsonb, 'demo')`
    const row = async () => {
      const [r] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
      return r as { beat_id: string; beat_states: Record<string, unknown> }
    }
    const approval = (
      action: "create" | "update",
      id: string,
      over: Partial<AppEvent> = {},
    ): AppEvent => ({
      app: "kernel",
      entity: "approval_request",
      action,
      entityId: id,
      orgId,
      actorId: alice,
      actorType: "user",
      data: {
        id,
        status: action === "create" ? "pending" : "approved",
        toolName: "boxtal:create_shipment",
      },
      ...over,
    })
    // Another turn's proposal (the chat scenario's web search), then one with no turn at all.
    await deliver(approval("create", crypto.randomUUID(), { metadata: { turnMessageId: "other" } }))
    await deliver(approval("create", crypto.randomUUID()))
    // The same turn's second web search, parked as an approval: not the shipment.
    await deliver(
      approval("create", crypto.randomUUID(), {
        metadata: { turnMessageId: askId },
        data: { status: "pending", toolName: "kernel:web_search" },
      }),
    )
    expect((await row()).beat_id).toBe("prepare")
    const own = crypto.randomUUID()
    await deliver(approval("create", own, { metadata: { turnMessageId: askId } }))
    // The agent's proposal arrived: the step stays, to be read, until Next.
    expect((await row()).beat_id).toBe("prepare")
    expect((await row()).beat_states.prepare).toEqual({ state: "done", entityId: own })
    await aliceNext(tourId)
    expect((await row()).beat_id).toBe("approve")
    // Approving an unrelated pending approval does not count; approving the proposal does.
    await deliver(approval("update", crypto.randomUUID()))
    expect((await row()).beat_id).toBe("approve")
    await deliver(approval("update", own))
    const done = await row()
    expect(done.beat_id).toBe("done")
    expect(done.beat_states.approve).toEqual({ state: "done", entityId: own })
  })

  it("two scenarios played in a row both talk to the person's one DM with their agent, never a new conversation", async () => {
    // Scenarios start in a demo org only.
    await markOrgAsDemo(orgId, visitorMarker(24))
    const ctx = await loadTourOrgContext(orgId)
    const start = async (tourId: string) => {
      const tour = findTour(tourId) as Tour
      // What the start route does: find the person's DM with their agent, then start.
      const conversationId = await personalAgentDmId(orgId, alice)
      await withPrivilegedDb(orgId, "tour-consumer-test", (tx) =>
        startTour(tx, {
          orgId,
          userId: alice,
          tour,
          beats: tourBeats(tour, ctx),
          source: "demo",
          actor: { userId: alice, actorType: "user" },
          conversationId,
        }),
      )
      const [row] = await sql`SELECT beat_states FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
      const states = (row?.beat_states ?? {}) as Record<string, { entityId?: string }>
      return states[RUN_CONVERSATION]?.entityId
    }
    const agentChatsBefore = await sql`SELECT count(*)::int AS n FROM kernel.threads t
      JOIN kernel.thread_participants tp ON tp.thread_id = t.id AND tp.user_id = ${alice}
      WHERE t.org_id = ${orgId} AND t.type = 'agent_chat'`
    const chatConversation = await start("kernel.scenario-chat")
    expect(chatConversation).toBeString()
    const commerceConversation = await start("kernel.scenario-commerce")
    // The same conversation: the DM "Message" opens, the oldest one with her agent.
    expect(commerceConversation).toBe(chatConversation)
    const [dm] = await sql`SELECT t.id FROM kernel.threads t
      JOIN kernel.thread_participants tp ON tp.thread_id = t.id AND tp.user_id = ${alice}
      WHERE t.org_id = ${orgId} AND t.type = 'agent_chat' ORDER BY t.created_at ASC, t.id ASC LIMIT 1`
    expect(chatConversation).toBe(dm?.id)
    // Starting a run opened no conversation beyond that DM (made once when missing).
    const agentChatsAfter = await sql`SELECT count(*)::int AS n FROM kernel.threads t
      JOIN kernel.thread_participants tp ON tp.thread_id = t.id AND tp.user_id = ${alice}
      WHERE t.org_id = ${orgId} AND t.type = 'agent_chat'`
    expect(agentChatsAfter[0]?.n).toBeLessThanOrEqual((agentChatsBefore[0]?.n ?? 0) + 1)
    // What the chat scenario's web search marked stays marked for the next scenario:
    // its writes may ask first, which the held approve beats handle.
    await setTaintFlag(chatConversation as string, orgId)
    expect(await untrustedTurnNeedsApproval(commerceConversation as string, orgId)).toBe(true)

    // Commerce's ask completes only on Alice's message in that DM.
    await sql`UPDATE kernel.tour_progress SET beat_id = 'ask-agent', beat_index = 3
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = 'kernel.scenario-commerce'`
    const dmMessage = (threadId: string) =>
      messageEvent({ data: { threadId, threadType: "agent_chat", mentionsAgent: false } })
    const beatOf = async () => {
      const [r] = await sql`SELECT beat_id FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = 'kernel.scenario-commerce'`
      return r?.beat_id
    }
    await deliver(dmMessage(crypto.randomUUID()))
    expect(await beatOf()).toBe("ask-agent")
    await deliver(dmMessage(commerceConversation as string))
    expect(await beatOf()).toBe("prepare")
    invalidateDemoMarker(orgId)
  })

  it("support: the routine's note and draft on this run's ticket complete their beats, whoever's routine wrote them, and a note that comes early is remembered", async () => {
    const tourId = "kernel.scenario-support"
    const ticket = crypto.randomUUID()
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
      VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'open', 2,
        ${JSON.stringify({ inbox: "done", "live-ticket": { state: "done", entityId: ticket } })}::jsonb,
        'demo')`
    const row = async () => {
      const [r] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
      return r as { beat_id: string; beat_states: Record<string, unknown> }
    }
    // The support routine runs as Bob, its owner, and stamps its run.
    const byRoutine = {
      actorId: bob,
      actorType: "agent" as const,
      metadata: { firedByRoutineId: crypto.randomUUID() },
    }
    const note = (ticketId: string): AppEvent => ({
      app: "tickets",
      entity: "note",
      action: "create",
      entityId: crypto.randomUUID(),
      orgId,
      data: { ticketId, kind: "note" },
      ...byRoutine,
    })
    // A note on another ticket changes nothing.
    await deliver(note(crypto.randomUUID()))
    expect((await row()).beat_states["routine-note"]).toBeUndefined()
    // The note on this run's ticket, while Alice still reads the "open" beat: remembered there.
    const ownNote = note(ticket)
    await deliver(ownNote)
    const early = await row()
    expect(early.beat_id).toBe("open")
    expect(early.beat_states["routine-note"]).toEqual({ state: "done", entityId: ownNote.entityId })
    // Next on "open" shows the note beat, already arrived (to be read), then the draft.
    const ctx = await loadTourOrgContext(orgId)
    const tour = findTour(tourId) as Tour
    const beats = tourBeats(tour, { ...ctx, isDemo: true })
    const [stored] = await sql`SELECT * FROM kernel.tour_progress
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
    const moved = applyTourMove(
      beats,
      {
        status: "active",
        beatId: (stored as { beat_id: string }).beat_id,
        beatIndex: 2,
        beatStates: early.beat_states as never,
      },
      { advance: true },
    )
    expect(moved.ok && moved.next.beatId).toBe("routine-note")
    await sql`UPDATE kernel.tour_progress SET beat_id = 'routine-draft', beat_index = 4,
        beat_states = ${JSON.stringify({ ...early.beat_states, open: "done" })}::jsonb
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
    const draft = (ticketId: string, toolName = "tickets:reply"): AppEvent => ({
      app: "kernel",
      entity: "approval_request",
      action: "create",
      entityId: crypto.randomUUID(),
      orgId,
      data: { status: "pending", toolName, currentPayload: { ticketId } },
      ...byRoutine,
      actorType: "user",
    })
    await deliver(draft(crypto.randomUUID()))
    await deliver(draft(ticket, "tickets:set_status"))
    expect((await row()).beat_id).toBe("routine-draft")
    const ownDraft = draft(ticket)
    await deliver(ownDraft)
    expect((await row()).beat_id).toBe("routine-draft")
    await aliceNext(tourId, true)
    expect((await row()).beat_id).toBe("approve")
    // Only Alice approving that very draft completes the approve beat.
    const approved = (id: string, actorId: string): AppEvent => ({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      entityId: id,
      orgId,
      actorId,
      actorType: "user",
      data: { status: "approved", toolName: "tickets:reply", currentPayload: { ticketId: ticket } },
    })
    await deliver(approved(crypto.randomUUID(), alice))
    await deliver(approved(ownDraft.entityId as string, bob))
    expect((await row()).beat_id).toBe("approve")
    await deliver(approved(ownDraft.entityId as string, alice))
    expect((await row()).beat_id).toBe("sent")
  })

  it("sales: the researching beat completes when this run's routine raises its request's last step (the reply), not another routine's, not its CRM record", async () => {
    const tourId = "kernel.scenario-sales"
    const routine = crypto.randomUUID()
    const email = crypto.randomUUID()
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
      VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'researching', 4,
        ${JSON.stringify({
          enable: { state: "done", entityId: routine },
          "live-email": { state: "done", entityId: email },
        })}::jsonb, 'demo')`
    const row = async () => {
      const [r] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
      return r as { beat_id: string; beat_states: Record<string, unknown> }
    }
    // The routine runs as its owner and stamps the requests it raises.
    const raised = (routineId: string, toolName: string): AppEvent => ({
      app: "kernel",
      entity: "approval_request",
      action: "create",
      entityId: crypto.randomUUID(),
      orgId,
      actorId: alice,
      actorType: "user",
      data: {
        status: "pending",
        toolName,
        metadata: { originRoutineId: routineId, firedByRoutineId: routineId },
        currentPayload: { conversationId: email },
      },
    })
    // Another routine's reply, and this routine's first steps, change nothing.
    await deliver(raised(crypto.randomUUID(), "mail:reply"))
    await deliver(raised(routine, "api-connector:connector_write"))
    await deliver(raised(routine, "invoicing:quote_create_and_issue"))
    expect((await row()).beat_states.researching).toBeUndefined()
    // Its own reply, the request's last step, completes the step, which stays on screen to be read.
    const reply = raised(routine, "mail:reply")
    await deliver(reply)
    const done = await row()
    expect(done.beat_id).toBe("researching")
    expect(done.beat_states.researching).toEqual({ state: "done", entityId: reply.entityId })
    await aliceNext(tourId)
    expect((await row()).beat_id).toBe("bundle")
  })

  // The routine's one request (CRM record, quote, reply) is approved once: the
  // approve step completes when its LAST step, the reply on this run's email,
  // ran; the head's approval alone, or another email's reply, leaves it waiting.
  it("sales: the approve step completes on the reply to this run's email only", async () => {
    const tourId = "kernel.scenario-sales"
    const routine = crypto.randomUUID()
    const email = crypto.randomUUID()
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
      VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'approve', 7,
        ${JSON.stringify({
          enable: { state: "done", entityId: routine },
          "live-email": { state: "done", entityId: email },
        })}::jsonb, 'demo')`
    const beatId = async () => {
      const [r] = await sql`SELECT beat_id FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
      return (r as { beat_id: string }).beat_id
    }
    const approved = (toolName: string, conversationId: string): AppEvent => ({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      entityId: crypto.randomUUID(),
      orgId,
      actorId: alice,
      actorType: "user",
      data: {
        status: "approved",
        toolName,
        metadata: { originRoutineId: routine },
        currentPayload: { conversationId },
      },
    })
    await deliver(approved("api-connector:connector_write", email))
    await deliver(approved("mail:reply", crypto.randomUUID()))
    expect(await beatId()).toBe("approve")
    await deliver(approved("mail:reply", email))
    expect(await beatId()).toBe("brief")
  })

  it("projects: only the ask's own turn completes the subtasks beat, then its comment in the task completes the reply beat", async () => {
    const tourId = "kernel.scenario-projects"
    const askId = crypto.randomUUID()
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
      VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'subtasks', 4,
        ${JSON.stringify({ "ask-agent": { state: "done", entityId: askId } })}::jsonb, 'demo')`
    const beatId = async () => {
      const [r] = await sql`SELECT beat_id FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
      return (r as { beat_id: string }).beat_id
    }
    const task = (metadata?: unknown): AppEvent => ({
      app: "projects",
      entity: "task",
      action: "created",
      entityId: crypto.randomUUID(),
      orgId,
      actorId: alice,
      actorType: "agent",
      data: {},
      ...(metadata ? { metadata } : {}),
    })
    // The chat scenario's agent creating tasks in its DM at that moment.
    await deliver(task({ turnMessageId: crypto.randomUUID() }))
    await deliver(task())
    expect(await beatId()).toBe("subtasks")
    await deliver(task({ turnMessageId: askId }))
    expect(await beatId()).toBe("subtasks")
    await aliceNext(tourId)
    expect(await beatId()).toBe("reply")

    const comment = (data: Record<string, unknown>, metadata?: unknown): AppEvent => ({
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: crypto.randomUUID(),
      orgId,
      actorId: alice,
      actorType: "agent",
      data,
      ...(metadata ? { metadata } : {}),
    })
    // A comment in some task by another turn, and the ask's turn writing in its own chat.
    await deliver(
      comment({ threadOrigin: "projects:task" }, { turnMessageId: crypto.randomUUID() }),
    )
    await deliver(comment({ threadType: "agent_chat" }, { turnMessageId: askId }))
    expect(await beatId()).toBe("reply")
    await deliver(comment({ threadOrigin: "projects:task" }, { turnMessageId: askId }))
    await aliceNext(tourId)
    expect(await beatId()).toBe("review")
  })

  // Live demo 2026-10-26: the agent created the subtasks, then posted its reply
  // in the task 3 s later while the person still read the subtasks step; the
  // reply only matched the step on screen, so it was dropped and the reply
  // step offered Do it for me for something already done.
  it("projects: the reply landing while the person reads the subtasks is recorded on its step, which shows done on arrival", async () => {
    const tourId = "kernel.scenario-projects"
    const askId = crypto.randomUUID()
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
      VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'subtasks', 4,
        ${JSON.stringify({ "ask-agent": { state: "done", entityId: askId } })}::jsonb, 'demo')`
    const row = async () => {
      const [r] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
      return r as { beat_id: string; beat_states: Record<string, unknown> }
    }
    const byAskTurn = {
      actorId: alice,
      actorType: "agent" as const,
      metadata: { turnMessageId: askId },
    }
    const task: AppEvent = {
      app: "projects",
      entity: "task",
      action: "created",
      entityId: crypto.randomUUID(),
      orgId,
      data: {},
      ...byAskTurn,
    }
    await deliver(task)
    expect((await row()).beat_id).toBe("subtasks")
    // Another turn's comment in some task is not this run's reply.
    await deliver({
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: crypto.randomUUID(),
      orgId,
      data: { threadOrigin: "projects:task" },
      actorId: alice,
      actorType: "agent",
      metadata: { turnMessageId: crypto.randomUUID() },
    })
    expect((await row()).beat_states.reply).toBeUndefined()
    const reply: AppEvent = {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: crypto.randomUUID(),
      orgId,
      data: { threadOrigin: "projects:task" },
      ...byAskTurn,
    }
    await deliver(reply)
    const ahead = await row()
    expect(ahead.beat_id).toBe("subtasks")
    expect(ahead.beat_states.reply).toEqual({ state: "done", entityId: reply.entityId })
    // Next: the reply step is already done (Next, not Do it for me), then on.
    await aliceNext(tourId)
    expect((await row()).beat_id).toBe("reply")
    await aliceNext(tourId)
    expect((await row()).beat_id).toBe("review")
  })

  it("knowledge: Support Desk's reply completes Lucas's step only once no turn runs in #support any more", async () => {
    const tourId = "kernel.scenario-knowledge"
    const channel = crypto.randomUUID()
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source, started_at)
      VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'lucas-answer', 6,
        ${JSON.stringify({ "lucas-asks": { state: "done", entityId: channel } })}::jsonb,
        'demo', ${new Date(Date.now() - 60_000).toISOString()})`
    const row = async () => {
      const [r] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
      return r as { beat_id: string; beat_states: Record<string, unknown> }
    }
    // Finance Desk, asked by Support Desk, is still answering in #support.
    await AgentStreamRegistryTestAccess.reset()
    const finance = { agentId: crypto.randomUUID(), turnId: crypto.randomUUID(), requesterId: bob }
    await recordAgentStreamEvent(channel, orgId, "start", {}, finance)
    try {
      // Support Desk gave up waiting and replied to Lucas ("I've passed this on").
      const reply: AppEvent = {
        app: "kernel",
        entity: "message",
        action: "create",
        entityId: crypto.randomUUID(),
        orgId,
        actorId: bob,
        actorType: "agent",
        data: { threadId: channel, authorType: "agent", parentMessageId: null },
      }
      const [pending] = await sql`INSERT INTO kernel.pending_events (org_id, payload, processed_at)
        VALUES (${orgId}, ${JSON.stringify(reply)}::jsonb, now()) RETURNING id`
      await deliver(reply, String((pending as { id: unknown }).id))
      expect((await row()).beat_states["lucas-answer"]).toBeUndefined()
      // A turn ending elsewhere settles nothing while Finance Desk still answers here.
      await settleTurnsEndedBeats(orgId, channel)
      expect((await row()).beat_states["lucas-answer"]).toBeUndefined()
      // Finance Desk's answer lands and its turn ends: the step completes on
      // Support Desk's reply, and stays on screen to be read.
      await recordAgentStreamEvent(channel, orgId, "done", {}, finance)
      await settleTurnsEndedBeats(orgId, channel)
      const after = await row()
      expect(after.beat_id).toBe("lucas-answer")
      expect(after.beat_states["lucas-answer"]).toEqual({
        state: "done",
        entityId: reply.entityId,
      })
    } finally {
      await AgentStreamRegistryTestAccess.reset()
    }
  })

  it("an event already in the outbox completes the step it missed, once (a reload, a deploy)", async () => {
    const tourId = "kernel.scenario-projects"
    const askId = crypto.randomUUID()
    const startedAt = new Date(Date.now() - 60_000)
    await sql`INSERT INTO kernel.tour_progress
        (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source, started_at)
      VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'reply', 5,
        ${JSON.stringify({
          "ask-agent": { state: "done", entityId: askId },
          subtasks: { state: "done", entityId: crypto.randomUUID() },
        })}::jsonb, 'demo', ${startedAt.toISOString()})`
    const replyId = crypto.randomUUID()
    const reply: AppEvent = {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: replyId,
      orgId,
      data: { threadOrigin: "projects:task" },
      actorId: alice,
      actorType: "agent",
      metadata: { turnMessageId: askId },
    }
    // Delivered while nothing advanced the tour: only the outbox keeps it.
    await sql`INSERT INTO kernel.pending_events (org_id, payload, processed_at)
      VALUES (${orgId}, ${JSON.stringify(reply)}::jsonb, now())`
    const tour = findTour(tourId) as Tour
    const ctx = await loadTourOrgContext(orgId)
    const beats = tourBeats(tour, { ...ctx, isDemo: true })
    const [stored] = await sql`SELECT * FROM kernel.tour_progress
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
    const s = stored as Record<string, unknown>
    const progress = progressOf(
      tour,
      {
        orgId,
        userId: alice,
        tourId,
        status: "active",
        beatId: "reply",
        beatIndex: 5,
        beatStates: s.beat_states as never,
        source: "demo",
        startedAt,
        updatedAt: new Date(),
      } as never,
      beats,
    )
    const after = await reconcileCurrentBeat({ orgId, userId: alice, tour, beats }, progress)
    expect(after.beatStates.reply).toEqual({ state: "done", entityId: replyId })
    expect(after.beatId).toBe("reply")
  })

  // Walk D66: the chat scenario's agent staged a new project holding the task
  // (createProject always asks first), and the task step, with no approve
  // step, waited for good. Either held write completes it; the next step
  // approves exactly that request.
  it("chat: a held task or project write completes the task step, and approve-task approves that request", async () => {
    const tourId = "kernel.scenario-chat"
    for (const toolName of ["projects:createProject", "projects:create"]) {
      await sql`DELETE FROM kernel.tour_progress WHERE org_id = ${orgId} AND tour_id = ${tourId}`
      const askId = crypto.randomUUID()
      await sql`INSERT INTO kernel.tour_progress
          (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
        VALUES (${orgId}, ${alice}, ${tourId}, 'active', 'task', 7,
          ${JSON.stringify({ "follow-up": { state: "done", entityId: askId } })}::jsonb, 'demo')`
      const row = async () => {
        const [r] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
          WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tourId}`
        return r as { beat_id: string; beat_states: Record<string, unknown> }
      }
      const approval = (action: "create" | "update", id: string, over: Partial<AppEvent> = {}) =>
        messageEvent({
          entity: "approval_request",
          action,
          entityId: id,
          actorType: action === "create" ? "agent" : "user",
          data: { id, toolName, status: action === "create" ? "pending" : "approved" },
          ...over,
        })
      // Another turn's held write is not this run's.
      await deliver(
        approval("create", crypto.randomUUID(), {
          metadata: { turnMessageId: crypto.randomUUID() },
        }),
      )
      expect((await row()).beat_id).toBe("task")
      const held = crypto.randomUUID()
      await deliver(approval("create", held, { metadata: { turnMessageId: askId } }))
      const afterHeld = await row()
      expect(afterHeld.beat_id).toBe("task")
      await aliceNext(tourId)
      expect((await row()).beat_id).toBe("approve-task")
      expect(afterHeld.beat_states.task).toEqual({ state: "done", entityId: held, held: true })
      // Approving another request does nothing; approving the held one moves on.
      await deliver(approval("update", crypto.randomUUID()))
      expect((await row()).beat_id).toBe("approve-task")
      await deliver(approval("update", held))
      // Then the person asks the agent to answer Tobias in the channel.
      expect((await row()).beat_id).toBe("reply-tobias")
    }
  })

  // The agent asked back ("Shall I…?") and the person answered: the work the
  // answer's turn does still belongs to the ask; another conversation's does not.
  it("a turn answering a later message of the ask's own conversation follows it; another conversation's does not", async () => {
    const msg = async (threadId: string, at: string) => {
      const id = crypto.randomUUID()
      await sql`INSERT INTO kernel.messages (id, org_id, thread_id, author_id, author_type, content, created_at, required_scopes)
        VALUES (${id}, ${orgId}, ${threadId}, ${alice}, 'user', 'x', ${at}::timestamptz, '{}')`
      return id
    }
    const dm = await minimal.thread(orgId, alice)
    const other = await minimal.thread(orgId, alice)
    const ask = await msg(dm, "2026-10-23T10:00:00Z")
    const answer = await msg(dm, "2026-10-23T10:01:00Z")
    const before = await msg(dm, "2026-10-23T09:59:00Z")
    const elsewhere = await msg(other, "2026-10-23T10:02:00Z")
    expect(await turnFollowsAsk(orgId, ask, ask)).toBe(true)
    expect(await turnFollowsAsk(orgId, ask, answer)).toBe(true)
    expect(await turnFollowsAsk(orgId, ask, before)).toBe(false)
    expect(await turnFollowsAsk(orgId, ask, elsewhere)).toBe(false)
    expect(await turnFollowsAsk(orgId, ask, "not-a-message")).toBe(false)
  })

  // Walk D61: the API connector tour's ask step completed on the agent's reply
  // although every connector read had failed (missing id): the answer was a
  // failure. The step now waits for a reply whose turn made at least one
  // successful connector read; a failed or read-less answer leaves it waiting
  // (Try again / Skip, as any waiting step).
  it("api connector: the ask completes only on a reply whose turn read the connected system successfully", async () => {
    const tour = findTour("api-connector.settings") as Tour
    const ctx = await loadTourOrgContext(orgId)
    const beats = tourBeats(tour, ctx)
    const conversation = await personalAgentDmId(orgId, alice)
    await withPrivilegedDb(orgId, "tour-consumer-test", (tx) =>
      startTour(tx, {
        orgId,
        userId: alice,
        tour,
        beats,
        source: "help",
        actor: { userId: alice, actorType: "user" },
        conversationId: conversation,
      }),
    )
    const askIndex = beats.findIndex((b) => b.id === "ask")
    expect(askIndex).toBeGreaterThan(0)
    await sql`UPDATE kernel.tour_progress SET beat_id = 'ask', beat_index = ${askIndex}
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tour.id}`
    const beatOf = async () => {
      const [r] = await sql`SELECT beat_id FROM kernel.tour_progress
        WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tour.id}`
      return r?.beat_id
    }
    const [seat] = await sql`SELECT agent_id FROM kernel.thread_participants
      WHERE thread_id = ${conversation as string} AND agent_id IS NOT NULL LIMIT 1`
    /** The agent's reply in the run's conversation, its turn's tool calls on it. */
    const reply = async (toolCalls: unknown[]) => {
      const id = crypto.randomUUID()
      await sql`INSERT INTO kernel.messages
          (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes)
        VALUES (${id}, ${conversation as string}, ${orgId}, ${alice}, 'agent', ${seat?.agent_id}, 'answer',
                ${JSON.stringify({ toolCalls })}::jsonb, '{}')`
      await deliver(
        messageEvent({
          entityId: id,
          actorType: "agent",
          data: { threadId: conversation, authorType: "agent" },
        }),
      )
    }
    const read = (result: unknown, status = "completed") => ({
      toolCallId: crypto.randomUUID(),
      toolName: "api-connector__connector_read",
      args: { connection: "crm", operation: "get_customer" },
      result,
      status,
    })
    // No read at all, a read refused by the connector, a read that threw.
    await reply([])
    await reply([read({ error: { code: "invalid_params", message: "id is required" } })])
    await reply([read(null, "error")])
    // Listing the operations is not reading the system.
    await reply([
      { ...read({ operations: [] }), toolName: "api-connector__connector_list_operations" },
    ])
    expect(await beatOf()).toBe("ask")
    await reply([read({ error: { code: "x", message: "y" } }), read({ id: "c-1", name: "Ada" })])
    expect(await beatOf()).toBe("card")
  })

  it("a system or MCP actor owns no tour: it is dropped before any read", async () => {
    expect(
      eventMayOwnTour({ actorType: "system", actorId: "system:mail:gmail-incremental-sync" }),
    ).toBe(false)
    expect(eventMayOwnTour({ actorType: "system", actorId: alice })).toBe(false)
    expect(eventMayOwnTour({ actorType: "mcp", actorId: alice })).toBe(false)
    expect(eventMayOwnTour({ actorType: "user", actorId: "not-a-uuid" })).toBe(false)
    expect(eventMayOwnTour({ actorType: "user", actorId: alice })).toBe(true)
    expect(eventMayOwnTour({ actorType: "agent", actorId: alice })).toBe(true)
    await aliceOnDoBeat()
    await deliver(
      messageEvent({ actorType: "system", actorId: "system:mail:gmail-incremental-sync" }),
    )
    expect((await aliceRow()).beat_id).toBe("post-message")
  })

  it("never throws: a database failure is logged and swallowed", async () => {
    await expect(deliver(messageEvent({ orgId: "not-a-uuid" }))).resolves.toBeUndefined()
  })
})

describe("looking ahead", () => {
  const later = (event: TourEventBinding) => ({
    id: "later",
    kind: "do" as const,
    title: "t",
    body: "b",
    event,
  })
  const now = { id: "now", kind: "show" as const, title: "t", body: "b" }

  it("only a binding scoped to the run may complete a later step", () => {
    expect(bindingScopedToRun({ app: "kernel", entity: "message", action: "create" })).toBe(false)
    expect(
      bindingScopedToRun({
        app: "kernel",
        entity: "message",
        action: "create",
        match: { status: "x" },
      }),
    ).toBe(false)
    expect(
      bindingScopedToRun({ app: "kernel", entity: "message", action: "create", causedBy: "ask" }),
    ).toBe(true)
    expect(bindingScopedToRun({ app: "a", entity: "b", action: "c", sameEntityAs: "made" })).toBe(
      true,
    )
    expect(
      bindingScopedToRun({ app: "a", entity: "b", action: "c", match: { ticketId: "{live}" } }),
    ).toBe(true)
  })

  it("an unscoped later step is never completed ahead, a scoped one is", async () => {
    const event: AppEvent = {
      app: "tickets",
      entity: "note",
      action: "create",
      entityId: crypto.randomUUID(),
      orgId: crypto.randomUUID(),
      actorId: "u-1",
      actorType: "user",
      data: { ticketId: "t-1" },
    }
    const state = {
      status: "active" as const,
      beatId: "now",
      beatIndex: 0,
      beatStates: { live: { state: "done" as const, entityId: "t-1" } },
    }
    const unscoped = [now, later({ app: "tickets", entity: "note", action: "create" })]
    expect(
      await beatDoneAhead(event.orgId as string, unscoped as never, state, event, "u-1"),
    ).toBeNull()
    const scoped = [
      now,
      later({ app: "tickets", entity: "note", action: "create", match: { ticketId: "{live}" } }),
    ]
    const found = await beatDoneAhead(event.orgId as string, scoped as never, state, event, "u-1")
    expect(found?.beat.id).toBe("later")
  })
})

describe("binding rules", () => {
  const binding: TourEventBinding = {
    app: "tickets",
    entity: "message",
    action: "create",
    match: { kind: "note" },
  }
  const ev = (data: unknown): AppEvent => ({
    app: "tickets",
    entity: "message",
    action: "create",
    orgId: "o",
    data,
  })

  it("match is exact on top-level data fields", () => {
    expect(bindingMatches(binding, ev({ kind: "note", ticketId: "t" }))).toBe(true)
    expect(bindingMatches(binding, ev({ kind: "outbound" }))).toBe(false)
    expect(bindingMatches(binding, ev(null))).toBe(false)
    expect(
      bindingMatches(
        { ...binding, match: { threadOrigin: "projects:task" } },
        ev({ threadOrigin: "projects:task" }),
      ),
    ).toBe(true)
    expect(bindingMatches({ ...binding, action: "update" }, ev({ kind: "note" }))).toBe(false)
  })

  it("null in match accepts a field that is null, never one that is set or missing", () => {
    const topLevel: TourEventBinding = { ...binding, match: { parentMessageId: null } }
    expect(bindingMatches(topLevel, ev({ parentMessageId: null }))).toBe(true)
    expect(bindingMatches(topLevel, ev({ parentMessageId: "m1" }))).toBe(false)
    expect(bindingMatches(topLevel, ev({ kind: "note" }))).toBe(false)
  })

  it("a list in match accepts any one of its values, and nothing else", () => {
    const either: TourEventBinding = {
      ...binding,
      match: { kind: ["note", "outbound"], "meta.routineId": "{enable}" },
    }
    const created = { enable: "r1" }
    expect(bindingMatches(either, ev({ kind: "note", meta: { routineId: "r1" } }), created)).toBe(
      true,
    )
    expect(
      bindingMatches(either, ev({ kind: "outbound", meta: { routineId: "r1" } }), created),
    ).toBe(true)
    expect(bindingMatches(either, ev({ kind: "draft", meta: { routineId: "r1" } }), created)).toBe(
      false,
    )
    expect(bindingMatches(either, ev({ kind: "note", meta: { routineId: "r2" } }), created)).toBe(
      false,
    )
    expect(bindingMatches(either, ev({ meta: { routineId: "r1" } }), created)).toBe(false)
  })

  it("run scoping: causedBy reads the emitting turn's message, sameEntityAs the entity, {beat} what that beat recorded", () => {
    const caused: TourEventBinding = { ...binding, match: undefined, causedBy: "ask" }
    const turn = (turnMessageId?: string): AppEvent => ({
      ...ev({}),
      ...(turnMessageId ? { metadata: { turnMessageId } } : {}),
    })
    expect(bindingMatches(caused, turn("m1"), { ask: "m1" })).toBe(true)
    expect(bindingMatches(caused, turn("m2"), { ask: "m1" })).toBe(false)
    // A later message of the same conversation (the caller checked it).
    expect(bindingMatches(caused, turn("m2"), { ask: "m1" }, true)).toBe(true)
    expect(bindingMatches(caused, turn(), { ask: "m1" })).toBe(false)
    // Nothing recorded: never a match, rather than any event.
    expect(bindingMatches(caused, turn("m1"), {})).toBe(false)
    const same: TourEventBinding = { ...binding, match: undefined, sameEntityAs: "prepare" }
    expect(bindingMatches(same, { ...ev({}), entityId: "a1" }, { prepare: "a1" })).toBe(true)
    expect(bindingMatches(same, { ...ev({}), entityId: "a2" }, { prepare: "a1" })).toBe(false)
    const about: TourEventBinding = {
      ...binding,
      match: { status: "approved", "currentPayload.ticketId": "{live}" },
    }
    const reply = (ticketId: string) => ev({ status: "approved", currentPayload: { ticketId } })
    expect(bindingMatches(about, reply("t1"), { live: "t1" })).toBe(true)
    expect(bindingMatches(about, reply("t2"), { live: "t1" })).toBe(false)
    expect(bindingMatches(about, reply("t1"), {})).toBe(false)
  })

  it("the chat scenario's ask-agent beat completes on a message to the agent in its run's conversation, not in a channel", () => {
    const chat = findTour("kernel.scenario-chat") as Tour
    const beat = chat.beats.find((b) => b.id === "ask-agent")
    const askAgent = beat && "event" in beat ? beat.event : undefined
    if (!askAgent) throw new Error("ask-agent has no event")
    const message = (threadType: string, threadId: string): AppEvent => ({
      app: "kernel",
      entity: "message",
      action: "create",
      orgId: "o",
      data: { threadType, threadId, mentionsAgent: false },
    })
    const run = { [RUN_CONVERSATION]: "conv-1" }
    expect(bindingMatches(askAgent, message("agent_chat", "conv-1"), run)).toBe(true)
    expect(bindingMatches(askAgent, message("thread", "conv-1"), run)).toBe(false)
    // Another conversation with the agent (the DM, another scenario's) does not count.
    expect(bindingMatches(askAgent, message("agent_chat", "dm"), run)).toBe(false)
    expect(bindingMatches(askAgent, message("agent_chat", "conv-1"))).toBe(false)
  })

  it("the chat scenario's posting beat completes on the agent's post in the channel from the reply-tobias turn only", () => {
    const chat = findTour("kernel.scenario-chat") as Tour
    const beat = chat.beats.find((b) => b.id === "posting")
    const posting = beat && "event" in beat ? beat.event : undefined
    if (!posting) throw new Error("posting has no event")
    const post = (
      threadId: string,
      authorType: string,
      turnMessageId: string,
      actorType: "user" | "agent" = "agent",
    ): AppEvent => ({
      app: "kernel",
      entity: "message",
      action: "create",
      orgId: "o",
      actorId: "u1",
      actorType,
      metadata: { turnMessageId },
      data: { threadId, authorType, parentMessageId: null },
    })
    const run = { question: "channel-1", "ask-agent": "ask-1", "reply-tobias": "reply-1" }
    const ok = post("channel-1", "agent", "reply-1")
    expect(bindingMatches(posting, ok, run)).toBe(true)
    expect(actorSatisfies(posting, ok, "u1")).toBe(true)
    // A post from another turn (the research turn) does not count.
    expect(bindingMatches(posting, post("channel-1", "agent", "ask-1"), run)).toBe(false)
    // The same turn's answer in the person's conversation with it, or a post elsewhere.
    expect(bindingMatches(posting, post("conv-1", "agent", "reply-1"), run)).toBe(false)
    // The person posting in the channel themselves is not the agent's answer.
    expect(bindingMatches(posting, post("channel-1", "user", "reply-1", "user"), run)).toBe(false)
    // Another person's agent turn never completes the owner's beat.
    expect(actorSatisfies(posting, { ...ok, actorId: "u2" }, "u1")).toBe(false)
  })

  it("user: only the owner's own action; user-or-agent: also an agent turn the owner asked for", () => {
    const own = { actorId: "u1", actorType: "user" as const }
    const agentTurn = { actorId: "u1", actorType: "agent" as const }
    expect(actorSatisfies(binding, own, "u1")).toBe(true)
    expect(actorSatisfies(binding, agentTurn, "u1")).toBe(false)
    const either = { ...binding, actor: "user-or-agent" as const }
    expect(actorSatisfies(either, agentTurn, "u1")).toBe(true)
    expect(actorSatisfies(either, { actorId: "u2", actorType: "agent" }, "u1")).toBe(false)
    expect(actorSatisfies(either, { actorId: "u1", actorType: "system" }, "u1")).toBe(false)
  })

  it("any: a routine's or a teammate's work counts, the binding's match keeps it to its run", () => {
    const any = { ...binding, actor: "any" as const }
    const routineRun = { firedByRoutineId: "r1" }
    expect(
      actorSatisfies(any, { actorId: "u2", actorType: "agent", metadata: routineRun }, "u1"),
    ).toBe(true)
    expect(actorSatisfies(any, { actorId: null, actorType: "system" }, "u1")).toBe(true)
  })

  it("fails closed: no actor type is not the owner's action, and a routine's run never counts", () => {
    const either = { ...binding, actor: "user-or-agent" as const }
    expect(actorSatisfies(binding, { actorId: "u1" }, "u1")).toBe(false)
    expect(actorSatisfies(either, { actorId: "u1" }, "u1")).toBe(false)
    const routineRun = { firedByRoutineId: "r1" }
    expect(
      actorSatisfies(either, { actorId: "u1", actorType: "agent", metadata: routineRun }, "u1"),
    ).toBe(false)
    expect(
      actorSatisfies(binding, { actorId: "u1", actorType: "user", metadata: routineRun }, "u1"),
    ).toBe(false)
    expect(
      actorSatisfies(either, { actorId: "u1", actorType: "agent", metadata: { other: 1 } }, "u1"),
    ).toBe(true)
  })
})

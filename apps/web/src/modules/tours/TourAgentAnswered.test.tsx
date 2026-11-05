// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A step that waits on the agent's turn (the projects tour's breakdown) kept
// saying "Your agent is working on it" after the agent answered in the task's
// discussion without creating anything. Once that turn ends without the
// step's event, the step says the agent answered without doing it and offers
// Try again (which re-sends the request) and Skip; a later event still moves
// it on.
import { defineTour, type TourBeatStatus, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pressTourMenuItem, tourMenuItem } from "./test-helpers"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

type Stream = { state: string; error: { message: string } | null }
const agent = vi.hoisted(() => ({
  streams: null as null | Record<string, Stream>,
  setStream: null as null | ((threadId: string, s: Stream) => void),
}))
const idle: Stream = { state: "idle", error: null }
vi.mock("~/modules/threads/personal-dm-store", () => ({ knownPersonalAgentDmId: () => "dm-1" }))
vi.mock("~/modules/threads/message-store", () => ({
  getChannelAgentStream: (threadId: string) => agent.streams?.[threadId] ?? idle,
  getMessages: () => [],
  // The request the ask step recorded sits in the task's own discussion.
  messageStore: { threads: { "task-thread": { byId: { "msg-ask": { id: "msg-ask" } } } } },
}))

/** The step status the server computes: whether it runs the agent's turn. */
let serverStatus: TourBeatStatus = { kind: "pending" }
const WORKING: TourBeatStatus = { kind: "agent-working", since: "2026-10-25T10:00:01.000Z" }

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "projects.fixture-answered",
  app: "projects",
  title: "tours.knowledge.basics.title",
  summary: "tours.knowledge.basics.summary",
  beats: [
    {
      id: "ask",
      kind: "do",
      title: "tours.knowledge.basics.create.title",
      body: "tours.knowledge.basics.create.body",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ click: "fixture-ask" }, { waitEvent: true }],
    },
    {
      id: "subtasks",
      kind: "do",
      title: "tours.knowledge.basics.create.title",
      body: "tours.knowledge.basics.create.body",
      event: {
        app: "projects",
        entity: "task",
        action: "created",
        actor: "user-or-agent",
        causedBy: "ask",
      },
      autoplay: [{ waitEvent: true }],
    },
    {
      id: "next",
      kind: "show",
      title: "tours.knowledge.basics.recent.title",
      body: "tours.knowledge.basics.recent.body",
    },
  ],
})

const progress = (): TourProgress => ({
  tourId: tour.id,
  status: "active",
  beatId: "subtasks",
  beatIndex: 1,
  beatCount: 3,
  beatStates: { ask: { state: "done", entityId: "msg-ask" } },
  source: "help",
  startedAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
  beatStatus: serverStatus,
})

// Fresh objects each time: the store keeps what it is given and moves it on.
const advanced = (): TourProgress => ({
  ...progress(),
  beatId: "next",
  beatIndex: 2,
  beatStates: {
    ask: { state: "done", entityId: "msg-ask" },
    subtasks: { state: "done", entityId: "task-1" },
  },
  beatStatus: { kind: "pending" },
})

// The step done where it stands: a do beat waits for Next (Play all presses it).
const doneHere = (): TourProgress => ({
  ...progress(),
  beatStates: {
    ask: { state: "done", entityId: "msg-ask" },
    subtasks: { state: "done", entityId: "task-1" },
  },
  beatStatus: { kind: "done", held: false },
})

let current = progress
let updates: unknown[] = []
const api = (): TourApi => ({
  list: vi.fn(async () => [
    {
      tourId: tour.id,
      app: "projects",
      title: tour.title,
      summary: "",
      beatCount: 3,
      progress: progress(),
    },
  ]),
  start: vi.fn(async () => current()),
  update: vi.fn(async (_id: string, body: unknown) => {
    updates.push(body)
    return current()
  }),
  progress: vi.fn(async () => current()),
})

let asks = 0
let dispose: () => void = () => {}
beforeEach(() => {
  serverStatus = { kind: "pending" }
  current = progress
  asks = 0
  updates = []
  fixtures.tours = [tour]
  resetTourStore()
  const ask = document.createElement("button")
  ask.dataset.testid = "fixture-ask"
  ask.getClientRects = () => [{}] as unknown as DOMRectList
  ask.addEventListener("click", () => {
    asks += 1
  })
  document.body.append(ask)
  createRoot((d) => {
    dispose = d
    const [streams, setStreams] = createStore<Record<string, Stream>>({})
    agent.streams = streams
    agent.setStream = (threadId, s) => setStreams(threadId, s)
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
  dispose()
})

const timing = { typeDelayMs: 0, stepPauseMs: 0, findTimeoutMs: 50, showBeatMs: 30 }

async function mount() {
  setTourApi(api())
  render(() => <TourOverlay {...timing} answerGraceMs={30} />)
  await tourStore.load()
  await screen.findByTestId("tour-panel")
}

/** A turn starts in the task's discussion: its frames here, the server's word on the step. */
async function turnStarts() {
  agent.setStream?.("task-thread", { state: "streaming", error: null })
  serverStatus = WORKING
  await tourStore.refresh(tour.id)
  await screen.findByTestId("tour-working")
}

/** The turn ends: the server no longer runs it. */
async function turnEnds(state: "complete" | "error", error: { message: string } | null = null) {
  agent.setStream?.("task-thread", { state, error })
  serverStatus = { kind: "pending" }
  await tourStore.refresh(tour.id)
}

/** The task discussion's turn runs, then ends with an answer and no subtask. */
async function answerWithoutDoing() {
  await turnStarts()
  await turnEnds("complete")
}

describe("a step whose agent answered without doing it", () => {
  it("leaves the working line and offers Try again and Skip", async () => {
    await mount()
    await answerWithoutDoing()
    const line = await screen.findByTestId("tour-agent-answered")
    expect(line.textContent).toContain("answered without doing this step")
    expect(screen.queryByTestId("tour-working")).toBeNull()
    expect(screen.getByTestId("tour-do-for-me").textContent).toBe("Try again")
    expect(await tourMenuItem("tour-skip-beat")).toBeInTheDocument()
  })

  it("Try again sends the request again, and a new turn says the agent works", async () => {
    await mount()
    await answerWithoutDoing()
    await screen.findByTestId("tour-agent-answered")
    fireEvent.click(screen.getByTestId("tour-do-for-me"))
    await waitFor(() => expect(asks).toBe(1))
    await turnStarts()
    expect(screen.queryByTestId("tour-agent-answered")).toBeNull()
  })

  it("a reply that starts a new turn brings back the working line", async () => {
    await mount()
    await answerWithoutDoing()
    await screen.findByTestId("tour-agent-answered")
    await turnStarts()
    expect(screen.queryByTestId("tour-agent-answered")).toBeNull()
  })

  it("the event arriving afterwards still moves the step on", async () => {
    await mount()
    await answerWithoutDoing()
    await screen.findByTestId("tour-agent-answered")
    current = advanced
    tourStore.onFrame(
      {
        ownerUserId: "u-1",
        tourId: tour.id,
        status: "active",
        beatId: "next",
        beatIndex: 2,
        emittedAt: new Date().toISOString(),
      },
      "u-1",
    )
    await waitFor(() => expect(tourStore.current?.beatId).toBe("next"))
    await waitFor(() => expect(screen.queryByTestId("tour-agent-answered")).toBeNull())
    expect(screen.getByTestId("tour-next")).toBeInTheDocument()
  })

  it("an event close behind the turn's end is not an answer without the step", async () => {
    await mount()
    await answerWithoutDoing()
    current = advanced
    await tourStore.refresh(tour.id)
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByTestId("tour-agent-answered")).toBeNull()
  })

  it("a turn that ended before the step came on screen does not count", async () => {
    agent.setStream?.("task-thread", { state: "complete", error: null })
    await mount()
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByTestId("tour-agent-answered")).toBeNull()
  })

  it("a turn that parked a call for approval is not an answer without the step", async () => {
    await mount()
    await turnStarts()
    agent.setStream?.("task-thread", { state: "complete", error: null })
    serverStatus = {
      kind: "held-for-approval",
      requestId: "req-1",
      toolName: "kernel:web_search",
      reason: "gated",
    }
    await tourStore.refresh(tour.id)
    await new Promise((r) => setTimeout(r, 80))
    expect(screen.queryByTestId("tour-agent-answered")).toBeNull()
  })

  it("the step done on the server just after the grace is read before saying so", async () => {
    await mount()
    await answerWithoutDoing()
    // The tour's consumer has recorded the step, though no frame reached this page yet.
    current = doneHere
    await new Promise((r) => setTimeout(r, 80))
    expect(screen.queryByTestId("tour-agent-answered")).toBeNull()
    expect(tourStore.current?.beatStates.subtasks).toBeDefined()
  })

  it("Play all: the event arriving after the agent answered moves the scenario on", async () => {
    await mount()
    await pressTourMenuItem("tour-play-all")
    await waitFor(() => expect(tourStore.playAll).toBe(true))
    await answerWithoutDoing()
    await screen.findByTestId("tour-agent-answered")
    expect(tourStore.playAll).toBe(true)
    current = doneHere
    await tourStore.refresh(tour.id)
    await waitFor(() => expect(updates).toContainEqual(expect.objectContaining({ advance: true })))
  })

  it("a failed turn still says it failed", async () => {
    await mount()
    await turnStarts()
    await turnEnds("error", { message: "provider down" })
    await screen.findByTestId("tour-agent-failed")
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByTestId("tour-agent-answered")).toBeNull()
  })
})

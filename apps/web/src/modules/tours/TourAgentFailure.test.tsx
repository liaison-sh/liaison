// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D5: a beat the person's agent completes ("Add knowledge") never waits in
// silence: when the agent's turn fails, the panel says so and offers to try
// again or skip, and "Play whole scenario" stops there.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createRoot, createSignal } from "solid-js"
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

const agent = vi.hoisted(() => ({
  dm: null as null | (() => string | undefined),
  setDm: null as null | ((id: string | undefined) => void),
  stream: null as null | { state: string; error: { message: string } | null },
  setStream: null as null | ((s: { state: string; error: { message: string } | null }) => void),
}))
vi.mock("~/modules/threads/personal-dm-store", () => ({
  knownPersonalAgentDmId: () => agent.dm?.(),
}))
const thread = vi.hoisted(() => ({
  /** A conversation's turn, by thread id (else the DM's `agent.stream`). */
  streams: {} as Record<string, { state: string; error: { message: string } | null }>,
  messages: {} as Record<string, unknown[]>,
}))
vi.mock("~/modules/threads/message-store", () => ({
  getChannelAgentStream: (id: string) => thread.streams[id] ?? agent.stream,
  getMessages: (id: string) => thread.messages[id] ?? [],
}))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")
const { registerTourBeatGate, registerTourRefusalGate } = await import("./beat-gates")

const tour = defineTour({
  id: "knowledge.fixture",
  app: "knowledge",
  title: "tours.knowledge.basics.title",
  summary: "tours.knowledge.basics.summary",
  beats: [
    {
      id: "create",
      kind: "do",
      title: "tours.knowledge.basics.create.title",
      body: "tours.knowledge.basics.create.body",
      event: { app: "knowledge", entity: "document", action: "create", actor: "user-or-agent" },
      // It asks something on screen, so Try again has a request to send again.
      autoplay: [{ click: "fixture-ask" }, { waitEvent: true }],
    },
    {
      id: "next",
      kind: "show",
      title: "tours.knowledge.basics.recent.title",
      body: "tours.knowledge.basics.recent.body",
    },
  ],
})

function progress(): TourProgress {
  return {
    tourId: tour.id,
    status: "active",
    beatId: "create",
    beatIndex: 0,
    beatCount: 2,
    beatStates: {},
    source: "help",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
  }
}

function api(p: TourProgress = progress()): TourApi {
  return {
    list: vi.fn(async () => [
      {
        tourId: tour.id,
        app: "knowledge",
        title: tour.title,
        summary: "",
        beatCount: 2,
        progress: p,
      },
    ]),
    start: vi.fn(async () => p),
    update: vi.fn(async () => p),
    progress: vi.fn(async () => p),
  }
}

let dispose: () => void = () => {}
beforeEach(() => {
  fixtures.tours = [tour, scenario]
  thread.streams = {}
  thread.messages = {}
  resetTourStore()
  const ask = document.createElement("button")
  ask.dataset.testid = "fixture-ask"
  ask.getClientRects = () => [{}] as unknown as DOMRectList
  document.body.append(ask)
  createRoot((d) => {
    dispose = d
    const [dm, setDm] = createSignal<string | undefined>("dm-1")
    const [stream, setStream] = createStore<{ state: string; error: { message: string } | null }>({
      state: "idle",
      error: null,
    })
    agent.dm = dm
    agent.setDm = setDm
    agent.stream = stream
    agent.setStream = (s) => setStream(s)
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
  dispose()
})

const timing = { typeDelayMs: 0, stepPauseMs: 0, findTimeoutMs: 50, showBeatMs: 30 }

const REFUSAL = "Confirm your email to run the agents on this demo. The code is in your inbox."

/** A scenario whose show beat waits on the agent's answer in the person's agent conversation. */
const scenario = defineTour({
  id: "kernel.fixture-scenario",
  app: "kernel",
  demoOnly: true,
  talksToAgent: true,
  title: "tours.knowledge.basics.title",
  summary: "tours.knowledge.basics.summary",
  beats: [
    {
      id: "searching",
      kind: "show",
      title: "tours.knowledge.basics.recent.title",
      body: "tours.knowledge.basics.recent.body",
      anchor: "fixture-tool-row",
      waitsOn: "agent",
    },
  ],
})

function scenarioProgress(): TourProgress {
  return {
    ...progress(),
    tourId: scenario.id,
    beatId: "searching",
    beatCount: 1,
    beatStates: { conversation: { state: "done", entityId: "run-1" } },
  }
}

describe("an agent beat whose turn fails", () => {
  it("says it failed, offers to try again or skip, and stops playing the whole scenario", async () => {
    setTourApi(api())
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    // The agent works on it: the panel says so.
    await screen.findByTestId("tour-working")

    agent.setStream?.({ state: "streaming", error: null })
    agent.setStream?.({ state: "error", error: { message: "no model key" } })

    const line = await screen.findByTestId("tour-agent-failed")
    expect(line.textContent).toContain("could not")
    expect(screen.queryByTestId("tour-working")).toBeNull()
    expect(screen.getByTestId("tour-do-for-me").textContent).toBe("Try again")
    expect(await tourMenuItem("tour-skip-beat")).toBeTruthy()
    // One way to skip: the footer's Skip would say the same.
    expect(await tourMenuItem("tour-skip")).toBeNull()
    await waitFor(() => expect(tourStore.playAll).toBe(false))
  })

  it("an error from before the beat started is not this beat's failure", async () => {
    agent.setStream?.({ state: "error", error: { message: "earlier" } })
    setTourApi(api())
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId("tour-agent-failed")).toBeNull()
  })
})

// The run's conversation is the person's DM with their agent, which holds
// earlier turns: a failure left there from before the run is not this run's.
describe("a scenario beat in the person's agent conversation", () => {
  it("ignores a failure from before the run, and says one that comes after it", async () => {
    agent.setStream?.({ state: "error", error: { message: "earlier" } })
    // Nothing going yet: the person starts the scenario from this page.
    setTourApi({ ...api(scenarioProgress()), list: vi.fn(async () => []) })
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await tourStore.start(scenario.id, "demo")
    await screen.findByTestId("tour-panel")
    await new Promise((r) => setTimeout(r, 80))
    expect(screen.queryByTestId("tour-agent-failed")).toBeNull()
    agent.setStream?.({ state: "streaming", error: null })
    agent.setStream?.({ state: "error", error: { message: "no model key" } })
    expect(await screen.findByTestId("tour-agent-failed")).toBeTruthy()
  })
})

// Walk D29: an unverified visitor's turn was refused before it ran; the
// scenario's next beat waited for a tool row that never came and said "I could
// not find what this step needs". The refusal is said once, by the
// conversation; the beat shows the gate that lifts it.
describe("a scenario beat whose agent turn was refused before it ran", () => {
  function refused(threadId: string) {
    thread.streams[threadId] = { state: "error", error: { message: REFUSAL } }
    thread.messages[threadId] = [
      {
        id: "sys",
        threadId,
        authorType: "system",
        content: REFUSAL,
        metadata: { demoRefusal: "demo_verification_required" },
      },
    ]
  }

  it("shows the gate the refusal names, not a missing element", async () => {
    const offGate = registerTourBeatGate("verify", () => <p data-testid="fixture-verify-gate" />)
    const offRefusal = registerTourRefusalGate("demo_verification_required", "verify")
    try {
      // The scenario plays on from the ask; the turn was refused before the
      // panel reached the beat waiting on its answer.
      refused("run-1")
      setTourApi(api(scenarioProgress()))
      tourStore.setPlayAll(true)
      render(() => <TourOverlay {...timing} showAnchorWaitMs={60} />)
      await tourStore.load()
      const gate = await screen.findByTestId("tour-beat-gate")
      expect(gate.dataset.gate).toBe("verify")
      expect(screen.getByTestId("fixture-verify-gate")).toBeTruthy()
      expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
      expect(screen.queryByTestId("tour-agent-failed")).toBeNull()
      await waitFor(() => expect(tourStore.playAll).toBe(false))
    } finally {
      offGate()
      offRefusal()
    }
  })

  it("a refusal no gate is registered for says the turn failed", async () => {
    refused("run-1")
    setTourApi(api(scenarioProgress()))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    expect(await screen.findByTestId("tour-agent-failed")).toBeTruthy()
    expect(screen.queryByTestId("tour-beat-gate")).toBeNull()
  })
})

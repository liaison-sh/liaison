// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Live demo: a step pointing at the agent's answer to the person's question
// kept saying "Your agent is working on it" forever after that question's turn
// was refused before it ran (a demo spend refusal), and still did after the
// person asked again and got an answer. The server now says the turn ended
// without an answer (`agent-failed`): the card says so with the refusal's own
// words, Try again sends the same question again in the same conversation,
// and a later message's answer (re-bound by the server) ends the failure.
import { defineTour, type TourBeatStatus, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))
vi.mock("~/modules/threads/personal-dm-store", () => ({ knownPersonalAgentDmId: () => "dm-1" }))
const sent = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock("~/modules/threads/message-store", () => ({
  getChannelAgentStream: () => ({ state: "idle", error: null }),
  getMessages: () => [],
  sendMessage: async (...args: unknown[]) => {
    sent.calls.push(args)
  },
}))
vi.mock("~/modules/threads/thread-send", () => ({
  currentViewForTurn: () => ({ tabType: "tickets", entityId: "ticket-1" }),
}))
const client = vi.hoisted(() => ({ post: async () => ({}), get: async () => ({}) }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useOptionalApi: () => client,
  useApi: () => client,
}))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "user-1", name: "Alice" }),
  sessionOrgId: () => "org-1",
}))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "kernel.fixture-ask-failed",
  app: "kernel",
  demoOnly: true,
  title: "tours.knowledge.basics.title",
  summary: "tours.knowledge.basics.summary",
  beats: [
    {
      id: "ask",
      kind: "do",
      title: "tours.knowledge.basics.create.title",
      body: "tours.knowledge.basics.create.body",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ waitEvent: true }],
    },
    {
      id: "answer",
      kind: "show",
      title: "tours.knowledge.basics.recent.title",
      body: "tours.knowledge.basics.recent.body",
      anchor: "agent-answer[data-turn-id={ask}]",
      waitsOn: "agent",
    },
  ],
})

const QUESTION = "What did this customer order before?"
const REFUSAL = "This demo has used its agent budget for today."

function progress(askId: string, beatStatus: TourBeatStatus): TourProgress {
  return {
    tourId: tour.id,
    status: "active",
    beatId: "answer",
    beatIndex: 1,
    beatCount: 2,
    beatStates: { ask: { state: "done", entityId: askId } },
    beatStatus,
    source: "demo",
    startedAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
  }
}

const refused: TourBeatStatus = {
  kind: "agent-failed",
  threadId: "dm-1",
  askId: "m-1",
  question: QUESTION,
  message: REFUSAL,
  code: "demo_budget_exhausted",
}

function api(first: TourProgress, reads: TourProgress[]): TourApi {
  let current = first
  return {
    list: vi.fn(async () => [
      {
        tourId: tour.id,
        app: "kernel",
        title: tour.title,
        summary: "",
        beatCount: 2,
        progress: first,
      },
    ]),
    start: vi.fn(async () => first),
    update: vi.fn(async () => current),
    progress: vi.fn(async () => {
      current = reads.shift() ?? current
      return current
    }),
  }
}

/** An agent answer on screen, answering the message `turnId`. */
function answerOnScreen(turnId: string) {
  const el = document.createElement("div")
  el.dataset.testid = "agent-answer"
  el.dataset.turnId = turnId
  el.getClientRects = () => [{}] as unknown as DOMRectList
  el.getBoundingClientRect = () =>
    ({ top: 10, left: 10, width: 100, height: 40, right: 110, bottom: 50 }) as DOMRect
  document.body.append(el)
}

beforeEach(() => {
  fixtures.tours = [tour]
  sent.calls = []
  resetTourStore()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

const timing = { typeDelayMs: 0, stepPauseMs: 0, findTimeoutMs: 50, showBeatMs: 30 }

describe("a step waiting on the answer to a question whose turn was refused", () => {
  it("says the agent could not answer, with the refusal's words, and Try again asks the same question again", async () => {
    const working: TourBeatStatus = { kind: "agent-working", since: "2026-11-01T10:01:00.000Z" }
    setTourApi(api(progress("m-1", refused), [progress("m-1", working)]))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()

    const line = await screen.findByTestId("tour-agent-failed")
    expect(line.textContent).toContain("could not answer")
    expect(screen.getByTestId("tour-agent-failed-reason").textContent).toBe(REFUSAL)
    expect(screen.queryByTestId("tour-working")).toBeNull()

    const retry = screen.getByTestId("tour-do-for-me")
    expect(retry.textContent).toBe("Try again")
    fireEvent.click(retry)

    await waitFor(() => expect(sent.calls).toHaveLength(1))
    const [, threadId, content, user, opts] = sent.calls[0] as [
      unknown,
      string,
      string,
      { id: string },
      { currentView?: unknown },
    ]
    expect(threadId).toBe("dm-1")
    expect(content).toBe(QUESTION)
    expect(user.id).toBe("user-1")
    expect(opts.currentView).toEqual({ tabType: "tickets", entityId: "ticket-1" })
    // The new message's turn runs: the step waits on it, no longer failed.
    await screen.findByTestId("tour-working")
    expect(screen.queryByTestId("tour-agent-failed")).toBeNull()
  })

  it("a later message of the person's that got an answer takes the step over", async () => {
    // The server re-bound the question to the person's "?", whose turn answered.
    setTourApi(api(progress("m-1", refused), [progress("m-2", { kind: "pending" })]))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await screen.findByTestId("tour-agent-failed")

    answerOnScreen("m-2")
    await tourStore.refresh(tour.id)

    await waitFor(() => expect(screen.queryByTestId("tour-agent-failed")).toBeNull())
    expect(screen.queryByTestId("tour-agent-failed-reason")).toBeNull()
    const next = await screen.findByTestId("tour-next")
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false))
    expect(sent.calls).toHaveLength(0)
  })
})

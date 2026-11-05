// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A step that asks the visitor's agent something completes as soon as the
// request is sent; the agent's answer then streams in that conversation while
// the next step is on screen (an end card, a step about the answer). The ring
// dropped right after the send, and the page dimmed over the very answer the
// visitor was waiting for. Until that turn ends, the conversation the request
// went into stays ringed: the agent's live turn when it shows, else the
// conversation itself, always inside the chat window it is in.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

type Stream = { state: string; error: { message: string } | null }
const agent = vi.hoisted(() => ({
  streams: {} as Record<string, Stream>,
  setStream: null as null | ((threadId: string, s: Stream) => void),
}))
const idle: Stream = { state: "idle", error: null }
vi.mock("~/modules/threads/personal-dm-store", () => ({ knownPersonalAgentDmId: () => "dm-1" }))
vi.mock("~/modules/threads/message-store", () => ({
  getChannelAgentStream: (threadId: string) => agent.streams[threadId] ?? idle,
  getMessages: () => [],
  seedAgentStreamState: async () => {},
  reconcileAgentStreamsWithServer: async () => {},
}))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

function tourAsking(anchor: string) {
  return defineTour({
    id: "kernel.fixture-ask",
    app: "kernel",
    title: "tours.knowledge.basics.title",
    summary: "tours.knowledge.basics.summary",
    beats: [
      {
        id: "ask",
        kind: "do",
        title: "tours.knowledge.basics.create.title",
        body: "tours.knowledge.basics.create.body",
        anchor,
        say: {
          lead: "tours.knowledge.basics.create.title",
          text: "tours.knowledge.basics.create.body",
        },
        // The visitor's own message to their agent: done once it is sent.
        event: {
          app: "kernel",
          entity: "message",
          action: "create",
          match: { threadType: "agent_chat" },
        },
        autoplay: [
          { type: { testid: "compose-editor", text: "tours.knowledge.basics.create.body" } },
          { click: "compose-send" },
        ],
      },
      {
        id: "done",
        kind: "show",
        title: "tours.knowledge.basics.recent.title",
        body: "tours.knowledge.basics.recent.body",
      },
    ],
  })
}

const at = "2026-10-25T10:00:00.000Z"
function progressAt(beatId: "ask" | "done", tourId: string): TourProgress {
  return {
    tourId,
    status: "active",
    beatId,
    beatIndex: beatId === "ask" ? 0 : 1,
    beatCount: 2,
    beatStates: beatId === "ask" ? {} : { ask: { state: "done", entityId: "msg-1" } },
    source: "help",
    startedAt: at,
    updatedAt: at,
  }
}

type Box = { top: number; left: number; width: number; height: number }
function place(el: HTMLElement, box: Box) {
  el.getClientRects = () => [{}] as unknown as DOMRectList
  el.getBoundingClientRect = () =>
    ({
      ...box,
      bottom: box.top + box.height,
      right: box.left + box.width,
      x: box.left,
      y: box.top,
    }) as DOMRect
}
function element(testid: string, box: Box, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement("div")
  el.dataset.testid = testid
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  place(el, box)
  return el
}

/**
 * A conversation: its window (clipping what it holds), the message list that
 * scrolls in it, and its composer. `windowBox` is a docked chat's small window
 * or a whole Chats page.
 */
function conversation(threadId: string, windowBox: Box) {
  const win = element("fixture-window", windowBox)
  win.style.overflow = "hidden"
  const listBox = { ...windowBox, height: windowBox.height - 60 }
  const list = element("message-scroll-container", listBox)
  list.style.overflowY = "auto"
  const composer = element(
    "compose-field",
    {
      top: windowBox.top + windowBox.height - 50,
      left: windowBox.left,
      width: windowBox.width,
      height: 40,
    },
    { "data-thread-id": threadId, "data-personal-agent": threadId === "dm-1" ? "true" : "false" },
  )
  win.append(list, composer)
  document.body.append(win)
  return {
    list,
    /** The agent's live turn in the list, at `box`. */
    liveTurn(box: Box) {
      const block = element("agent-stream-block", box)
      list.append(block)
      return block
    },
  }
}

let dispose: () => void = () => {}
beforeEach(() => {
  resetTourStore()
  agent.streams = {}
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

async function mountAt(anchor: string, askTurnStartMs?: number) {
  const tour = tourAsking(anchor)
  fixtures.tours = [tour]
  let progress = progressAt("ask", tour.id)
  const api: TourApi = {
    list: vi.fn(async () => [
      { tourId: tour.id, app: "kernel", title: tour.title, summary: "", beatCount: 2, progress },
    ]),
    start: vi.fn(async () => progress),
    update: vi.fn(async () => progress),
    progress: vi.fn(async () => progress),
  }
  setTourApi(api)
  render(() => <TourOverlay {...timing} askTurnStartMs={askTurnStartMs} />)
  await tourStore.load()
  await screen.findByTestId("tour-panel")
  return {
    /** The request went out: the server moved the run to its next step. */
    sent() {
      progress = progressAt("done", tour.id)
      tourStore.onFrame(
        {
          ownerUserId: "u-1",
          tourId: tour.id,
          status: "active",
          beatId: "done",
          beatIndex: 1,
          emittedAt: new Date().toISOString(),
        },
        "u-1",
      )
    },
  }
}

const ringed = () => screen.queryByTestId("tour-spotlight")?.dataset.anchor

describe("the agent answers a step's request", () => {
  it("in a small docked chat: the ring stays on it, inside the window, until the turn ends", async () => {
    const dock = { top: 400, left: 900, width: 320, height: 300 }
    const chat = conversation("dm-1", dock)
    const run = await mountAt("compose-field[data-personal-agent=true]")
    await waitFor(() => expect(ringed()).toBe("compose-field[data-personal-agent=true]"))

    run.sent()
    await waitFor(() => expect(tourStore.current?.beatId).toBe("done"))
    // Sent, the turn not started yet: the conversation it went into.
    await waitFor(() => expect(ringed()).toBe("message-scroll-container"))
    expect(screen.queryByTestId("tour-scrim")).toBeNull()

    // The answer streams, taller than the little window it is in.
    agent.setStream?.("dm-1", { state: "streaming", error: null })
    chat.liveTurn({ top: 100, left: 900, width: 320, height: 560 })
    await waitFor(() => expect(ringed()).toBe("agent-stream-block"))
    const ring = screen.getByTestId("tour-spotlight")
    const top = Number.parseFloat(ring.style.top)
    const left = Number.parseFloat(ring.style.left)
    expect(top).toBeGreaterThanOrEqual(dock.top)
    expect(left).toBeGreaterThanOrEqual(dock.left)
    expect(top + Number.parseFloat(ring.style.height)).toBeLessThanOrEqual(dock.top + dock.height)
    expect(left + Number.parseFloat(ring.style.width)).toBeLessThanOrEqual(dock.left + dock.width)

    // The turn ended: the step is as it was, nothing ringed on an end card.
    agent.setStream?.("dm-1", { state: "complete", error: null })
    chat.list.querySelector('[data-testid="agent-stream-block"]')?.remove()
    await waitFor(() => expect(ringed()).toBeUndefined())
    expect(screen.getByTestId("tour-scrim")).toBeInTheDocument()
  })

  it("in a Chats thread: the live turn, else the conversation, until the turn ends", async () => {
    const page = { top: 0, left: 300, width: 900, height: 760 }
    const chat = conversation("run-1", page)
    const run = await mountAt("compose-field[data-thread-id=run-1]")
    await waitFor(() => expect(ringed()).toBe("compose-field[data-thread-id=run-1]"))

    run.sent()
    agent.setStream?.("run-1", { state: "streaming", error: null })
    const block = chat.liveTurn({ top: 400, left: 300, width: 900, height: 200 })
    await waitFor(() => expect(tourStore.current?.beatId).toBe("done"))
    await waitFor(() => expect(ringed()).toBe("agent-stream-block"))

    // Scrolled out of sight while it streams: the conversation is ringed instead.
    place(block, { top: 900, left: 300, width: 900, height: 200 })
    await waitFor(() => expect(ringed()).toBe("message-scroll-container"))

    agent.setStream?.("run-1", { state: "idle", error: null })
    block.remove()
    await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull())
  })

  it("a turn that never starts: the ring lets go after a while", async () => {
    conversation("dm-1", { top: 400, left: 600, width: 320, height: 300 })
    const run = await mountAt("compose-field[data-personal-agent=true]", 400)
    run.sent()
    await waitFor(() => expect(ringed()).toBe("message-scroll-container"))
    await waitFor(() => expect(ringed()).toBeUndefined(), { timeout: 2000 })
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TRANSCRIPT FOLLOWS A LIVE SESSION (2026-10-15). A running computer
// session's new rows (Thinking, Skill, Read) landed below the composer while
// the view stayed put. The view now opens at the end, stays pinned while the
// owner is at the bottom (new events and later growth alike), never yanks an
// owner who scrolled up (a "Jump to latest" button counts what arrived), and
// re-pins on a sent message.
import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { resetTabStore } from "~/modules/shell/tab-store"
import type { SessionComposerProps } from "./SessionComposer"
import SessionView from "./SessionView"
import { registerSessionActions, resetSessionActions } from "./session-actions"
import type { NodeSessionRow } from "./session-api"
import { applyEvent, resetSessionStore, setSessionStoreApi } from "./session-store"

const composerProps: SessionComposerProps[] = []
vi.mock("./SessionComposer", () => ({
  default: (p: SessionComposerProps) => {
    composerProps.push(p)
    return null
  },
}))

// jsdom lays nothing out: the scroller gets a mutable fake layout.
const layout = { height: 2000, client: 400 }
const tops = new WeakMap<Element, number>()
const isScroller = (el: Element) => el.getAttribute("data-testid") === "session-scroller"
const saved = {
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
  getClientRects: Object.getOwnPropertyDescriptor(Element.prototype, "getClientRects"),
}
const resizeCallbacks: Array<() => void> = []
/** Real engines turn scroll anchoring off with `overflow-anchor: none`. */
let anchorControl = true
/** The focused card has a layout box (scrollWhenShown scrolls it). */
let cardShown = true
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? layout.height : 0
    },
  })
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? layout.client : 0
    },
  })
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0
    },
    set(this: Element, v: number) {
      const max = isScroller(this) ? Math.max(0, layout.height - layout.client) : 0
      tops.set(this, Math.min(Math.max(0, v), max))
    },
  })
  // A laid-out card: scrollWhenShown scrolls it at once instead of waiting.
  Object.defineProperty(Element.prototype, "getClientRects", {
    configurable: true,
    value: () => (cardShown ? [{ top: 0, height: 10 }] : []),
  })
  vi.stubGlobal("CSS", {
    supports: (prop: string, value: string) =>
      anchorControl && prop === "overflow-anchor" && value === "none",
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resizeCallbacks.push(cb)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(Element.prototype, k, d)
  vi.unstubAllGlobals()
})

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: "s1",
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "app",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Run a pipeline",
    folderName: "sample",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 2,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-15T10:00:00.000Z",
    ...over,
  }
}

function ev(seq: number, text: string, type: NodeSessionEvent["type"] = "assistant_text") {
  return {
    seq,
    at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq * 1000 + 20).toISOString(),
    type,
    payload: { text },
  } as NodeSessionEvent
}

const EVENTS = [ev(1, "Run the pipeline", "user_message"), ev(2, "Launching it.")]

const REQUEST = {
  seq: 3,
  at: new Date(1_800_000_003_000).toISOString(),
  receivedAt: new Date(1_800_000_003_020).toISOString(),
  type: "permission_request",
  payload: { requestId: "r1", tool: "Bash", input: { command: "git push" }, reason: "" },
} as NodeSessionEvent

async function open(opts: { waiting?: boolean } = {}) {
  layout.height = 2000
  layout.client = 400
  const events = opts.waiting ? [...EVENTS, REQUEST] : EVENTS
  const r = opts.waiting
    ? row({ status: "waiting", pendingCount: 1, waitingReason: "permission: Bash", lastSeq: 3 })
    : row()
  const get = vi.fn(async (path: string) =>
    path.includes("/events") ? { events, lastSeq: events.length } : r,
  )
  setSessionStoreApi(() => ({ get }) as never)
  render(() => <SessionView entityId="s1" />)
  await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(events.length))
  return screen.getByTestId("session-scroller")
}

const frames = (n = 4) => new Promise((r) => setTimeout(r, n * 20))

/** A new event from the stream, with the content it adds (px). */
function arrive(seq: number, grow = 300) {
  layout.height += grow
  applyEvent({ sessionId: "s1", ...ev(seq, `step ${seq}`) })
}

function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top
  fireEvent.scroll(el)
}

const bottom = () => layout.height - layout.client

afterEach(() => {
  resetSessionStore()
  resetTabStore()
  composerProps.length = 0
  resizeCallbacks.length = 0
  resetSessionActions()
  anchorControl = true
  cardShown = true
})

describe("SessionView follows the live transcript", () => {
  it("opens at the end of the transcript", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
  })

  it("pinned: every new event keeps the view at the bottom, even a tall one", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    arrive(3)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(3))
    expect(scroller.scrollTop).toBe(bottom())
    // A row far taller than the near-bottom threshold.
    arrive(4, 1500)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(4))
    expect(scroller.scrollTop).toBe(bottom())
    expect(screen.queryByTestId("jump-to-latest")).toBeNull()
  })

  it("pinned: growth with no new event (a row that expands later) re-pins", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    layout.height += 700
    for (const cb of resizeCallbacks) cb()
    expect(scroller.scrollTop).toBe(bottom())
  })

  it("scrolled up: not yanked back; Jump to latest counts the new events and re-pins", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    scrollTo(scroller, 300)
    arrive(3)
    arrive(4)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(4))
    for (const cb of resizeCallbacks) cb()
    expect(scroller.scrollTop).toBe(300)
    const jump = screen.getByTestId("jump-to-latest")
    expect(jump.textContent).toContain("2")
    fireEvent.click(jump)
    expect(scroller.scrollTop).toBe(bottom())
    expect(screen.queryByTestId("jump-to-latest")).toBeNull()
    arrive(5)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(5))
    expect(scroller.scrollTop).toBe(bottom())
  })

  it("reaching the bottom by hand resumes following", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    scrollTo(scroller, 300)
    expect(screen.getByTestId("jump-to-latest")).toBeTruthy()
    scrollTo(scroller, bottom())
    expect(screen.queryByTestId("jump-to-latest")).toBeNull()
    arrive(3)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(3))
    expect(scroller.scrollTop).toBe(bottom())
  })

  it("sending a message from the composer re-pins to the bottom", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    scrollTo(scroller, 300)
    ;(composerProps.at(-1) as SessionComposerProps & { onSend?: () => void }).onSend?.()
    expect(scroller.scrollTop).toBe(bottom())
    arrive(3)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(3))
    expect(scroller.scrollTop).toBe(bottom())
  })

  it("a focused request card at the end leaves the owner at the bottom, following", async () => {
    const scroller = await open({ waiting: true })
    await waitFor(() => expect(screen.getByTestId("request-card").dataset.focused).toBe("true"))
    await frames()
    expect(scroller.scrollTop).toBe(bottom())
    arrive(4)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(4))
    expect(scroller.scrollTop).toBe(bottom())
    expect(screen.queryByTestId("jump-to-latest")).toBeNull()
  })

  it("answering a request card follows the session again", async () => {
    registerSessionActions({ decidePermission: async () => {} })
    const scroller = await open({ waiting: true })
    await waitFor(() => expect(screen.getByTestId("request-card").dataset.focused).toBe("true"))
    await frames()
    scrollTo(scroller, 300)
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(scroller.scrollTop).toBe(bottom())
    arrive(4)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(4))
    expect(scroller.scrollTop).toBe(bottom())
    expect(screen.queryByTestId("jump-to-latest")).toBeNull()
  })

  it("a re-pin never swallows an upward scroll whose event has not arrived yet", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    // A wheel tick / touch inertia moved the view up; its scroll event comes later.
    const up = bottom() - 30
    scroller.scrollTop = up
    arrive(3)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(3))
    expect(scroller.scrollTop).toBe(up)
    fireEvent.scroll(scroller)
    expect(scroller.scrollTop).toBe(up)
    expect(screen.getByTestId("jump-to-latest")).toBeTruthy()
  })

  it("a hidden pane comes back where the owner left it, or at the bottom when following", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    const hide = () => {
      layout.client = 0
      scroller.scrollTop = 0 // display: none drops the offset
      for (const cb of resizeCallbacks) cb()
    }
    const show = () => {
      layout.client = 400
      for (const cb of resizeCallbacks) cb()
    }
    // Following: back at the bottom, including what arrived while hidden.
    hide()
    layout.height += 500
    show()
    expect(scroller.scrollTop).toBe(bottom())
    // Scrolled up: back at the same place, not the top.
    scrollTo(scroller, 300)
    hide()
    show()
    expect(scroller.scrollTop).toBe(300)
    expect(screen.getByTestId("jump-to-latest")).toBeTruthy()
  })

  it("following turns scroll anchoring off; scrolled up, anchoring keeps the reader's place", async () => {
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    expect(scroller.style.getPropertyValue("overflow-anchor")).toBe("none")
    scrollTo(scroller, 300)
    expect(scroller.style.getPropertyValue("overflow-anchor")).toBe("auto")
    fireEvent.click(screen.getByTestId("jump-to-latest"))
    expect(scroller.style.getPropertyValue("overflow-anchor")).toBe("none")
  })

  it("an anchoring shift (rows above shrink, a row appended) is not the owner's scroll", async () => {
    anchorControl = false // an engine that anchors regardless
    const scroller = await open()
    await waitFor(() => expect(scroller.scrollTop).toBe(bottom()))
    // One catch-up batch: a decided card above collapses by 100 px and a 300 px
    // row is appended; the engine anchors, so the offset drops by 100.
    const before = scroller.scrollTop
    layout.height += 200
    scroller.scrollTop = before - 100
    applyEvent({ sessionId: "s1", ...ev(3, "step 3") })
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(3))
    expect(scroller.scrollTop).toBe(bottom())
    // The anchoring's own scroll event, arriving late, does not unpin either.
    layout.height += 50
    scroller.scrollTop = bottom() - 120
    fireEvent.scroll(scroller)
    expect(scroller.scrollTop).toBe(bottom())
    expect(screen.queryByTestId("jump-to-latest")).toBeNull()
  })

  it("a card that settles while its pane is hidden is resolved when the pane is shown", async () => {
    cardShown = false
    const scroller = await open({ waiting: true })
    await waitFor(() => expect(screen.getByTestId("request-card").dataset.focused).toBe("true"))
    // The pane is hidden (another tab) while the card waits for a box, then
    // the card's scroll finishes there, a no-op.
    layout.client = 0
    scroller.scrollTop = 0
    for (const cb of resizeCallbacks) cb()
    cardShown = true
    await frames()
    arrive(4)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(4))
    layout.client = 400
    for (const cb of resizeCallbacks) cb()
    expect(scroller.scrollTop).toBe(bottom())
    expect(screen.queryByTestId("jump-to-latest")).toBeNull()
    arrive(5)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(5))
    expect(scroller.scrollTop).toBe(bottom())
  })
})

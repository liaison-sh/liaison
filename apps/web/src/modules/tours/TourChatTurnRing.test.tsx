// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Live demo walk of the team chat scenario (2026-10-27), two rings in the
// person's conversation with their agent, docked beside a teammate's channel:
//  - after the person approved the agent's web search, the ring went back to
//    the teammate's channel until the agent's resumed turn showed: the
//    "working" fallback rang the first conversation list in the page;
//  - the agent asked before creating the task ("shall I?"): the step rang the
//    asked turn's FIRST tool row, scrolled out of sight, so nothing showed;
//    after the person's "go ahead", the new turn's rows carry the reply's id
//    and the ring stayed on that old first row.
import { findTour, type TourBeatStatus, type TourProgress } from "@liaison/shared"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => findTour(id),
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
  // The follow-up the person sent sits in their conversation with their agent.
  messageStore: { threads: { "dm-1": { byId: { "m-follow": { id: "m-follow" } } } } },
}))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const TOUR_ID = "kernel.scenario-chat"
const WORKING: TourBeatStatus = { kind: "agent-working", since: "2026-10-27T10:00:01.000Z" }
let serverStatus: TourBeatStatus = { kind: "pending" }
let beatId = "task"

const progress = (): TourProgress => {
  const beats = findTour(TOUR_ID)?.beats ?? []
  return {
    tourId: TOUR_ID,
    status: "active",
    beatId,
    beatIndex: beats.findIndex((b) => b.id === beatId),
    beatCount: beats.length,
    beatStates: {
      conversation: { state: "done", entityId: "dm-1" },
      question: { state: "done", entityId: "ch-1" },
      "ask-agent": { state: "done", entityId: "m-ask" },
      ...(beatId === "task" ? { "follow-up": { state: "done", entityId: "m-follow" } } : {}),
    },
    source: "help",
    startedAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    beatStatus: serverStatus,
  }
}

const api = (): TourApi => ({
  list: vi.fn(async () => [
    {
      tourId: TOUR_ID,
      app: "kernel",
      title: "tours.scenarios.chat.title",
      summary: "",
      beatCount: progress().beatCount,
      progress: progress(),
    },
  ]),
  start: vi.fn(async () => progress()),
  update: vi.fn(async () => progress()),
  progress: vi.fn(async () => progress()),
})

/** An element on screen at `top` (jsdom lays nothing out). */
function el(testid: string, top: number, attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement("div")
  node.dataset.testid = testid
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  node.getClientRects = () => [{}] as unknown as DOMRectList
  node.getBoundingClientRect = () =>
    ({ top, left: 10, bottom: top + 30, right: 310, width: 300, height: 30 }) as DOMRect
  return node
}

/**
 * The teammate's channel (first in the page, with its own list and composer),
 * and the docked conversation with the agent beside it, holding `rows`.
 */
function screenWith(rows: HTMLElement[]) {
  const channel = el("thread-view", 0)
  const channelList = el("message-scroll-container", 20)
  channelList.append(el("message-row", 30, { "data-thread-id": "ch-1" }))
  channel.append(channelList, el("compose-field", 700, { "data-thread-id": "ch-1" }))
  const dock = el("dock-window", 0)
  const dockList = el("message-scroll-container", 60)
  dockList.append(...rows)
  dock.append(dockList, el("compose-field", 600, { "data-thread-id": "dm-1" }))
  document.body.append(channel, dock)
}

/** The ring's top edge, near the element it rings. */
const ringTop = () => Number.parseFloat(screen.getByTestId("tour-spotlight").style.top)

let dispose: () => void = () => {}
beforeEach(() => {
  serverStatus = { kind: "pending" }
  beatId = "task"
  resetTourStore()
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

describe("the team chat scenario's rings in the docked conversation", () => {
  it("the agent working after an approval: the docked conversation, never the channel behind", async () => {
    beatId = "searching"
    // The approved search's turn has not drawn anything yet.
    screenWith([el("message-row", 100)])
    serverStatus = WORKING
    await mount()
    await screen.findByTestId("tour-working")
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("message-scroll-container"),
    )
    // The dock's list (top 60), not the teammate's channel (top 20).
    expect(ringTop()).toBeGreaterThan(40)
  })

  it("the agent asked before creating the task: the composer to reply in is ringed", async () => {
    screenWith([
      el("tool-call-row", 80, { "data-turn-id": "m-follow", "data-tool-name": "projects__list" }),
      el("agent-answer", 300, { "data-turn-id": "m-follow" }),
    ])
    await mount()
    agent.setStream?.("dm-1", { state: "streaming", error: null })
    serverStatus = WORKING
    await tourStore.refresh(TOUR_ID)
    await screen.findByTestId("tour-working")
    agent.setStream?.("dm-1", { state: "complete", error: null })
    serverStatus = { kind: "pending" }
    await tourStore.refresh(TOUR_ID)
    await screen.findByTestId("tour-agent-answered")
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe(
        "compose-field[data-thread-id=dm-1]",
      ),
    )
    expect(ringTop()).toBeGreaterThan(500)
  })

  it("after the person's go-ahead: the latest tool row, of the reply's turn", async () => {
    screenWith([
      el("tool-call-row", 80, { "data-turn-id": "m-follow", "data-tool-name": "projects__list" }),
      el("agent-answer", 150, { "data-turn-id": "m-follow" }),
      el("message-row", 200),
      el("tool-call-row", 400, { "data-turn-id": "m-go", "data-tool-name": "projects__create" }),
    ])
    await mount()
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe(
        "tool-call-row[data-turn-id=m-follow]",
      ),
    )
    // The create row of the reply's turn (top 400), not the asked turn's first (top 80).
    await waitFor(() => expect(ringTop()).toBeGreaterThan(300))
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Walk D71: once the person's request was sent and their agent was working on
// it, the step still rang the composer and still offered "Do it for me" (which
// would send the request again), under a line saying the agent was working.
// While the turn runs, the step points at the agent's live turn (or at nothing
// when it is not on screen) and offers nothing to press; a failed turn brings
// back Try again. Whether the turn runs is the server's word, in the step's
// status (`beatStatus: agent-working`), read on load, on every tour frame and
// on a Do it for me press: never inferred from live stream frames.
import { defineTour, type TourBeatStatus, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tourMenuItem } from "./test-helpers"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

type Stream = { state: string; error: { message: string } | null }
const agent = vi.hoisted(() => ({
  stream: null as null | Stream,
  setStream: null as null | ((s: Stream) => void),
}))
vi.mock("~/modules/threads/personal-dm-store", () => ({ knownPersonalAgentDmId: () => "dm-1" }))
const server = vi.hoisted(() => ({
  /** The step status the server computes (agent-working while it runs the turn). */
  status: { kind: "pending" } as unknown,
  reads: 0,
  /** The step the run is on. */
  beatId: "create",
  /** Holds the progress answer until released (null: answers at once). */
  gate: null as null | Promise<void>,
}))
vi.mock("~/modules/threads/message-store", () => ({
  getChannelAgentStream: () => agent.stream,
  getMessages: () => [],
}))

const approvals = vi.hoisted(() => ({
  decided: [] as { id: string; decision: string; payloadHash?: string }[],
}))
vi.mock("~/modules/approvals/approvals-service", () => ({
  decideApproval: async (
    _api: unknown,
    id: string,
    body: { decision: string; payloadHash?: string },
  ) => {
    approvals.decided.push({ id, decision: body.decision, payloadHash: body.payloadHash })
    return {}
  },
  // What the request says now: an approve carries its fingerprint.
  getApproval: async (_api: unknown, id: string) => ({ id, payloadHash: `hash-${id}` }),
}))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { ApiContext } = await import("~/modules/shell/ApiContext")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "knowledge.fixture-working",
  app: "knowledge",
  title: "tours.knowledge.basics.title",
  summary: "tours.knowledge.basics.summary",
  beats: [
    {
      // The agent completes it, from the request the person sent.
      id: "create",
      kind: "do",
      title: "tours.knowledge.basics.create.title",
      body: "tours.knowledge.basics.create.body",
      anchor: "fixture-composer",
      event: { app: "knowledge", entity: "document", action: "create", actor: "user-or-agent" },
      autoplay: [{ click: "fixture-composer" }, { waitEvent: true }],
    },
    {
      id: "next",
      kind: "show",
      title: "tours.knowledge.basics.recent.title",
      body: "tours.knowledge.basics.recent.body",
    },
    {
      // Shows the agent's answer: Next waits for the agent to finish it.
      id: "answer",
      kind: "show",
      title: "tours.knowledge.basics.recent.title",
      body: "tours.knowledge.basics.recent.body",
      anchor: "fixture-answer",
      waitsOn: "agent",
    },
  ],
})

const base: TourProgress = {
  tourId: tour.id,
  status: "active",
  beatId: "create",
  beatIndex: 0,
  beatCount: 3,
  beatStates: {},
  source: "help",
  startedAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
}
const progress = (): TourProgress => ({
  ...base,
  beatId: server.beatId,
  beatIndex: tour.beats.findIndex((b) => b.id === server.beatId),
  beatStatus: server.status as TourBeatStatus,
})

const api = (): TourApi => ({
  list: vi.fn(async () => [
    {
      tourId: tour.id,
      app: "knowledge",
      title: tour.title,
      summary: "",
      beatCount: 3,
      progress: progress(),
    },
  ]),
  start: vi.fn(async () => progress()),
  update: vi.fn(async () => progress()),
  progress: vi.fn(async () => {
    server.reads += 1
    if (server.gate) await server.gate
    return progress()
  }),
})

/** The server's status changed: it pushes a tour frame, the card re-reads. */
async function serve(status: TourBeatStatus): Promise<void> {
  server.status = status
  tourStore.onFrame(
    {
      ownerUserId: "u-1",
      tourId: tour.id,
      status: "active",
      beatId: server.beatId,
      beatIndex: tour.beats.findIndex((b) => b.id === server.beatId),
      emittedAt: new Date().toISOString(),
    },
    "u-1",
  )
  await new Promise((r) => setTimeout(r, 0))
}

const WORKING: TourBeatStatus = { kind: "agent-working", since: "2026-10-24T10:00:01.000Z" }
const PENDING: TourBeatStatus = { kind: "pending" }

function onScreen(testid: string): HTMLElement {
  const el = document.createElement("div")
  el.dataset.testid = testid
  el.getClientRects = () => [{}] as unknown as DOMRectList
  el.getBoundingClientRect = () =>
    ({ top: 10, left: 10, bottom: 50, right: 210, width: 200, height: 40 }) as DOMRect
  document.body.append(el)
  return el
}

let dispose: () => void = () => {}
beforeEach(() => {
  server.beatId = "create"
  server.status = PENDING
  server.reads = 0
  server.gate = null
  fixtures.tours = [tour]
  resetTourStore()
  onScreen("fixture-composer")
  createRoot((d) => {
    dispose = d
    const [stream, setStream] = createStore<Stream>({ state: "idle", error: null })
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

async function mount() {
  setTourApi(api())
  render(() => <TourOverlay {...timing} />)
  await tourStore.load()
  await screen.findByTestId("tour-panel")
}

describe("a step whose agent is working on the request", () => {
  it("before the request: rings the composer and offers Do it for me", async () => {
    await mount()
    expect(await screen.findByTestId("tour-do-for-me")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("fixture-composer"),
    )
  })

  it("while the turn runs: says so, offers nothing to press and rings the live turn", async () => {
    await mount()
    onScreen("agent-stream-block")
    await serve(WORKING)
    await screen.findByTestId("tour-working")
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
    expect(screen.queryByTestId("tour-do-myself")).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("agent-stream-block"),
    )
  })

  it("a step showing the answer keeps Next off while the agent is still answering", async () => {
    server.beatId = "answer"
    await mount()
    // The answer's first words are on screen, the turn is still running.
    onScreen("fixture-answer")
    await serve(WORKING)
    await waitFor(() => expect(screen.getByTestId("tour-next")).toBeDisabled())
    await serve(PENDING)
    await waitFor(() => expect(screen.getByTestId("tour-next")).not.toBeDisabled())
  })

  it("while the turn runs off screen: rings nothing, the composer least of all", async () => {
    await mount()
    await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeInTheDocument())
    await serve(WORKING)
    await screen.findByTestId("tour-working")
    await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull())
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
  })

  it("while the turn runs out of sight: rings the conversation on screen", async () => {
    await mount()
    onScreen("message-scroll-container")
    await serve(WORKING)
    await screen.findByTestId("tour-working")
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("message-scroll-container"),
    )
  })

  it("a failed turn brings back Try again", async () => {
    await mount()
    agent.setStream?.({ state: "streaming", error: null })
    await serve(WORKING)
    await screen.findByTestId("tour-working")
    agent.setStream?.({ state: "error", error: { message: "provider down" } })
    await serve(PENDING)
    await screen.findByTestId("tour-agent-failed")
    expect(screen.getByTestId("tour-do-for-me")).toBeInTheDocument()
    expect(await tourMenuItem("tour-skip-beat")).toBeInTheDocument()
  })

  it("the server says the turn ended: the step is free again, whatever frames this tab heard", async () => {
    await mount()
    // A live block this tab still draws as running (its end never arrived).
    agent.setStream?.({ state: "streaming", error: null })
    await serve(WORKING)
    await screen.findByTestId("tour-working")
    await serve(PENDING)
    await screen.findByTestId("tour-do-for-me")
    expect(screen.queryByTestId("tour-working")).toBeNull()
  })

  it("a reconnect that missed the turn's end frame re-reads the server and frees the step", async () => {
    server.status = WORKING
    await mount()
    await screen.findByTestId("tour-working")
    // The end was never pushed to this tab; the tab comes back and re-reads.
    server.status = PENDING
    await tourStore.refresh(tour.id)
    await screen.findByTestId("tour-do-for-me")
  })
})

// Walk D78: for a second or two after a played step (the request went out, the
// approval was pressed) and after the answer landed, the step said the agent
// was working AND offered Do it for me, and a quick second press landed on
// that stale step. The step shows one state: the agent (or the tour's own
// press) is on it, with nothing to press, or it waits on the visitor.
describe("one state at a time: working, or waiting on the visitor", () => {
  it("once Do it for me sent the request: working, and no Do it for me, before the turn starts", async () => {
    await mount()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await screen.findByTestId("tour-working")
    await waitFor(() => expect(tourStore.autoplay.status).not.toBe("playing"))
    expect(screen.getByTestId("tour-working")).toBeInTheDocument()
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
  })

  it("after the answer landed and before the step moves on: still no Do it for me", async () => {
    await mount()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(tourStore.autoplay.status).not.toBe("playing"))
    await serve(WORKING)
    await screen.findByTestId("tour-working")
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
  })

  it("a frame saying the step is done: the stale step offers nothing while its next one loads", async () => {
    setTourApi({
      ...api(),
      // The read of the next step is still on its way.
      progress: vi.fn(() => new Promise<TourProgress>(() => {})),
    })
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await screen.findByTestId("tour-do-for-me")
    tourStore.onFrame(
      {
        ownerUserId: "u-1",
        tourId: tour.id,
        status: "active",
        beatId: "next",
        beatIndex: 1,
        emittedAt: new Date().toISOString(),
      },
      "u-1",
    )
    await waitFor(() => expect(screen.queryByTestId("tour-do-for-me")).toBeNull())
    expect(screen.queryByTestId("tour-do-myself")).toBeNull()
    expect(screen.queryByTestId("tour-working")).toBeNull()
  })

  it("the person's own I'll do it on an agent step does not claim the agent is working", async () => {
    await mount()
    fireEvent.click(await screen.findByTestId("tour-do-myself"))
    await screen.findByTestId("tour-waiting")
    expect(screen.queryByTestId("tour-working")).toBeNull()
    expect(screen.getByTestId("tour-do-for-me")).toBeInTheDocument()
  })
})

// Walk D79: a page reloaded while the agent's turn still ran showed nothing
// live until the turn's next frame (6.8 s, and 75 s in a turn that took 84 s
// to set up), and the step offered I'll do it and Do it for me again: a press
// would have sent the same ask twice. The step asks the server which turns run.
describe("after a reload while the agent's turn runs", () => {
  it("the server's running turn: the step says the agent is working, with no Do it for me", async () => {
    server.status = WORKING
    await mount()
    await screen.findByTestId("tour-working")
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
    expect(screen.queryByTestId("tour-do-myself")).toBeNull()
  })

  it("a Do it for me press while the server reports the turn running sends nothing", async () => {
    const composerClicks = vi.fn()
    document
      .querySelector('[data-testid="fixture-composer"]')
      ?.addEventListener("click", composerClicks)
    await mount()
    let release: () => void = () => {}
    server.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // The turn started meanwhile; the press asks the server before sending.
    server.status = WORKING
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    release()
    await screen.findByTestId("tour-working")
    await new Promise((r) => setTimeout(r, 60))
    expect(server.reads).toBeGreaterThan(0)
    expect(composerClicks).not.toHaveBeenCalled()
    expect(tourStore.spentBeatId).toBeNull()
  })

  it("no turn running: Do it for me sends the ask", async () => {
    const composerClicks = vi.fn()
    document
      .querySelector('[data-testid="fixture-composer"]')
      ?.addEventListener("click", composerClicks)
    await mount()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(composerClicks).toHaveBeenCalled())
  })
})

// Live demo 2026-10-26: the agent's web search parked for approval (the
// conversation had read data some readers cannot see, so an outward call asks
// first) and the card kept saying it waited for the answer, with nothing
// telling the person to approve. Any tool the turn parks, for any reason,
// makes the server's step status held-for-approval with that request.
describe("a step whose agent turn parked a tool call for approval", () => {
  const HELD: TourBeatStatus = {
    kind: "held-for-approval",
    requestId: "req-282",
    toolName: "kernel:web_search",
    reason: "outside content",
  }

  it("says so, rings that request's card, and Do it for me approves that very request", async () => {
    approvals.decided = []
    onScreen("approval-card[data-request-id=req-282]").dataset.testid = "approval-card"
    document
      .querySelector('[data-testid="approval-card"]')
      ?.setAttribute("data-request-id", "req-282")
    server.status = HELD
    setTourApi(api())
    render(() => (
      <ApiContext.Provider value={{} as never}>
        <TourOverlay {...timing} />
      </ApiContext.Provider>
    ))
    await tourStore.load()
    const title = await screen.findByTestId("tour-beat-title")
    expect(title.textContent).toContain("asks first")
    expect(screen.getByTestId("tour-beat-body").textContent).toContain("web search")
    // The workspace's own tool reads without its prefix (walk, 2026-10-26).
    expect(screen.getByTestId("tour-beat-body").textContent).not.toContain("kernel")
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe(
        "approval-card[data-request-id=req-282]",
      ),
    )
    expect(screen.queryByTestId("tour-working")).toBeNull()
    fireEvent.click(screen.getByTestId("tour-do-for-me"))
    // Its card's own Approve is not on screen: the approve names what it reviewed.
    await waitFor(() =>
      expect(approvals.decided).toEqual([
        { id: "req-282", decision: "approve", payloadHash: "hash-req-282" },
      ]),
    )
  })

  // Demo 2026-10-29: an approved fetch failed and the request went back to
  // pending; every Do it for me approved it again, and the thread collected one
  // failure notice per press. The tour approves a parked request once.
  it("a request it already approved once, back at pending, is never approved again", async () => {
    approvals.decided = []
    onScreen("approval-card[data-request-id=req-282]").dataset.testid = "approval-card"
    server.status = HELD
    setTourApi(api())
    render(() => (
      <ApiContext.Provider value={{} as never}>
        <TourOverlay {...timing} />
      </ApiContext.Provider>
    ))
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(approvals.decided).toHaveLength(1))
    // Still held (the run failed and was put back): nothing more to press.
    await waitFor(() =>
      expect((screen.getByTestId("tour-do-for-me") as HTMLButtonElement).disabled).toBe(true),
    )
    fireEvent.click(screen.getByTestId("tour-do-for-me"))
    await new Promise((r) => setTimeout(r, 30))
    expect(approvals.decided).toHaveLength(1)
  })

  it("with the request's card on screen, Do it for me presses that card's own Approve", async () => {
    approvals.decided = []
    onScreen("approval-card[data-request-id=req-282]").dataset.testid = "approval-card"
    document
      .querySelector('[data-testid="approval-card"]')
      ?.setAttribute("data-request-id", "req-282")
    const approve = onScreen("approval-card-action-approve")
    approve.dataset.entityId = "req-282"
    const pressed = vi.fn()
    approve.addEventListener("click", pressed)
    server.status = HELD
    setTourApi(api())
    render(() => (
      <ApiContext.Provider value={{} as never}>
        <TourOverlay {...timing} />
      </ApiContext.Provider>
    ))
    await tourStore.load()
    await screen.findByTestId("tour-do-for-me")
    fireEvent.click(screen.getByTestId("tour-do-for-me"))
    await waitFor(() => expect(pressed).toHaveBeenCalledOnce())
    expect(approvals.decided).toEqual([])
  })

  // A held dispatch shows in the conversation as its own card, which the step
  // rings and whose Approve Do it for me presses.
  it("a held dispatch: rings the dispatch card, and Do it for me presses its Approve", async () => {
    approvals.decided = []
    const card = onScreen("node-dispatch-approval")
    card.dataset.requestId = "req-290"
    const approve = onScreen("node-dispatch-approval-approve")
    approve.dataset.entityId = "req-290"
    const pressed = vi.fn()
    approve.addEventListener("click", pressed)
    server.status = { ...HELD, requestId: "req-290", toolName: "kernel:run_on_my_computer" }
    setTourApi(api())
    render(() => (
      <ApiContext.Provider value={{} as never}>
        <TourOverlay {...timing} />
      </ApiContext.Provider>
    ))
    await tourStore.load()
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe(
        "node-dispatch-approval[data-request-id=req-290]",
      ),
    )
    fireEvent.click(screen.getByTestId("tour-do-for-me"))
    await waitFor(() => expect(pressed).toHaveBeenCalledOnce())
    expect(approvals.decided).toEqual([])
  })

  it("once approved: the agent works again, then the step is done", async () => {
    server.status = HELD
    await mount()
    await waitFor(() =>
      expect(screen.getByTestId("tour-beat-title").textContent).toContain("asks first"),
    )
    await serve(WORKING)
    await screen.findByTestId("tour-working")
    expect(screen.getByTestId("tour-beat-title").textContent).not.toContain("asks first")
  })
})

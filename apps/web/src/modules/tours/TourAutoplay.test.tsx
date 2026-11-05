// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T7: "Do it for me" and "Play whole scenario" through the panel: the
// ghost cursor plays, the beat then waits for its event; user input hands
// over; a missing target stops with a message; show beats move on by
// themselves while the whole scenario plays.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { findTourMenuItem, pressTourMenuItem, tourMenuItem } from "./test-helpers"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
const nav = vi.hoisted(() => ({ spaNavigate: vi.fn() }))
vi.mock("~/framework/spa-navigate", () => nav)
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { applyProgress, resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "kernel.auto",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "intro",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
    },
    {
      id: "write",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      anchor: "fixture-input",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [
        { type: { testid: "fixture-input", text: "tours.kernel.sample.postMessage.text" } },
        { press: { testid: "fixture-input", key: "Enter" } },
        { waitEvent: true },
      ],
    },
    {
      id: "elsewhere",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-on-another-page",
      route: "/elsewhere",
    },
    {
      id: "broken",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ click: "fixture-not-there" }],
    },
    {
      id: "guarded",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [
        { require: { testid: "fixture-input", attr: "data-action", value: "add-note" } },
        { press: { testid: "fixture-input", key: "Enter" } },
        { waitEvent: true },
      ],
    },
    {
      // The agent's work answering the request `write` sent: nothing to press.
      id: "agent-work",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      event: {
        app: "projects",
        entity: "task",
        action: "created",
        actor: "user-or-agent",
        causedBy: "write",
      },
      autoplay: [{ waitEvent: true }],
    },
    {
      // A routine's work on what `write` recorded: nobody's request to send again.
      id: "routine-work",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      event: {
        app: "tickets",
        entity: "note",
        action: "create",
        match: { ticketId: "{write}" },
        actor: "any",
      },
      autoplay: [{ waitEvent: true }],
    },
    {
      // The agent's answer the scenario points at (its sources): it takes a turn to come.
      id: "answer",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-answer",
      waitsOn: "agent",
    },
    {
      // Ask from an open item: the dock it points at is on every screen, the
      // list its script starts from only on its own (walk D50).
      id: "from-list",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      anchor: "fixture-input",
      route: "/list",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ click: "fixture-row", unlessVisible: "fixture-open" }, { waitEvent: true }],
    },
    {
      // Approve what `write`'s agent proposed: its card lands while the agent
      // still writes the message that carries it (walk D46).
      id: "approve-late",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      event: {
        app: "kernel",
        entity: "approval_request",
        action: "update",
        match: { status: "approved" },
        sameEntityAs: "write",
      },
      waitsOn: "agent",
      autoplay: [
        {
          waitFor: {
            testid: "fixture-approve",
            created: { beat: "write", attr: "data-entity-id" },
          },
        },
        {
          click: { testid: "fixture-approve", created: { beat: "write", attr: "data-entity-id" } },
        },
        { waitEvent: true },
      ],
    },
    {
      // A routine's request to open and read: its row comes once the routine
      // drafted it, and the beat points at the open card.
      id: "open-late",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-card",
      reach: [{ waitFor: "fixture-row" }, { click: "fixture-row", unlessVisible: "fixture-card" }],
      waitsOn: "routine",
    },
    {
      // Approve a routine's request; after a failed step the routine proposes
      // a corrected one, and its button comes back while the beat still waits.
      id: "approve-again",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      anchor: "fixture-approve-again",
      event: { app: "kernel", entity: "approval_request", action: "update" },
      waitsOn: "routine",
      autoplay: [
        { waitFor: "fixture-approve-again" },
        { click: "fixture-approve-again" },
        { waitEvent: true },
      ],
    },
  ],
})

function progress(beatId: string, beatIndex: number): TourProgress {
  return {
    tourId: "kernel.auto",
    status: "active",
    beatId,
    beatIndex,
    beatCount: 5,
    beatStates: {},
    source: "help",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
  }
}

function api(start: TourProgress, over: Partial<TourApi> = {}): TourApi {
  return {
    list: vi.fn(async () => [
      {
        tourId: "kernel.auto",
        app: "kernel",
        title: "",
        summary: "",
        beatCount: 5,
        progress: start,
      },
    ]),
    start: vi.fn(async () => start),
    update: vi.fn(async () => start),
    progress: vi.fn(async () => start),
    ...over,
  }
}

let textarea: HTMLTextAreaElement
const sent = vi.fn()

beforeEach(() => {
  fixtures.tours = [tour]
  resetTourStore()
  sent.mockReset()
  textarea = document.createElement("textarea")
  textarea.dataset.testid = "fixture-input"
  textarea.getClientRects = () => [{}] as unknown as DOMRectList
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sent(textarea.value)
  })
  document.body.append(textarea)
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

const timing = { typeDelayMs: 5, stepPauseMs: 0, findTimeoutMs: 80, showBeatMs: 30 }

describe("autoplay through the panel", () => {
  it("Do it for me types with the ghost cursor, then waits for the event", async () => {
    setTourApi(api(progress("write", 1)))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    expect(await screen.findByTestId("tour-autoplay-playing")).toBeTruthy()
    expect(await screen.findByTestId("tour-ghost-cursor")).toBeTruthy()
    await waitFor(() => expect(sent).toHaveBeenCalledWith("Hello from the tour"), { timeout: 5000 })
    expect(await screen.findByTestId("tour-waiting")).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId("tour-ghost-cursor")).toBeNull())
  })

  it("types the tour's text in the person's language", async () => {
    setTourApi(api(progress("write", 1)))
    render(() => (
      <I18nProvider initialLocale="fr">
        <TourOverlay {...timing} />
      </I18nProvider>
    ))
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(
      () => expect(sent).toHaveBeenCalledWith("Bonjour, ce message vient de la visite guidée."),
      {
        timeout: 5000,
      },
    )
  })

  it("user input during autoplay hands over and says so", async () => {
    setTourApi(api(progress("write", 1)))
    render(() => (
      <TourOverlay
        {...timing}
        typeDelayMs={20}
        isUserInput={(e) => e.type === "keydown" && (e as KeyboardEvent).key === "Shift"}
      />
    ))
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(textarea.value.length).toBeGreaterThan(1))
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }))
    expect(await screen.findByTestId("tour-autoplay-takeover")).toBeTruthy()
    const typed = textarea.value.length
    await new Promise((r) => setTimeout(r, 100))
    expect(textarea.value.length).toBe(typed)
    expect(textarea.value).not.toBe("Hello from the tour")
    expect(sent).not.toHaveBeenCalled()
    // The takeover line is the one status line (it says the step waits on the person).
    expect(document.querySelectorAll("[data-tour-status]")).toHaveLength(1)
    expect(screen.getByTestId("tour-do-for-me")).toBeTruthy()
  })

  it("a missing target stops autoplay with a message", async () => {
    setTourApi(api(progress("broken", 3)))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    const failed = await screen.findByTestId("tour-autoplay-failed")
    expect(failed.textContent).toContain("could not find")
    expect(failed.textContent).not.toContain("fixture-not-there")
    expect(screen.queryByTestId("tour-waiting")).toBeNull()
  })

  it("a guard that does not hold stops autoplay before it acts, with its own message", async () => {
    setTourApi(api(progress("guarded", 4)))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    const refused = await screen.findByTestId("tour-autoplay-refused")
    expect(refused.getAttribute("data-target")).toBe("fixture-input")
    expect(refused.textContent).toContain("stopped before doing anything")
    expect(sent).not.toHaveBeenCalled()
  })

  it("Play whole scenario goes to a beat's page when its anchor is not on screen", async () => {
    nav.spaNavigate.mockClear()
    const current = progress("elsewhere", 2)
    setTourApi(api(current))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    await waitFor(() => expect(nav.spaNavigate).toHaveBeenCalledWith("/elsewhere"))
  })

  it("Play whole scenario opens the page of a do beat done before it got there, to be read", async () => {
    nav.spaNavigate.mockClear()
    const current = { ...progress("from-list", 8), beatStates: { "from-list": "done" as const } }
    setTourApi(api(current))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    await waitFor(() => expect(nav.spaNavigate).toHaveBeenCalledWith("/list"))
  })

  it("a beat whose anchor is on screen stays where it is", async () => {
    nav.spaNavigate.mockClear()
    const el = document.createElement("div")
    el.dataset.testid = "fixture-on-another-page"
    el.getClientRects = () => [{}] as unknown as DOMRectList
    document.body.append(el)
    setTourApi(api(progress("elsewhere", 2)))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    await new Promise((r) => setTimeout(r, 60))
    expect(nav.spaNavigate).not.toHaveBeenCalled()
  })

  it("Play whole scenario: a show beat moves on by itself, the next do beat plays", async () => {
    let current = progress("intro", 0)
    const update = vi.fn(async (_id: string, body: unknown) => {
      if ((body as { advance?: boolean }).advance) current = progress("write", 1)
      return current
    })
    setTourApi(api(current, { update, progress: vi.fn(async () => current) }))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("kernel.auto", { advance: true, fromBeatId: "intro" }),
    )
    await waitFor(() => expect(sent).toHaveBeenCalledWith("Hello from the tour"), { timeout: 5000 })
    expect(await tourMenuItem("tour-stop-playing")).toBeTruthy()
    await pressTourMenuItem("tour-stop-playing")
    expect(await findTourMenuItem("tour-play-all")).toBeTruthy()
  })

  // A show beat pointing at another screen: play-all goes there and waits for
  // what it points at before moving on, never advancing past it unseen.
  it("Play whole scenario: a show beat on another screen moves on only once its element is there", async () => {
    nav.spaNavigate.mockClear()
    const update = vi.fn(async () => progress("elsewhere", 2))
    setTourApi(api(progress("elsewhere", 2), { update }))
    render(() => <TourOverlay {...timing} showAnchorWaitMs={2000} tourAnchorWaitMs={2000} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    await waitFor(() => expect(nav.spaNavigate).toHaveBeenCalledWith("/elsewhere"))
    // Well past showBeatMs, the element is not there yet: nothing moved.
    await new Promise((r) => setTimeout(r, 150))
    expect(update).not.toHaveBeenCalled()
    const el = document.createElement("div")
    el.dataset.testid = "fixture-on-another-page"
    el.getClientRects = () => [{}] as unknown as DOMRectList
    document.body.append(el)
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("kernel.auto", {
        advance: true,
        fromBeatId: "elsewhere",
      }),
    )
  })

  it("Play whole scenario: a demo scenario's show beat whose element never appears stops with the refusal line", async () => {
    fixtures.tours = [{ ...tour, demoOnly: true }]
    const update = vi.fn(async () => progress("elsewhere", 2))
    setTourApi(api(progress("elsewhere", 2), { update }))
    render(() => <TourOverlay {...timing} showAnchorWaitMs={120} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    const failed = await screen.findByTestId("tour-autoplay-failed", {}, { timeout: 3000 })
    expect(failed.getAttribute("data-missing")).toBe("fixture-on-another-page")
    expect(update).not.toHaveBeenCalled()
    expect(await tourMenuItem("tour-play-all")).toBeTruthy()
  })

  it("Play whole scenario: an app tour's show beat whose element is absent moves on after a short wait", async () => {
    const update = vi.fn(async () => progress("elsewhere", 2))
    setTourApi(api(progress("elsewhere", 2), { update }))
    render(() => <TourOverlay {...timing} tourAnchorWaitMs={120} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("kernel.auto", {
        advance: true,
        fromBeatId: "elsewhere",
      }),
    )
    expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
  })

  // A played beat whose event does not come (the agent asked back) never
  // waits in silence: it says so, with Try again and Skip this step.
  it("a played do beat still waiting for its event says so, with Try again and Skip", async () => {
    setTourApi(api(progress("write", 1)))
    render(() => <TourOverlay {...timing} eventWaitMs={150} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(sent).toHaveBeenCalled(), { timeout: 5000 })
    expect(await screen.findByTestId("tour-waiting")).toBeTruthy()
    const line = await screen.findByTestId("tour-agent-waiting", {}, { timeout: 3000 })
    expect(line.textContent).toContain("has not done this yet")
    expect(screen.getByTestId("tour-do-for-me").textContent).toContain("Try again")
    expect(await tourMenuItem("tour-skip-beat")).toBeTruthy()
  })

  // Try again on a beat waiting for the agent re-sends the request it waits
  // on: a new message, so a new agent turn, never the same silent wait again.
  it("Try again on a beat waiting for the agent sends its request again, then waits once more", async () => {
    setTourApi(
      api({
        ...progress("agent-work", 5),
        beatStates: { write: { state: "done", entityId: "m1" } },
      }),
    )
    render(() => <TourOverlay {...timing} waitOnMs={{ agent: 120 }} />)
    await tourStore.load()
    // The agent does this step: nothing to press on the card, the whole
    // scenario plays it (waits for the event).
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
    await pressTourMenuItem("tour-play-all")
    await screen.findByTestId("tour-agent-waiting", {}, { timeout: 3000 })
    expect(sent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("tour-do-for-me"))
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1), { timeout: 5000 })
    expect(sent.mock.calls[0]?.[0]).toBe("Hello from the tour")
    // Back to waiting on this beat's own event: the agent is working on it.
    expect(await screen.findByTestId("tour-working")).toBeTruthy()
    expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("agent-work")
    await screen.findByTestId("tour-agent-waiting", {}, { timeout: 3000 })
  })

  it("a beat waiting on a routine's work has nothing to send again: only Skip", async () => {
    setTourApi(
      api({
        ...progress("routine-work", 6),
        beatStates: { write: { state: "done", entityId: "t1" } },
      }),
    )
    render(() => <TourOverlay {...timing} waitOnMs={{ routine: 120 }} />)
    await tourStore.load()
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
    await pressTourMenuItem("tour-play-all")
    expect((await screen.findByTestId("tour-working")).textContent).toContain("routine is running")
    await screen.findByTestId("tour-agent-waiting", {}, { timeout: 3000 })
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
    expect(await tourMenuItem("tour-skip-beat")).toBeTruthy()
  })

  // Walk D35: "With its sources" gave up after 60 s while the agent's sourced
  // answer landed 38 s later. A beat waiting on the agent waits as long as a
  // turn takes, says so, and only then offers Try again and Skip, still
  // watching: the answer arriving after that moves it on.
  it("Play whole scenario: a show beat waiting on the agent's answer waits for the turn, then offers Try again and Skip, and moves on when it comes", async () => {
    fixtures.tours = [{ ...tour, demoOnly: true }]
    const update = vi.fn(async () => progress("answer", 7))
    setTourApi(api(progress("answer", 7), { update }))
    render(() => <TourOverlay {...timing} showAnchorWaitMs={40} waitOnMs={{ agent: 400 }} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    const working = await screen.findByTestId("tour-working")
    expect(working.textContent).toContain("Your agent is working on it")
    // Well past the plain anchor wait, it has not given up.
    await new Promise((r) => setTimeout(r, 150))
    expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
    expect(await tourMenuItem("tour-skip-beat")).toBeNull()
    expect(screen.getByTestId("tour-working")).toBeTruthy()
    // Past the turn's wait: Try again and Skip, never the refusal line.
    await screen.findByTestId("tour-agent-waiting", {}, { timeout: 3000 })
    expect(screen.getByTestId("tour-do-for-me").textContent).toContain("Try again")
    expect(await tourMenuItem("tour-skip-beat")).toBeTruthy()
    expect(screen.queryByTestId("tour-next")).toBeNull()
    expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
    expect(update).not.toHaveBeenCalled()
    // The answer lands after that: the beat shows it and moves on.
    const answer = document.createElement("div")
    answer.dataset.testid = "fixture-answer"
    answer.getClientRects = () => [{}] as unknown as DOMRectList
    document.body.append(answer)
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("kernel.auto", { advance: true, fromBeatId: "answer" }),
    )
  })

  // Knowledge's answer beat: the answer's element is there from the turn's
  // first words. A person's Next stays off while the agent writes; play-all
  // waits the same way, then gives the finished answer its reading time.
  it("Play whole scenario: a show beat waiting on the agent moves on only once its turn ends", async () => {
    fixtures.tours = [{ ...tour, demoOnly: true }]
    const answer = document.createElement("div")
    answer.dataset.testid = "fixture-answer"
    answer.getClientRects = () => [{}] as unknown as DOMRectList
    document.body.append(answer)
    let current: TourProgress = {
      ...progress("answer", 7),
      beatStatus: { kind: "agent-working", since: "2026-10-23T10:00:01.000Z" },
    }
    const update = vi.fn(async () => current)
    setTourApi(api(current, { update, progress: vi.fn(async () => current) }))
    render(() => <TourOverlay {...timing} showAnchorWaitMs={40} waitOnMs={{ agent: 400 }} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    // Many reading times later, still on the answer while the agent writes it.
    await new Promise((r) => setTimeout(r, 300))
    expect(update).not.toHaveBeenCalledWith("kernel.auto", { advance: true, fromBeatId: "answer" })
    current = { ...progress("answer", 7), beatStatus: { kind: "pending" } }
    applyProgress("kernel.auto", current)
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("kernel.auto", { advance: true, fromBeatId: "answer" }),
    )
  })

  it("Try again on a show beat waiting on the agent waits for the answer once more", async () => {
    fixtures.tours = [{ ...tour, demoOnly: true }]
    const update = vi.fn(async () => progress("answer", 7))
    setTourApi(api(progress("answer", 7), { update }))
    render(() => <TourOverlay {...timing} waitOnMs={{ agent: 150 }} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    await screen.findByTestId("tour-agent-waiting", {}, { timeout: 3000 })
    fireEvent.click(screen.getByTestId("tour-do-for-me"))
    expect(await screen.findByTestId("tour-working")).toBeTruthy()
    await screen.findByTestId("tour-agent-waiting", {}, { timeout: 3000 })
    expect(update).not.toHaveBeenCalled()
  })

  // Walk D46: an approve step looked for its card once, 5 s, and stopped
  // ("could not find") while the agent was still writing the message with it.
  it("an approve step waiting on the agent waits for its card to come, then presses it", async () => {
    setTourApi(
      api({
        ...progress("approve-late", 8),
        beatStates: { write: { state: "done", entityId: "req-1" } },
      }),
    )
    render(() => <TourOverlay {...timing} waitOnMs={{ agent: 3000 }} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    // Well past the step's ordinary find timeout (80 ms here), the card lands.
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
    const approve = document.createElement("button")
    approve.dataset.testid = "fixture-approve"
    approve.dataset.entityId = "req-1"
    approve.getClientRects = () => [{}] as unknown as DOMRectList
    const pressed = vi.fn()
    approve.addEventListener("click", pressed)
    document.body.append(approve)
    await waitFor(() => expect(pressed).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
  })

  it("Play whole scenario: a played approve step presses again when a corrected request comes back", async () => {
    setTourApi(api(progress("approve-again", 10)))
    render(() => <TourOverlay {...timing} waitOnMs={{ routine: 60_000 }} />)
    await tourStore.load()
    const pressed = vi.fn()
    const request = () => {
      const approve = document.createElement("button")
      approve.dataset.testid = "fixture-approve-again"
      approve.getClientRects = () => [{}] as unknown as DOMRectList
      approve.addEventListener("click", () => {
        pressed()
        approve.remove()
      })
      document.body.append(approve)
    }
    request()
    await pressTourMenuItem("tour-play-all")
    await waitFor(() => expect(pressed).toHaveBeenCalledTimes(1), { timeout: 3000 })
    // A step of it failed; the routine proposes the corrected request.
    await new Promise((r) => setTimeout(r, 300))
    request()
    await waitFor(() => expect(pressed).toHaveBeenCalledTimes(2), { timeout: 3000 })
  })

  it("an approve step whose card never comes says it waits, with Try again and Skip, never could not find", async () => {
    setTourApi(
      api({
        ...progress("approve-late", 8),
        beatStates: { write: { state: "done", entityId: "req-1" } },
      }),
    )
    render(() => <TourOverlay {...timing} waitOnMs={{ agent: 200 }} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await screen.findByTestId("tour-agent-waiting", {}, { timeout: 3000 })
    expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
    expect(screen.getByTestId("tour-do-for-me").textContent).toContain("Try again")
    expect(await tourMenuItem("tour-skip-beat")).toBeTruthy()
  })

  // Walk D50: on Home after the Tickets tour, Mail's ask stopped at once: its
  // anchor (the dock) was on screen, so it never went to the mail list its
  // script starts from.
  it("Do it for me goes to the beat's page when what its script starts from is not on screen", async () => {
    nav.spaNavigate.mockClear()
    setTourApi(api(progress("from-list", 8)))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(nav.spaNavigate).toHaveBeenCalledWith("/list"))
  })

  it("a do beat already on the screen its script starts from stays there", async () => {
    nav.spaNavigate.mockClear()
    const open = document.createElement("div")
    open.dataset.testid = "fixture-open"
    open.getClientRects = () => [{}] as unknown as DOMRectList
    document.body.append(open)
    setTourApi(api(progress("from-list", 8)))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await new Promise((r) => setTimeout(r, 100))
    expect(nav.spaNavigate).not.toHaveBeenCalled()
  })

  // Sales: the reply to open in Home comes once the routine resumed and
  // drafted it, well past the find timeout; play-all waits for its row (as
  // long as a routine's work takes), opens it, and moves on once it is open.
  it("Play whole scenario: a show beat's reach waits for the routine's row, opens it, then moves on", async () => {
    fixtures.tours = [{ ...tour, demoOnly: true }]
    const update = vi.fn(async () => progress("open-late", 9))
    setTourApi(api(progress("open-late", 9), { update }))
    render(() => <TourOverlay {...timing} showAnchorWaitMs={40} waitOnMs={{ routine: 3000 }} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    // Well past the step's ordinary find timeout (80 ms here), the row lands.
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
    const row = document.createElement("button")
    row.dataset.testid = "fixture-row"
    row.getClientRects = () => [{}] as unknown as DOMRectList
    row.addEventListener("click", () => {
      const card = document.createElement("div")
      card.dataset.testid = "fixture-card"
      card.getClientRects = () => [{}] as unknown as DOMRectList
      document.body.append(card)
    })
    document.body.append(row)
    await waitFor(
      () =>
        expect(update).toHaveBeenCalledWith("kernel.auto", {
          advance: true,
          fromBeatId: "open-late",
        }),
      { timeout: 3000 },
    )
    expect(screen.queryByTestId("tour-autoplay-failed")).toBeNull()
  })

  it("a do beat has no Next: it moves on only on its event, or a deliberate Skip", async () => {
    setTourApi(api(progress("write", 1)))
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    await screen.findByTestId("tour-do-for-me")
    expect(screen.queryByTestId("tour-next")).toBeNull()
  })
})

describe("a scenario that talks to the agent in the person's agent conversation", () => {
  const convTour = defineTour({
    id: "kernel.conv",
    app: "kernel",
    title: "tours.kernel.sample.title",
    summary: "tours.kernel.sample.summary",
    talksToAgent: true,
    beats: [
      {
        id: "ask",
        kind: "do",
        title: "tours.kernel.sample.postMessage.title",
        body: "tours.kernel.sample.postMessage.body",
        anchor: "fixture-composer",
        route: "/threads/{conversation}",
        event: {
          app: "kernel",
          entity: "message",
          action: "create",
          match: { threadId: "{conversation}" },
        },
        autoplay: [
          {
            type: {
              testid: "fixture-composer",
              text: "tours.kernel.sample.postMessage.text",
              created: { beat: "conversation", attr: "data-thread-id" },
            },
          },
          { waitEvent: true },
        ],
      },
    ],
  })

  /** A composer on screen for `threadId` (another conversation's, or the run's). */
  function composer(threadId: string): HTMLTextAreaElement {
    const el = document.createElement("textarea")
    el.dataset.testid = "fixture-composer"
    el.dataset.threadId = threadId
    el.getClientRects = () => [{}] as unknown as DOMRectList
    document.body.append(el)
    return el
  }

  it("goes to the run's conversation and types there, never into another conversation on screen", async () => {
    fixtures.tours = [convTour]
    nav.spaNavigate.mockClear()
    // The shared DM (or the last scenario's conversation) is open on screen.
    const other = composer("dm-1")
    const run = composer("conv-2")
    const current: TourProgress = {
      tourId: "kernel.conv",
      status: "active",
      beatId: "ask",
      beatIndex: 0,
      beatCount: 1,
      beatStates: { conversation: { state: "done", entityId: "conv-2" } },
      source: "demo",
      startedAt: "2026-10-23T10:00:00.000Z",
      updatedAt: "2026-10-23T10:00:00.000Z",
    }
    setTourApi({
      list: vi.fn(async () => [
        {
          tourId: "kernel.conv",
          app: "kernel",
          title: "",
          summary: "",
          beatCount: 1,
          progress: current,
        },
      ]),
      start: vi.fn(async () => current),
      update: vi.fn(async () => current),
      progress: vi.fn(async () => current),
    })
    render(() => <TourOverlay {...timing} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(run.value).toBe("Hello from the tour"), { timeout: 5000 })
    expect(other.value).toBe("")
    // A composer is on screen, but not the run's conversation: it goes there.
    expect(nav.spaNavigate).toHaveBeenCalledWith("/threads/conv-2")
  })
})

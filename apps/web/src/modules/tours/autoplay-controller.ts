// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Drives autoplay for the beat on screen: "Do it for me" plays one do beat,
 * "Play whole scenario" plays every remaining beat (show beats go to their
 * screen, wait for what they point at and move on SHOW_BEAT_MS after it is
 * there; do beats play their script and wait for their event; world beats
 * wait for their live event). Any real input from the person stops it and
 * hands over. Nothing waits in silence: a show beat whose element never
 * appears stops with the refusal line, and a do beat whose event has not come
 * EVENT_WAIT_MS after its script played says so, with Try again and Skip.
 * A beat that waits on work (`beatWaitsOn`: the agent's answer, a routine's
 * run, a replay) waits as long as that work takes (WAIT_ON_MS), saying so,
 * and only then offers Try again and Skip; a show beat goes on watching for
 * its element meanwhile, and moves on when it comes.
 */
import {
  beatArrived,
  beatWaitsOn,
  createdEntityIds,
  type EffectiveBeat,
  RUN_CONVERSATION,
  refTestId,
  resolveBeatRoute,
  routeEntityRefs,
  type TourWait,
} from "@liaison/shared"
import { type Accessor, createEffect, on, onCleanup } from "solid-js"
import { spaNavigate } from "~/framework/spa-navigate"
import { dockAvailable, openConversation } from "~/modules/shell/dock-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { type AutoplayCursor, runAutoplay, watchTakeover } from "./autoplay"
import { tourStore } from "./tour-store"
import { resolveVisibleAnchor } from "./visible-anchor"

export const SHOW_BEAT_MS = 3000
/** How often play-all looks again whether the agent a beat waits on is done. */
const WORK_POLL_MS = 500
/**
 * How long play-all waits for a show beat's element. A demo scenario plays in
 * a seeded world, where every element it points at comes (an agent's answer
 * takes a while): one that never does stops the play. An app tour plays in
 * whatever org it is in, where an element may simply be absent (no
 * collections yet, no session open): it waits briefly, then moves on.
 */
export const SHOW_ANCHOR_WAIT_MS = 60_000
export const TOUR_ANCHOR_WAIT_MS = 5_000
/** How long a played do beat waits for its event before saying it is still waiting. */
export const EVENT_WAIT_MS = 90_000
/**
 * How long a beat that waits on work waits before it offers Try again and
 * Skip, from what the live walks measured: a research turn with a web search
 * answered about 100 s after it was asked; a routine runs its own turn after
 * the event that fired it; a replay plays at most 90 s (REPLAY_MAX_MS).
 */
export const WAIT_ON_MS: Record<TourWait, number> = {
  agent: 120_000,
  routine: 300_000,
  replay: 120_000,
}
const ANCHOR_POLL_MS = 200

export interface AutoplayControllerOptions {
  cursor: AutoplayCursor
  setCursorVisible: (on: boolean) => void
  /** The beat on the panel (undefined when no panel). */
  beat: Accessor<EffectiveBeat | undefined>
  typeDelayMs?: number
  findTimeoutMs?: number
  stepPauseMs?: number
  showBeatMs?: number
  showAnchorWaitMs?: number
  /** The wait for an app tour's (not a demo scenario's) show beat element. */
  tourAnchorWaitMs?: number
  eventWaitMs?: number
  /** Overrides of WAIT_ON_MS (tests). */
  waitOnMs?: Partial<Record<TourWait, number>>
  isUserInput?: (e: Event) => boolean
  /** Resolves what a typing step types (a tours.* key) in the person's language. */
  translate?: (key: string) => string
  /** The person's agent is running the turn the beat waits on (the server's `agent-working`). */
  working?: Accessor<boolean>
}

/** The script has something to press or type (not only "wait for the event"). */
function actsOnScreen(beat: EffectiveBeat): boolean {
  return (beat.autoplay ?? []).some((step) => !("waitEvent" in step))
}

/**
 * What "Try again" replays for a beat still waiting: its own script when it
 * does something on screen, else the request of the beat it waits on (the
 * message `causedBy` names: sending it again starts a new agent turn). Null
 * when there is nothing to replay (a routine's work): only Skip is offered.
 */
export function retryBeatFor(
  beat: EffectiveBeat,
  find: (beatId: string) => EffectiveBeat | undefined = (id) =>
    tourStore.beatOfCurrentTour(id, shellTier() === "phone"),
): EffectiveBeat | null {
  // A show beat waiting on work: Try again waits for its element once more.
  if (beat.kind === "show") return beat.anchor && beatWaitsOn(beat) ? beat : null
  if (beat.kind !== "do") return null
  if (actsOnScreen(beat)) return beat
  const askId = beat.event?.causedBy
  if (!askId) return null
  const ask = find(askId)
  return ask && ask.kind === "do" && actsOnScreen(ask) ? ask : null
}

/**
 * Open a conversation with the person's agent where they are: in the dock
 * beside the screen on a desktop (the agent is told about that screen), on
 * its own screen where there is no dock.
 */
function openAgentConversation(threadId: string): void {
  if (dockAvailable()) openConversation(threadId)
  else spaNavigate(`/threads/${encodeURIComponent(threadId)}`)
}

/** What this run's earlier beats recorded, by beat id. */
function created(): Record<string, string> {
  return createdEntityIds(tourStore.current?.beatStates ?? {})
}

/**
 * Where "Take me there" goes for this beat: its route, with each `{beat-id}`
 * replaced by what that beat recorded. Null without a route, or when the
 * entity it names was never recorded (never somewhere else instead).
 */
export function beatRoute(beat: EffectiveBeat): string | null {
  return resolveBeatRoute(beat.route, created())
}

/**
 * Autoplay plays on the beat's own page: when its anchor is not on screen and
 * the beat names a route, go there first (what "Take me there" does by hand).
 * A beat in the person's agent conversation goes there whenever it is not the
 * page open: some composer is on almost every screen (a channel, a task's
 * discussion), so an anchor on screen does not say this is the place.
 */
function goToBeat(beat: EffectiveBeat): void {
  const route = beatRoute(beat)
  if (!route) return
  const anchorMissing = beat.anchor !== undefined && !resolveVisibleAnchor(beat.anchor)
  const inRunConversation = routeEntityRefs(beat.route).includes(RUN_CONVERSATION)
  if (
    anchorMissing ||
    scriptStartMissing(beat) ||
    (inRunConversation && window.location.pathname !== route)
  ) {
    spaNavigate(route)
  }
}

/**
 * The element a do beat's script starts from is not on screen (nor the one
 * that makes its first click unneeded): the beat's anchor may be on every
 * screen (the chat dock), while the script starts from its own page's list
 * (walk D50: Mail's ask, played on Home after another tour, stopped at once).
 */
function scriptStartMissing(beat: EffectiveBeat): boolean {
  const first = beat.autoplay?.[0]
  if (!first) return false
  const refs =
    "click" in first
      ? [first.click, ...(first.unlessVisible ? [first.unlessVisible] : [])]
      : "waitFor" in first
        ? [first.waitFor]
        : []
  // A pinned ref names what the run recorded; the visible-anchor read below is unpinned on purpose:
  // any such element on screen says this is the screen the script starts from.
  return refs.length > 0 && refs.every((ref) => !resolveVisibleAnchor(refTestId(ref)))
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Wait until `testid` is on screen; false when it never came or the wait was cancelled. Infinity waits for as long as the signal lives. */
async function waitForAnchor(testid: string, timeoutMs: number, signal: AbortSignal) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal.aborted) return false
    if (resolveVisibleAnchor(testid)) return true
    if (Date.now() >= deadline) return false
    if (!(await sleep(ANCHOR_POLL_MS, signal))) return false
  }
}

export function createAutoplayController(opts: AutoplayControllerOptions) {
  let run: AbortController | null = null
  let runBeatId: string | null = null
  /** The do beat whose script this controller last started. */
  let playedBeatId: string | null = null
  let showTimer: ReturnType<typeof setTimeout> | null = null
  let stopWatching: (() => void) | null = null
  let eventTimer: ReturnType<typeof setTimeout> | null = null
  /** Play-all watching a played do beat's element come back (`watchForReturn`). */
  let returnWatch: AbortController | null = null
  /**
   * The do beat whose script is playing, until it finished, failed or the
   * person took over. A read of the tour can leave the beat for an instant and
   * come back (the routine's draft and note landing out of order), which
   * aborts the script and clears the beat's state: the press still stands,
   * and the script plays on when its beat is back (walk D46).
   */
  let requested: { tourId: string; beatId: string } | null = null

  const clearShowTimer = () => {
    if (showTimer) clearTimeout(showTimer)
    showTimer = null
  }

  const stopReturnWatch = () => {
    returnWatch?.abort()
    returnWatch = null
  }

  const clearEventTimer = () => {
    stopReturnWatch()
    if (eventTimer) clearTimeout(eventTimer)
    eventTimer = null
  }

  /** How long a beat waits on its work before it offers Try again and Skip. */
  const waitOnMs = (wait: TourWait) => opts.waitOnMs?.[wait] ?? WAIT_ON_MS[wait]

  /** A played do beat waits on its event: past its wait, it says so (Try again, Skip). */
  const armEventTimer = (beat: EffectiveBeat) => {
    const wait = beatWaitsOn(beat)
    clearEventTimer()
    eventTimer = setTimeout(
      () => {
        eventTimer = null
        if (opts.beat()?.id !== beat.id || tourStore.current?.beatId !== beat.id) return
        if (tourStore.autoplay.beatId === beat.id && tourStore.autoplay.status !== "idle") return
        tourStore.setAutoplay("agentWaiting", beat.id)
      },
      wait ? waitOnMs(wait) : (opts.eventWaitMs ?? EVENT_WAIT_MS),
    )
  }

  const runOptions = (signal: AbortSignal, findTimeoutMs = opts.findTimeoutMs) => ({
    cursor: opts.cursor,
    signal,
    typeDelayMs: opts.typeDelayMs,
    findTimeoutMs,
    stepPauseMs: opts.stepPauseMs,
    // What the tour's earlier beats created: a pinned step works on that, never on other content.
    created: created(),
    text: opts.translate,
    openConversation: openAgentConversation,
  })

  const stopRun = () => {
    run?.abort()
    run = null
    runBeatId = null
    opts.setCursorVisible(false)
  }

  const unwatch = () => {
    stopWatching?.()
    stopWatching = null
  }

  /** The person took over: stop everything, say so on the current beat. */
  const takeover = () => {
    const beat = opts.beat()
    requested = null
    clearShowTimer()
    clearEventTimer()
    stopRun()
    unwatch()
    tourStore.setPlayAll(false)
    if (beat) tourStore.setAutoplay("takeover", beat.id)
  }

  const watch = () => {
    if (!stopWatching) stopWatching = watchTakeover(takeover, opts.isUserInput)
  }

  /**
   * Play a do beat's script, then wait for its event. `script`: the beat whose
   * script plays instead (Try again re-sends the request this beat waits on).
   */
  async function playBeat(beat: EffectiveBeat, script: EffectiveBeat = beat): Promise<void> {
    if (beat.kind !== "do" || !script.autoplay) return
    stopRun()
    clearEventTimer()
    const controller = new AbortController()
    run = controller
    runBeatId = beat.id
    playedBeatId = beat.id
    const tourId = tourStore.current?.tourId
    requested = tourId ? { tourId, beatId: beat.id } : null
    watch()
    tourStore.setAutoplay("playing", beat.id)
    goToBeat(script)
    // A beat that declares what it waits on (an approve step whose card the
    // agent or the routine is still writing) looks for its elements that
    // long, not the few seconds an element already on its way takes (D46).
    const declared = script.waitsOn
    const result = await runAutoplay(
      script.autoplay,
      runOptions(controller.signal, declared ? waitOnMs(declared) : opts.findTimeoutMs),
    )
    if (run !== controller) return
    run = null
    runBeatId = null
    if (requested?.beatId === beat.id) requested = null
    opts.setCursorVisible(false)
    if (!tourStore.playAll) unwatch()
    if (result.status === "failed" && declared) {
      // The work it waits on has not come yet: Try again and Skip, as for any
      // wait, and a whole-scenario play goes on from there.
      tourStore.setAutoplay("agentWaiting", beat.id)
    } else if (result.status === "failed") {
      unwatch()
      tourStore.setPlayAll(false)
      tourStore.setAutoplay("failed", beat.id, result.missing)
    } else if (result.status === "refused") {
      unwatch()
      tourStore.setPlayAll(false)
      tourStore.setAutoplay("refused", beat.id, result.target)
    } else if (result.status === "done") {
      // Played; the beat now waits for its product event like a hand-made one,
      // and its Do it for me is spent: a second press would send it twice.
      tourStore.setAutoplay("idle", beat.id)
      tourStore.doItMyself()
      tourStore.spend(beat.id)
      armEventTimer(beat)
      if (tourStore.playAll && declared && beat.anchor) void watchForReturn(beat, beat.anchor)
    }
  }

  /**
   * Play-all, a played beat that waits on work: its element went away (the
   * request it approved) and comes back while the beat still waits for its
   * event. That is new work to act on (the routine proposed a corrected
   * request after a failed step), so the script plays again on it.
   */
  async function watchForReturn(beat: EffectiveBeat, anchor: string): Promise<void> {
    stopReturnWatch()
    const controller = new AbortController()
    returnWatch = controller
    const { signal } = controller
    while (resolveVisibleAnchor(anchor)) {
      if (!(await sleep(ANCHOR_POLL_MS, signal))) return
    }
    if (!(await waitForAnchor(anchor, Number.POSITIVE_INFINITY, signal))) return
    if (returnWatch !== controller) return
    returnWatch = null
    if (!tourStore.playAll || tourStore.current?.beatId !== beat.id) return
    if (opts.beat()?.id !== beat.id) return
    await playBeat(beat)
  }

  /**
   * "Try again" on a beat still waiting: replay what starts the work again
   * (`retryBeatFor`), then wait on this beat's event once more. A beat that
   * waits on the agent re-sends the request it waits on, so a new turn starts.
   */
  async function retryBeat(beat: EffectiveBeat): Promise<void> {
    const replay = retryBeatFor(beat)
    if (!replay) return
    if (beat.kind === "show") {
      // Wait once more, playing on from there (the effect sees it is working).
      tourStore.setAutoplay("working", beat.id)
      tourStore.setPlayAll(true)
      watch()
      await presentShowBeat(beat)
      return
    }
    await playBeat(beat, replay)
  }

  /**
   * Bring a show beat's element on screen: its route, then its reach steps.
   * "Take me there" by hand plays this too. The result of the reach steps,
   * or done when there were none.
   */
  async function reachBeat(beat: EffectiveBeat, signal: AbortSignal) {
    goToBeat(beat)
    if (!beat.reach || !beat.anchor) return { status: "done" } as const
    if (!(await waitForAnchor(beat.anchor, opts.findTimeoutMs ?? 1500, signal))) {
      if (signal.aborted) return { status: "aborted" } as const
      // A beat pointing at work still under way (a routine's request it opens)
      // looks for what its steps press that long, as a do beat does (D46).
      const declared = beat.waitsOn
      return runAutoplay(
        beat.reach,
        runOptions(signal, declared ? waitOnMs(declared) : opts.findTimeoutMs),
      )
    }
    return { status: "done" } as const
  }

  /** "Take me there": the beat's route, then the steps that open what it points at. */
  async function takeMeThere(beat: EffectiveBeat): Promise<void> {
    if (!beat.reach) {
      goToBeat(beat)
      return
    }
    stopRun()
    const controller = new AbortController()
    run = controller
    runBeatId = beat.id
    const result = await reachBeat(beat, controller.signal)
    if (run !== controller) return
    run = null
    runBeatId = null
    opts.setCursorVisible(false)
    if (result.status === "failed") tourStore.setAutoplay("failed", beat.id, result.missing)
    else if (result.status === "refused") tourStore.setAutoplay("refused", beat.id, result.target)
  }

  /** Play-all on a show beat: go there, wait for its element, then move on. */
  async function presentShowBeat(beat: EffectiveBeat): Promise<void> {
    stopRun()
    const controller = new AbortController()
    run = controller
    runBeatId = beat.id
    const stopHere = (status: "failed" | "refused", missing: string) => {
      run = null
      runBeatId = null
      opts.setCursorVisible(false)
      unwatch()
      tourStore.setPlayAll(false)
      tourStore.setAutoplay(status, beat.id, missing)
    }
    if (beat.anchor) {
      const reached = await reachBeat(beat, controller.signal)
      if (run !== controller) return
      if (reached.status === "failed") return stopHere("failed", reached.missing)
      if (reached.status === "refused") return stopHere("refused", reached.target)
      const anchor = beat.anchor
      const scenario = tourStore.currentTour()?.demoOnly === true
      const wait = beatWaitsOn(beat)
      if (wait) {
        // Work the beat waits on (the agent's answer): as long as it takes,
        // saying so; past that, Try again and Skip, still watching for it.
        if (!resolveVisibleAnchor(anchor)) tourStore.setAutoplay("working", beat.id)
        let found = await waitForAnchor(anchor, waitOnMs(wait), controller.signal)
        if (run !== controller) return
        if (!found) {
          tourStore.setAutoplay("agentWaiting", beat.id)
          found = await waitForAnchor(anchor, Number.POSITIVE_INFINITY, controller.signal)
          if (run !== controller || !found) return
        }
        if (tourStore.autoplay.beatId === beat.id) tourStore.setAutoplay("idle", beat.id)
      } else {
        const found = await waitForAnchor(
          anchor,
          scenario
            ? (opts.showAnchorWaitMs ?? SHOW_ANCHOR_WAIT_MS)
            : (opts.tourAnchorWaitMs ?? TOUR_ANCHOR_WAIT_MS),
          controller.signal,
        )
        if (run !== controller) return
        // A scenario never moves on past what the beat points at without showing it.
        if (!found && scenario) return stopHere("failed", anchor)
      }
    }
    run = null
    runBeatId = null
    opts.setCursorVisible(false)
    readThenNext(beat)
  }

  /**
   * Play-all's Next on a beat, after its reading time. On a beat that waits on
   * the person's agent, not while that agent is still answering: a person's
   * Next is held the same way, and the answer gets its reading time once done.
   */
  function readThenNext(beat: EffectiveBeat): void {
    const readMs = opts.showBeatMs ?? SHOW_BEAT_MS
    let sawWork = false
    const tick = () => {
      showTimer = null
      if (!tourStore.playAll || opts.beat()?.id !== beat.id) return
      if (beat.waitsOn === "agent" && opts.working?.() === true) {
        sawWork = true
        showTimer = setTimeout(tick, WORK_POLL_MS)
        return
      }
      if (sawWork) {
        sawWork = false
        showTimer = setTimeout(tick, readMs)
        return
      }
      void tourStore.next()
    }
    showTimer = setTimeout(tick, readMs)
  }

  /** "Play whole scenario": react to every beat change while it is on. */
  createEffect(
    on(
      () => {
        const beat = opts.beat()
        const arrived = beat ? beatArrived(beat, tourStore.current?.beatStates ?? {}) : false
        return [tourStore.playAll, beat?.id, arrived] as const
      },
      ([playAll, , arrived], prev) => {
        clearShowTimer()
        const beat = opts.beat()
        if (prev?.[1] !== beat?.id) clearEventTimer()
        // A beat that changed or a panel that closed stops what was playing.
        if (run && runBeatId !== beat?.id) stopRun()
        // The press is spent once its beat is decided (done or skipped) or the tour changed.
        const current = tourStore.current
        if (
          requested &&
          (current?.tourId !== requested.tourId ||
            current.beatStates[requested.beatId] !== undefined)
        ) {
          requested = null
        }
        // Back on the beat the person asked to be done, its script cut short: play on.
        if (
          !playAll &&
          beat &&
          beat.kind === "do" &&
          requested?.beatId === beat.id &&
          !run &&
          tourStore.autoplay.status === "idle" &&
          tourStore.selfDoingBeatId !== beat.id
        ) {
          void playBeat(beat)
          return
        }
        // What the step announced arrived: it is read, then Next (play-all
        // presses it after the reading time a show beat gets).
        if (beat && arrived) {
          clearEventTimer()
          if (run && runBeatId === beat.id) stopRun()
          if (!playAll) {
            unwatch()
            return
          }
          watch()
          // Done before play-all got to it (the agent answered Lucas while
          // his question showed): its page is still opened, to be read.
          const route = beat.kind === "do" && playedBeatId !== beat.id ? beatRoute(beat) : null
          if (route && window.location.pathname !== route) spaNavigate(route)
          readThenNext(beat)
          return
        }
        if (!playAll || !beat) {
          if (!playAll && !run) unwatch()
          return
        }
        watch()
        if (beat.kind === "do") {
          if (tourStore.autoplay.beatId === beat.id && tourStore.autoplay.status !== "idle") return
          if (tourStore.selfDoingBeatId === beat.id) return
          void playBeat(beat)
        } else if (beat.kind === "world") {
          // A world beat waits for its live event (the server records it on
          // the beat): play-all waits for that frame, it never times out.
          goToBeat(beat)
        } else {
          if (tourStore.autoplay.beatId === beat.id && tourStore.autoplay.status !== "idle") return
          void presentShowBeat(beat)
        }
      },
    ),
  )

  const stop = () => {
    requested = null
    clearShowTimer()
    clearEventTimer()
    stopRun()
    unwatch()
    tourStore.setPlayAll(false)
  }

  onCleanup(() => {
    clearShowTimer()
    clearEventTimer()
    stopRun()
    unwatch()
  })

  return { playBeat, retryBeat, takeMeThere, stop }
}

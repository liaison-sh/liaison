// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The tour engine's shell mount: binds the API, loads the tour in progress,
 * listens for `kernel:tour` pushes and renders the one thing on screen (the
 * panel with its spotlight, the resume chip, or the completion card).
 */
import {
  beatOutcome,
  beatUsesDock,
  createdEntityIds,
  type EffectiveBeat,
  heldRequestCard,
  RUN_CONVERSATION,
  resolveBeatRoute,
  TOUR_PATH_MAX,
  TOUR_WS_ENTITY,
  waitsOnAgentTurn,
} from "@liaison/shared"
import { useLocation, useNavigate } from "@solidjs/router"
import {
  type Component,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { registerWsEntityHandler } from "~/framework/app-registry"
import { demoWorkspaceEnded } from "~/lib/demo-expired"
import { decideApproval, getApproval } from "~/modules/approvals/approvals-service"
import { decisionToastItems } from "~/modules/approvals/decision-queue"
import { sessionOrgId } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { putAwayWindows } from "~/modules/shell/dock-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { getChannelAgentStream } from "~/modules/threads/message-store"
import { askAgain, watchServerAgentFailure } from "./agent-failed-status"
import { LIVE_TURN_ANCHOR, threadOfMessage, watchAgentTurn } from "./agent-turn-watch"
import {
  ANCHOR_POLL_MS,
  type AnchorBox,
  createAnchorTracker,
  createElementTracker,
} from "./anchor-tracker"
import {
  ASK_TURN_START_MS,
  askRingElement,
  CONVERSATION_ANCHOR,
  conversationOf,
  isAskBeat,
  threadOf,
  turnRunsIn,
} from "./ask-turn"
import {
  type AutoplayControllerOptions,
  createAutoplayController,
  retryBeatFor,
} from "./autoplay-controller"
import { putAwayDialogLeftBehind } from "./dialog-put-away"
import { createGhostCursor, GhostCursor } from "./GhostCursor"
import { Spotlight, TourScrim } from "./Spotlight"
import { TourChip, TourCompleted, TourPanel } from "./TourPanel"
import { createTourApi } from "./tour-api"
import { resolveTour } from "./tour-catalog"
import { setTourApi, tourStore } from "./tour-store"
import { resolveVisibleAnchor } from "./visible-anchor"
import {
  advancePath,
  onBeatRoute,
  PATH_START,
  type PathState,
  pathProgress,
  RAIL_MORE_ANCHOR,
  railWayAnchor,
} from "./wayfinding"

/** The toast an approval waits in while Undo is offered (a single one, or a group). */
export const UNDO_TOAST_ANCHOR = "decision-toast*"

/**
 * Registered once per module load (there is no per-handler unregister, and the
 * handler only forwards to the store). Any frame means "refetch progress".
 */
let subscribed = false
export function subscribeToTourFrames(): void {
  if (subscribed) return
  subscribed = true
  registerWsEntityHandler(
    `kernel:${TOUR_WS_ENTITY}`,
    "kernel",
    (_action, data, context) => tourStore.onFrame(data, context.currentUserId),
    { owner: "tours" },
  )
}

/** Timing overrides for tests; the defaults are the human-speed ones. */
export type TourOverlayProps = Pick<
  AutoplayControllerOptions,
  | "typeDelayMs"
  | "findTimeoutMs"
  | "stepPauseMs"
  | "showBeatMs"
  | "showAnchorWaitMs"
  | "tourAnchorWaitMs"
  | "eventWaitMs"
  | "waitOnMs"
  | "isUserInput"
> & {
  /** How long a sent request waits for its agent's turn to start before its ring lets go. */
  askTurnStartMs?: number
  /** How long a turn that ended waits for the step's event before saying it answered without it. */
  answerGraceMs?: number
}

/** A request the person sent their agent, whose answer is still on its way. */
interface Asked {
  beatId: string
  /** The ask step's composer anchor: the conversation is found from it. */
  composer: string
  since: number
  /** Its turn was seen running (it ends when it no longer does). */
  started: boolean
}

/** Renders the store's tour view. Mounted by TourHost; tests render it directly. */
export const TourOverlay: Component<TourOverlayProps> = (props) => {
  const i18n = useI18n()
  const phone = () => shellTier() === "phone"
  const beat = createMemo(() =>
    tourStore.view() === "panel" ? tourStore.currentBeat(phone()) : undefined,
  )
  /** The server's word on the step (`TourProgress.beatStatus`): what the card shows. */
  const beatStatus = () => {
    const b = beat()
    const progress = tourStore.current
    return b && progress?.beatId === b.id ? progress.beatStatus : undefined
  }
  /**
   * The request this do beat waits on was sent and the person's agent is
   * working on it (walk D71), as the server says (`agent-working`): nothing to
   * press, and the step points at the agent's live turn instead of the
   * composer the request went through. A turn that fails ends it (Try again),
   * as does a beat already offering it.
   */
  const working = createMemo(() => {
    const b = beat()
    if (!b) return false
    const status = tourStore.autoplay.beatId === b.id ? tourStore.autoplay.status : "idle"
    if (status !== "idle" && status !== "working") return false
    return beatStatus()?.kind === "agent-working"
  })
  /** The approval the agent's turn parked, while the step waits on it (`held-for-approval`). */
  const held = createMemo(() => {
    const s = beatStatus()
    return s?.kind === "held-for-approval" ? s : null
  })
  const client = useOptionalApi()
  /**
   * The parked requests Do it for me already approved. One that comes back to
   * pending (its run failed and was put back for a person to look at) is never
   * approved again from here: approving it again only reruns what failed, once
   * per press. Its card says why it failed; the person decides it there.
   */
  const [approvedHeld, setApprovedHeld] = createSignal<ReadonlySet<string>>(new Set())
  /** Approve the very request the agent's turn parked: the step's Do it for me. */
  const approveHeld = async (requestId: string) => {
    if (approvedHeld().has(requestId)) return
    setApprovedHeld((prev) => new Set(prev).add(requestId))
    // The request's own card on screen: press its Approve, exactly as the
    // person would (it sends the fingerprint of what they see, opens the undo
    // window and names the approval in the toast).
    // A dispatch shows as its own card in a conversation, as the approval card elsewhere.
    const own = [heldRequestCard(held()?.toolName).approve, heldRequestCard().approve]
      .map((testid) =>
        resolveVisibleAnchor(testid, document, { attr: "data-entity-id", value: requestId }),
      )
      .find((el) => el !== null)
    if (own) {
      own.click()
      return
    }
    if (!client) return
    // Off screen: approve what the request says now, by its fingerprint. A
    // bare approve is refused (payload_hash_required).
    try {
      const request = await getApproval(client, requestId)
      await decideApproval(client, requestId, {
        decision: "approve",
        ...(request.payloadHash ? { payloadHash: request.payloadHash } : {}),
      })
    } catch {
      // The card itself says why a decision failed.
    }
  }
  /** A Do it for me press waiting on the server's word about a running turn. */
  let pressPending = false
  const doItForMe = async (b: EffectiveBeat) => {
    // A press on a step already played or already passed does nothing.
    if (tourStore.spentBeatId === b.id || tourStore.passedBeatId === b.id) return
    const progress = tourStore.current
    if (progress && waitsOnAgentTurn(b)) {
      if (pressPending) return
      pressPending = true
      try {
        // The request may already be out (sent before a reload): the server
        // says whether its turn runs, and a press then would send it twice.
        await tourStore.refresh(progress.tourId)
      } finally {
        pressPending = false
      }
      if (untrack(beatStatus)?.kind === "agent-working" || untrack(beat)?.id !== b.id) return
      if (tourStore.spentBeatId === b.id || tourStore.passedBeatId === b.id) return
    }
    void autoplay.playBeat(b)
  }
  /**
   * The person approved and the approval waits out its undo window: the step
   * says so and rings the toast that offers Undo for as long as it is there
   * (the approve event comes once it went through, and the step moves on).
   */
  const undoing = createMemo(() => {
    const b = beat()
    if (!b?.undo) return false
    return decisionToastItems().some(
      (item) => item.kind === "approval" && item.decision === "approve",
    )
  })
  /** The parked request's card, ringed while the step waits on it. */
  const heldAnchor = () => {
    const h = held()
    return h ? `${heldRequestCard(h.toolName).card}[data-request-id=${h.requestId}]` : undefined
  }
  /**
   * The conversation the step's agent answers in: the one holding the request
   * its event is caused by (a task's discussion), else the run's conversation
   * with the person's agent; null when neither is known.
   */
  const replyThread = (): string | null => {
    const b = beat()
    const created = createdEntityIds(tourStore.current?.beatStates ?? {})
    const askId = b?.event?.causedBy ? created[b.event.causedBy] : undefined
    return (askId ? threadOfMessage(askId) : null) ?? created[RUN_CONVERSATION] ?? null
  }
  /** The composer of the conversation the step's agent answers in. */
  const replyComposer = (): string | undefined => {
    const thread = replyThread()
    return thread ? `compose-field[data-thread-id=${thread}]` : undefined
  }
  /**
   * The agent answered without doing the step (it asked first, "shall I?"):
   * the step says to reply to it, so the conversation's composer is ringed,
   * not the asked turn's first tool row scrolled out of sight above.
   */
  const answeredAnchor = (): string | undefined => {
    const b = beat()
    const status = tourStore.autoplay
    if (!b || status.beatId !== b.id || status.status !== "agentAnswered") return undefined
    return replyComposer()
  }
  /** What the step rings: its own element, unless something above takes its place. */
  const target = () =>
    undoing()
      ? UNDO_TOAST_ANCHOR
      : (heldAnchor() ?? (working() ? LIVE_TURN_ANCHOR : (answeredAnchor() ?? beat()?.anchor)))
  const ringsOwnAnchor = () => !undoing() && !heldAnchor() && !working() && !answeredAnchor()
  const anchor = createAnchorTracker(
    target,
    // A group (the subtasks just made) is ringed whole, not its first row.
    () => ringsOwnAnchor() && beat()?.anchorAll === true,
    // A step the agent does, pinned to the asked turn's rows: the agent's
    // latest row in that conversation, a reply's turn ("go ahead") included.
    () => {
      const b = beat()
      return ringsOwnAnchor() && b !== undefined && waitsOnAgentTurn(b)
    },
  )
  /** The anchor while it is in sight: under a later layer it is neither ringed nor avoided. */
  const spot = () => {
    const box = anchor()
    return box && !box.covered ? box : null
  }
  // The request a step asked the person's agent went out: until the turn
  // answering it ends, the conversation it went into stays ringed, whatever
  // step is on screen meanwhile (the end card, a step about the answer).
  const [asked, setAsked] = createSignal<Asked | null>(null)
  const ask = (b: EffectiveBeat) => {
    if (untrack(asked)?.beatId === b.id || !b.anchor) return
    setAsked({ beatId: b.id, composer: b.anchor, since: Date.now(), started: false })
  }
  createEffect(
    on(beat, (b, prev) => {
      if (!b) {
        if (tourStore.view() !== "panel") setAsked(null)
        return
      }
      if (prev && prev.id !== b.id && isAskBeat(prev)) {
        const state = tourStore.current?.beatStates[prev.id]
        if (state !== undefined && beatOutcome(state) === "done") ask(prev)
        else setAsked(null)
      }
      // A new request to send: the last one's ring gives way to its composer.
      if (isAskBeat(b) && untrack(asked)?.beatId !== b.id) setAsked(null)
    }),
  )
  // The server says the ask step is done while its next step is still read.
  createEffect(() => {
    const b = beat()
    if (b && isAskBeat(b) && tourStore.passedBeatId === b.id) ask(b)
  })
  /** The conversation the request went into, last seen on screen. */
  let askedIn: HTMLElement | null = null
  const askConversation = (): HTMLElement | null => {
    const a = untrack(asked)
    if (!a) return null
    const composer = resolveVisibleAnchor(a.composer)
    const found = composer ? conversationOf(composer) : null
    if (found) askedIn = found
    else if (askedIn && !askedIn.isConnected) askedIn = null
    return found ?? askedIn
  }
  /** The thread the request went into, once its composer said. */
  let askedThread: string | null = null
  const askThread = (): string | null => {
    const a = untrack(asked)
    const composer = a ? resolveVisibleAnchor(a.composer) : null
    const thread = composer ? threadOf(composer) : null
    if (thread) askedThread = thread
    return askedThread
  }
  createEffect(
    on(
      () => asked() !== null,
      (active) => {
        if (!active) {
          askedIn = null
          askedThread = null
          return
        }
        const tick = () => {
          const a = untrack(asked)
          if (!a) return
          const conversation = askConversation()
          const thread = askThread()
          // Its window closed, with no thread to ask: whether the turn runs is
          // told once it is back (only the wait for a start runs out).
          const known = thread !== null || conversation !== null
          const running = thread
            ? getChannelAgentStream(thread).state === "streaming"
            : conversation !== null && turnRunsIn(null, conversation)
          if (known && running && !a.started) setAsked({ ...a, started: true })
          else if (known && !running && a.started) setAsked(null)
          else if (!a.started && Date.now() - a.since > (props.askTurnStartMs ?? ASK_TURN_START_MS))
            setAsked(null)
        }
        tick()
        const timer = setInterval(tick, ANCHOR_POLL_MS)
        onCleanup(() => clearInterval(timer))
      },
    ),
  )
  // A turn whose stream this client hears is seen starting at once, however
  // short it runs between two looks at the screen.
  createEffect(() => {
    const a = asked()
    if (!a || a.started) return
    const thread = askThread()
    if (thread && getChannelAgentStream(thread).state === "streaming") {
      setAsked({ ...a, started: true })
    }
  })
  const findAskRing = () => {
    const conversation = askConversation()
    return conversation ? askRingElement(conversation) : null
  }
  const askTracker = createElementTracker(() => (asked() ? findAskRing : undefined))
  /**
   * The ask's conversation, ringed: unless the step's own element is on
   * screen in that very conversation (the answer's first tool, its card).
   */
  const askRing = (): { box: AnchorBox; testid: string } | null => {
    if (undoing()) return null
    const box = askTracker()
    if (!box || box.covered || !box.el.isConnected) return null
    const own = spot()
    const list = box.el.closest<HTMLElement>(`[data-testid="${CONVERSATION_ANCHOR}"]`) ?? box.el
    if (own && list.contains(own.el)) return null
    return { box, testid: box.el.dataset.testid ?? CONVERSATION_ANCHOR }
  }
  // While the agent works on what the step waits on and its live turn is out
  // of sight, the conversation on screen is ringed rather than nothing.
  // That is the conversation the agent answers in: never the first list in
  // the page, which is the channel behind the dock (a teammate's thread rang
  // between an approval and the agent's resumed turn).
  const findWorkingConversation = (): HTMLElement | null => {
    const composer = replyComposer()
    if (!composer) return resolveVisibleAnchor(CONVERSATION_ANCHOR)
    const el = resolveVisibleAnchor(composer)
    return el ? conversationOf(el) : null
  }
  const workingConversation = createElementTracker(() =>
    working() && !undoing() && anchor() === null ? findWorkingConversation : undefined,
  )
  /** The beat's route, with what earlier beats recorded filled in; null when there is none yet. */
  const route = () => {
    const b = beat()
    return b
      ? resolveBeatRoute(b.route, createdEntityIds(tourStore.current?.beatStates ?? {}))
      : null
  }
  // The way there while the beat's element is not on screen: each hop of its
  // `path` in turn (the app on the rail, the project's row, the agent in the
  // chats list), else the rail entry of the app the beat is in while the
  // person is in another one (desktop only: a phone has no rail), or the
  // rail's "+N" when that entry is folded away. The person learns the way,
  // not only "Take me there".
  const lost = () => anchor() === null && !working() && askRing() === null
  const path = () => beat()?.path ?? []
  const hops = Array.from({ length: TOUR_PATH_MAX }, (_, i) =>
    createAnchorTracker(() =>
      working() || undoing() || asked() !== null ? undefined : path()[i]?.anchor,
    ),
  )
  const railAnchor = () => (lost() && !phone() ? railWayAnchor(route()) : null)
  const rail = createAnchorTracker(() => railAnchor() ?? undefined)
  const railMore = createAnchorTracker(() =>
    railAnchor() && rail() === null ? RAIL_MORE_ANCHOR : undefined,
  )
  // A box whose element just left the page is not there any more, whatever
  // the tracker's next poll will say.
  const lit = (box: AnchorBox | null) => box !== null && !box.covered && box.el.isConnected
  const railWay = (): { box: AnchorBox; testid: string } | null => {
    const r = rail()
    const anchor = railAnchor()
    if (r && lit(r) && anchor) return { box: r, testid: anchor }
    const more = railMore()
    if (more && lit(more)) return { box: more, testid: RAIL_MORE_ANCHOR }
    return null
  }
  const onScreen = (i: number) => {
    const hop = path()[i]
    if (!hop) return false
    if (hop.rail) return railWay() !== null
    return lit(hops[i]?.() ?? null)
  }
  // How far along the way the person got on this beat (never back): re-read
  // on every move of the screen the trackers see.
  const [pathState, setPathState] = createSignal<PathState>(PATH_START)
  /** The beat on screen by id: a fresh read of the same beat is not another beat. */
  const beatId = createMemo(() => beat()?.id)
  createEffect(on(beatId, () => setPathState(PATH_START)))
  createEffect(() => {
    const p = path()
    if (p.length === 0) return
    const target = anchor() !== null
    const inApp = railAnchor() === null
    const prev = untrack(pathState)
    const arrived = { onRoute: onBeatRoute(route()), targetAnchor: beat()?.anchor }
    setPathState(advancePath(p, prev, onScreen, target, inApp, arrived))
  })
  const wayProgress = () => pathProgress(path(), pathState())
  /** The hop to take now, when it is on screen and is not the element itself (the agent to pick). */
  const hopRing = (): { box: AnchorBox; testid: string } | null => {
    const current = wayProgress().current
    const hop = current === null ? undefined : path()[current]
    if (!hop?.anchor) return null
    const box = hops[current ?? 0]?.() ?? null
    return box && lit(box) ? { box, testid: hop.anchor } : null
  }
  /** A hop beyond the element is to be taken now: it is ringed instead of the element. */
  const hopAhead = () => {
    const ring = hopRing()
    return ring !== null && ring.testid !== beat()?.anchor
  }
  const way = (): { box: AnchorBox; testid: string } | null => hopRing() ?? railWay()
  /** What is ringed other than the step's own element: the ask's conversation, the working one, the way. */
  const otherRing = (): { box: AnchorBox; testid: string } | null => {
    const ring = askRing()
    if (ring) return ring
    const conversation = workingConversation()
    if (working() && conversation && lit(conversation)) {
      return { box: conversation, testid: CONVERSATION_ANCHOR }
    }
    return way()
  }
  /** The step's own element, ringed when nothing above takes its place. */
  const ownSpot = () => (hopAhead() || askRing() ? null : spot())
  // The way is listed while the element is away, and stays listed (ticked
  // off) once the person came by it; a step whose element is on screen on
  // arrival lists none.
  const cameByWay = () => pathState().seen.size > 0
  const wayList = () => {
    const p = path()
    const b = beat()
    // A way that goes on past the element itself (type @ in the comment box,
    // then pick the agent) is listed even with that element on screen.
    const goesPast = b?.anchor !== undefined && p.some((hop) => hop.anchor === b.anchor)
    if (p.length === 0 || !(lost() || cameByWay() || goesPast)) return null
    return { labels: p.map((hop) => hop.label), ...wayProgress() }
  }
  const ghost = createGhostCursor()
  const autoplay = createAutoplayController({
    cursor: ghost.cursor,
    setCursorVisible: ghost.setVisible,
    beat,
    typeDelayMs: props.typeDelayMs,
    findTimeoutMs: props.findTimeoutMs,
    stepPauseMs: props.stepPauseMs,
    showBeatMs: props.showBeatMs,
    showAnchorWaitMs: props.showAnchorWaitMs,
    tourAnchorWaitMs: props.tourAnchorWaitMs,
    eventWaitMs: props.eventWaitMs,
    waitOnMs: props.waitOnMs,
    isUserInput: props.isUserInput,
    translate: i18n.t,
    working,
  })
  // A scenario beat that goes to ANOTHER screen starts with the chat windows
  // put away, however the scenario was reached (started, resumed, a deep
  // link, a reload restoring an open window): a window left open covers what
  // the beat points at. A beat in the dock beside the same screen (its way
  // opens Chats in the dock) keeps them: the person just asked their agent
  // there and watches it work (closing it made them reopen it). Back from the
  // dock to the screen itself (the agent's reply in a task's discussion, the
  // subtasks in the list), the windows are put away again: an open window
  // covered what that beat points at. A beat without a route plays where the
  // last one left off (an answer in the open DM). So does an app tour that
  // talks to the agent (walk D50): a window the last run left open covered
  // the list the next tour starts from.
  // A computation, not an effect: it runs before every effect of the same
  // update, so a script that opens a window on arriving at the beat (the run's
  // conversation) opens it AFTER this put-away, never before it.
  let lastScreen: string | undefined
  let lastInDock = false
  createComputed(
    on(
      () => beat()?.id,
      () => {
        const b = beat()
        const tour = tourStore.currentTour()
        const screen = b?.route
        const inDock = b ? beatUsesDock(b) : false
        const leaves = screen !== undefined && (screen !== lastScreen || (lastInDock && !inDock))
        if (leaves && (tour?.demoOnly || tour?.talksToAgent)) putAwayWindows()
        if (screen) {
          lastScreen = screen
          lastInDock = inDock
        }
      },
    ),
  )
  // A beat that pointed into a dialog (a document's Share dialog) closes it
  // when the person moves on, as the chat windows are put away above: left
  // open, it covered what the next step points at.
  createEffect(
    on(beat, (b, prev) => {
      if (prev && prev.id !== b?.id) putAwayDialogLeftBehind(prev.anchor, b?.anchor)
    }),
  )
  // An agent turn the beat waits on failed: say so, stop playing the scenario.
  // Where it failed goes with it: a refusal line there may name a gate.
  // A turn that ended without doing the step says that instead (Try again
  // re-sends the request), until a turn runs on the step again.
  watchAgentTurn(
    beat,
    (beatId, turn) => {
      autoplay.stop()
      // A demo workspace that ended is not a failed step: the tab is leaving it.
      if (demoWorkspaceEnded()) return
      tourStore.setAutoplay("agentFailed", beatId, null, turn)
    },
    {
      onAnswered: (beatId) => {
        // Play all keeps going: should the step's event still come (late, or
        // after an approval), its arrival moves the scenario on as usual.
        if (!tourStore.playAll) autoplay.stop()
        if (demoWorkspaceEnded()) return
        tourStore.setAutoplay("agentAnswered", beatId)
      },
      onRunning: (beatId) => tourStore.setAutoplay("idle", beatId),
      graceMs: props.answerGraceMs,
    },
  )
  // The server says the turn answering the step's question ended without an
  // answer (refused, failed), whoever started it: the person's own message
  // included, which the turn watch above never sees fail when its refusal
  // landed before the step came on screen.
  watchServerAgentFailure(beat, beatStatus, (beatId, turn) => {
    autoplay.stop()
    if (demoWorkspaceEnded()) return
    tourStore.setAutoplay("agentFailed", beatId, null, turn)
  })
  /**
   * Try again: a show step whose question got no answer sends that question
   * again in the same conversation (the step then waits on its turn); any
   * other step replays what it waits on.
   */
  const tryAgain = (b: EffectiveBeat) => {
    const status = tourStore.autoplay
    const failed = status.beatId === b.id && status.status === "agentFailed" ? status.turn : null
    if (b.kind === "show" && failed?.question && client) {
      void askAgain(client, b.id, failed)
      return
    }
    void autoplay.retryBeat(b)
  }
  const panel = createMemo(() => {
    const tour = tourStore.currentTour()
    const progress = tourStore.current
    const b = beat()
    return tour && progress && b ? { tour, progress, beat: b } : null
  })
  const chip = createMemo(() => {
    const tour = tourStore.currentTour()
    const progress = tourStore.current
    return tourStore.view() === "chip" && tour && progress ? { tour, progress } : null
  })
  const completed = createMemo(() => {
    const tour = tourStore.currentTour()
    const progress = tourStore.completed
    return tourStore.view() === "completed" && tour && progress ? { tour, progress } : null
  })

  return (
    <>
      <GhostCursor pos={ghost.pos()} visible={ghost.visible()} />
      <Switch>
        <Match when={panel()}>
          {(p) => (
            <>
              {/* Nothing to ring (no element, or not on screen yet): the page dims behind the card. */}
              {/* While the agent works, the page is what the person watches: never dimmed. */}
              <Show when={anchor() === null && !working() && otherRing() === null}>
                <TourScrim />
              </Show>
              <Show
                when={ownSpot()}
                fallback={
                  <Show when={otherRing()}>
                    {(w) => <Spotlight box={w().box} testid={w().testid} />}
                  </Show>
                }
              >
                {(box) => <Spotlight box={box()} testid={target() ?? ""} />}
              </Show>
              <TourPanel
                tour={p().tour}
                progress={p().progress}
                beat={p().beat}
                anchorVisible={!p().beat.anchor || anchor() !== null}
                working={working()}
                undoing={undoing()}
                spot={ownSpot() ?? otherRing()?.box ?? null}
                atRoute={onBeatRoute(route())}
                way={wayList()}
                wayAtHand={hopRing() !== null}
                onApproveHeld={approveHeld}
                heldApproved={(requestId) => approvedHeld().has(requestId)}
                phone={phone()}
                onDoItForMe={() => void doItForMe(p().beat)}
                onTryAgain={retryBeatFor(p().beat) ? () => tryAgain(p().beat) : undefined}
                onTakeMeThere={() => void autoplay.takeMeThere(p().beat)}
                onPlayAll={() => tourStore.setPlayAll(true)}
                onStopPlaying={() => autoplay.stop()}
              />
            </>
          )}
        </Match>
        <Match when={chip()}>
          {(c) => <TourChip tour={c().tour} progress={c().progress} phone={phone()} />}
        </Match>
        <Match when={completed()}>
          {(c) => (
            <>
              <TourScrim />
              <TourCompleted tour={c().tour} progress={c().progress} phone={phone()} />
            </>
          )}
        </Match>
      </Switch>
    </>
  )
}

/** The deep-link parameter the CLI prints (`/?tour=<id>`) and the demo uses. */
export const TOUR_QUERY_PARAM = "tour"

export const TourHost: Component = () => {
  const client = useOptionalApi()
  const location = useLocation()
  const navigate = useNavigate()
  subscribeToTourFrames()
  onMount(() => {
    if (!client) return
    setTourApi(createTourApi(client))
    // The step's status is the server's: a tab coming back reads it again
    // (frames sent while it slept, or while the socket was away, may be lost).
    const reread = () => {
      const current = tourStore.current
      if (current && document.visibilityState === "visible") void tourStore.refresh(current.tourId)
    }
    document.addEventListener("visibilitychange", reread)
    window.addEventListener("focus", reread)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", reread)
      window.removeEventListener("focus", reread)
    })
    // Read once on boot, then strip it so a reload never restarts the tour.
    const params = new URLSearchParams(location.search)
    const deepLink = params.get(TOUR_QUERY_PARAM)
    if (deepLink !== null) {
      params.delete(TOUR_QUERY_PARAM)
      const query = params.toString()
      navigate(`${location.pathname}${query ? `?${query}` : ""}${location.hash}`, {
        replace: true,
      })
    }
    // The linked tour is about to start: nothing else opens over it meanwhile.
    if (deepLink) tourStore.expectStart(deepLink)
    void (async () => {
      try {
        await tourStore.load()
        // Only a tour this org offers the caller (a demo scenario is not one
        // outside a demo org): a deep link to anything else opens nothing.
        if (
          deepLink &&
          resolveTour(deepLink) &&
          tourStore.items.some((item) => item.tourId === deepLink)
        ) {
          await tourStore.resume(deepLink, "cli")
        }
      } finally {
        if (deepLink && tourStore.starting === deepLink) tourStore.expectStart(null)
      }
    })()
  })
  // Another org is another session (auth-store `setTokens`): the store was
  // reset with it, so the new org's tours are wired and read as on a load.
  const org = createMemo(sessionOrgId)
  createEffect(
    on(
      org,
      () => {
        if (!client) return
        setTourApi(createTourApi(client))
        void tourStore.load()
      },
      { defer: true },
    ),
  )
  onCleanup(() => setTourApi(null))
  return <TourOverlay />
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A beat that waits on the person's agent (`beatWaitsOn` is `agent`: a do beat
 * the agent completes, a show beat pointing at its answer) waits on that
 * agent's turn. When the turn fails (no usable model, a provider error, a
 * refusal before it ran) the answer never comes: this watch notices the
 * failure in the person's agent conversation (their DM, which the run
 * records when the tour talks to the agent) so the panel can say so instead
 * of waiting in silence. It says where the turn failed, so the panel
 * can show the gate a refusal line there names (the demo's "confirm your
 * email": the code prompt, not "could not find").
 * A failure that happens while the beat is on screen counts. In the run's
 * conversation one already there when the beat comes on screen counts too (a
 * refusal lands before the panel reaches the beat that waits on the answer),
 * unless it was there when this page started the run: the DM holds earlier
 * turns, and a failure left over from those is the baseline.
 * A do beat's request may go elsewhere (a task's own discussion): the
 * conversation holding the request its event is caused by is watched too.
 * A turn there that ENDS without an error while the beat is on screen, with
 * the beat's event still missing a moment later, answered without doing the
 * step: the watch says so too, so the panel stops saying the agent works.
 * Whether the agent is working at all is not this watch's to say: the server
 * says it in the step's status (`TourProgress.beatStatus`, `agent-working`).
 */
import {
  beatWaitsOn,
  createdEntityIds,
  type EffectiveBeat,
  RUN_CONVERSATION,
  waitsOnAgentTurn,
} from "@liaison/shared"
import { type Accessor, createEffect, on, onCleanup, untrack } from "solid-js"
import {
  type AgentStreamState,
  getChannelAgentStream,
  messageStore,
} from "~/modules/threads/message-store"
import { knownPersonalAgentDmId } from "~/modules/threads/personal-dm-store"
import { tourStore } from "./tour-store"

interface Seen {
  beatId: string
  /** The conversation the run recorded, when the tour talks to the agent. */
  runThreadId: string | null
  /** The conversations watched, joined (a change of them resets the baseline). */
  threads: string
  /** Each watched conversation's current turn error, by thread id. */
  errors: Record<string, unknown>
}

/** The loaded conversation that holds `messageId`, if any. */
export function threadOfMessage(messageId: string): string | null {
  for (const [threadId, thread] of Object.entries(messageStore.threads)) {
    if (thread.byId[messageId]) return threadId
  }
  return null
}

/**
 * The conversations the beat's agent answers in: the person's DM (the run's
 * conversation), and the one holding the request the beat's event is caused by (the
 * message an earlier beat recorded: a task's discussion, a channel).
 */
function watchedThreads(beat?: EffectiveBeat): string[] {
  const out: string[] = []
  const dm = knownPersonalAgentDmId()
  if (dm) out.push(dm)
  const created = createdEntityIds(tourStore.current?.beatStates ?? {})
  const run = created[RUN_CONVERSATION]
  if (run && !out.includes(run)) out.push(run)
  const askId = beat?.event?.causedBy
  const askMessage = askId ? created[askId] : undefined
  const asked = askMessage ? threadOfMessage(askMessage) : null
  if (asked && !out.includes(asked)) out.push(asked)
  return out
}

/**
 * How long a turn that ended waits for the beat's event before the step says
 * the agent answered without doing it: the event reaches the tour a moment
 * after the turn's last frame (through the outbox, then the tour's consumer:
 * on a busy box five seconds and more). The server's word is read again at
 * the end of it before saying so.
 */
export const AGENT_ANSWER_GRACE_MS = 8_000

interface Answered {
  /** The turn ended without the step done (the beat's event never came). */
  onAnswered: (beatId: string) => void
  /** A turn runs again on the beat (the person replied, Try again). */
  onRunning: (beatId: string) => void
  graceMs?: number
}

export function watchAgentTurn(
  beat: Accessor<EffectiveBeat | undefined>,
  /** `turn`: where it failed and its error, so the panel can read the refusal line said there. */
  onFailed: (beatId: string, turn: { threadId: string; message: string } | null) => void,
  answered?: Answered,
): void {
  /**
   * The failure the run's conversation showed as this page started (or
   * resumed) the run: its earlier turns'. A run this page found already going
   * (a reload) has none, so a failure of its own turns still counts.
   */
  let runBaseline: { run: string; error: unknown } | null = null
  const noteRunBaseline = () => {
    const progress = tourStore.current
    const thread = createdEntityIds(progress?.beatStates ?? {})[RUN_CONVERSATION]
    if (!progress || !thread) return
    const run = `${progress.tourId}:${progress.startedAt}:${thread}`
    if (runBaseline?.run === run) return
    const startedHere = tourStore.starting === progress.tourId
    const stream = startedHere ? untrack(() => getChannelAgentStream(thread)) : null
    runBaseline = { run, error: stream?.state === "error" ? stream.error : null }
  }
  createEffect(
    on(
      (): Seen | null => {
        noteRunBaseline()
        const b = beat()
        if (!b || beatWaitsOn(b) !== "agent") return null
        // Approving what the agent proposed waits on its card, not on its turn:
        // the approval exists, so a turn that failed after proposing it leaves
        // nothing missing to wait for.
        if (b.event?.entity === "approval_request" && b.event.action === "update") return null
        const threads = watchedThreads(b)
        const errors: Record<string, unknown> = {}
        for (const id of threads) {
          const stream = getChannelAgentStream(id)
          errors[id] = stream?.state === "error" ? stream.error : null
        }
        const run = createdEntityIds(tourStore.current?.beatStates ?? {})[RUN_CONVERSATION]
        return {
          beatId: b.id,
          runThreadId: run ?? null,
          threads: threads.join(","),
          errors,
        }
      },
      (seen, prev) => {
        if (!seen) return
        const fresh = !prev || prev.beatId !== seen.beatId || prev.threads !== seen.threads
        for (const [threadId, error] of Object.entries(seen.errors)) {
          if (!error) continue
          // A new beat: only the run's conversation counts what is already there,
          // and only a failure of this run's turns, not one left from before it.
          if (
            fresh
              ? threadId !== seen.runThreadId || error === runBaseline?.error
              : error === prev?.errors[threadId]
          )
            continue
          const message = (error as { message?: unknown }).message
          onFailed(seen.beatId, typeof message === "string" ? { threadId, message } : null)
          return
        }
      },
    ),
  )
  if (answered) watchAgentAnswer(beat, answered)
}

/**
 * A do beat waiting on the agent's turn, whose turn ended (no error) while the
 * beat was on screen: if the beat's event has not come a moment later, the
 * agent answered without doing the step. Only a turn seen running while the
 * beat is on screen counts; one that ended before it came is the baseline.
 */
function watchAgentAnswer(beat: Accessor<EffectiveBeat | undefined>, answered: Answered): void {
  /** The watched conversations whose turn was seen running on this beat. */
  let ran = new Set<string>()
  let beatId: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  onCleanup(clear)
  /** Still nothing for the step: is that the agent's answer without it? */
  const stillMissing = (id: string): boolean => {
    const b = untrack(beat)
    if (!b || b.id !== id || tourStore.current?.beatId !== id) return false
    if (tourStore.current.beatStates[id] !== undefined) return false
    if (tourStore.passedBeatId === id) return false
    // The person said they do it by hand: a turn of theirs is not the step's.
    if (tourStore.selfDoingBeatId === id && tourStore.spentBeatId !== id) return false
    const status = tourStore.autoplay
    if (status.beatId === id && status.status === "agentFailed") return false
    // The turn parked a call for approval (the step goes on once it is
    // decided), or another turn runs on it: not an answer without the step.
    const kind = tourStore.current.beatStatus?.kind
    return kind !== "held-for-approval" && kind !== "agent-working"
  }
  const settleAnswered = async (id: string) => {
    if (!stillMissing(id)) return
    // The server's word, read again: a frame for the step may still be on its way.
    const tourId = tourStore.current?.tourId
    if (tourId) await tourStore.refresh(tourId)
    if (timer || !stillMissing(id)) return
    answered.onAnswered(id)
  }
  createEffect(
    on(
      () => {
        const b = beat()
        if (!b || !waitsOnAgentTurn(b)) return null
        const states: Record<string, AgentStreamState["state"]> = {}
        for (const id of watchedThreads(b)) states[id] = getChannelAgentStream(id).state
        return { beatId: b.id, states }
      },
      (seen) => {
        if (!seen) {
          clear()
          ran = new Set()
          beatId = null
          return
        }
        if (seen.beatId !== beatId) {
          clear()
          ran = new Set()
          beatId = seen.beatId
        }
        const running = Object.entries(seen.states).filter(([, state]) => state === "streaming")
        if (running.length > 0) {
          clear()
          for (const [id] of running) ran.add(id)
          const status = untrack(() => tourStore.autoplay)
          if (status.beatId === seen.beatId && status.status === "agentAnswered") {
            answered.onRunning(seen.beatId)
          }
          return
        }
        // A seen turn ended; a failed one is the failure watch's to say.
        const ended = [...ran].some((id) => id in seen.states && seen.states[id] !== "error")
        if (!ended || timer) return
        const id = seen.beatId
        timer = setTimeout(() => {
          timer = null
          ran = new Set()
          void settleAnswered(id)
        }, answered.graceMs ?? AGENT_ANSWER_GRACE_MS)
      },
    ),
  )
}

/** The live turn of the person's agent in a conversation (`MessageList`'s block per running turn). */
export const LIVE_TURN_ANCHOR = "agent-stream-block"

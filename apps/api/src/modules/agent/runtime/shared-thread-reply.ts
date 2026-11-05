// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHAT A SHARED THREAD RECEIVES: THE ANSWER, NOT THE WORK.
 *
 * A turn's text is every text delta of every step joined together. Between two
 * tools a model often narrates ("I'll read the task first", "Retrying with the
 * parent id"), and in a private agent chat that is deliberate: the reply is
 * drawn with each line where it was written, between the tools it introduces
 * (MessageRow's inline timeline text), for the one person who asked. In a
 * conversation other people read, the same narration is working notes posted
 * in front of them. There the turn persists only its final step: the text
 * written after the last tool call, and the timeline keeps no earlier text
 * either, since its entries ride on the stored row and the live copy.
 *
 * The live stream follows the same rule (`createLiveTextGate`): the room's
 * sockets are never handed a step's text until that text is known to be the
 * answer, so a note is not shown and then taken back.
 */
import type { TurnTimelineEntry } from "~/modules/agent/runtime/agent-service"

/** The text after the timeline's last tool entry (reasoning ignored). */
export function textAfterLastTool(timeline: TurnTimelineEntry[]): string {
  let lastTool = -1
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].kind === "tool") lastTool = i
  }
  return timeline
    .slice(lastTool + 1)
    .flatMap((entry) => (entry.kind === "text" ? [entry.text] : []))
    .join("")
}

/** The timeline without any text written before its last tool entry. */
export function withoutInterimText(timeline: TurnTimelineEntry[]): TurnTimelineEntry[] {
  let lastTool = -1
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].kind === "tool") lastTool = i
  }
  return timeline.filter((entry, i) => entry.kind !== "text" || i > lastTool)
}

/**
 * The reply a turn persists. Private: everything the model wrote, as before.
 * Shared: the final step only. `finalStepText` is the caller's own measure when
 * it kept no timeline; otherwise the timeline decides. A caller with neither
 * (a test driving finalize by hand) keeps its text unchanged.
 */
export function replyForAudience(params: {
  shared: boolean
  text: string
  finalStepText?: string
  timeline?: TurnTimelineEntry[]
}): { text: string; timeline?: TurnTimelineEntry[] } {
  const { shared, text, finalStepText, timeline } = params
  if (!shared) return { text, timeline }
  if (finalStepText !== undefined) {
    return { text: finalStepText, timeline: timeline ? withoutInterimText(timeline) : undefined }
  }
  if (timeline && timeline.length > 0) {
    return { text: textAfterLastTool(timeline), timeline: withoutInterimText(timeline) }
  }
  return { text, timeline }
}

/**
 * The text half of a turn's live `agent_stream` frames. Private: every delta
 * goes out as it arrives, as before. Shared: text is held until it is known to
 * be the answer, then sent at once. A text part is followed by its step's tool
 * calls only at the end of the part, so text cannot be judged while it is
 * written: it is held, dropped when a tool call follows (working notes), and
 * sent once a step ends without one, or the turn ends. Text written after a
 * step's last tool call is held across into the next step, exactly as
 * `textAfterLastTool` keeps it in the stored reply. Tool rows, reasoning and
 * the turn's other frames are not gated: the room still sees the turn work.
 */
export function createLiveTextGate(shared: boolean, emit: (delta: string) => void) {
  let held = ""
  let stepCalledTool = false
  const flush = () => {
    if (!held) return
    const delta = held
    held = ""
    emit(delta)
  }
  return {
    /** A text delta from the model. */
    text(delta: string): void {
      if (!shared) emit(delta)
      else held += delta
    },
    /** The step calls a tool: the text held so far was working notes. */
    toolCall(): void {
      stepCalledTool = true
      held = ""
    },
    /** A step ended: one that called no tool wrote the answer. */
    stepFinished(): void {
      if (!stepCalledTool) flush()
      stepCalledTool = false
    },
    /** The turn ends (finish, error, abort): what is held is the answer. */
    flush,
  }
}

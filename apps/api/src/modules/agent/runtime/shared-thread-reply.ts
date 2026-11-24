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
 * A tool that closes a reply (its next steps, drawn under it: REPLY_CLOSING_TOOLS)
 * is no work: the words before it are the answer, and only a tool that gathers
 * or acts makes the words before it notes. What a model writes again after
 * closing is kept once.
 *
 * The live stream follows the same rule (`createLiveTextGate`): the room's
 * sockets are never handed a step's text until that text is known to be the
 * answer, so a note is not shown and then taken back.
 */
import { closesReply } from "~/modules/agent/providers/answer-after-tools"
import type { TurnTimelineEntry } from "~/modules/agent/runtime/agent-service"
import { joinStepTexts } from "~/modules/agent/runtime/reply-flatten"

/** What an entry of the turn's order is when it stands before the answer: work, or its close. */
export function toolEntryCloses(toolName: string): { closes?: true } {
  return closesReply(toolName) ? { closes: true } : {}
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** Fewer words than this are compared word for word, not by how many they share. */
const REWORDED_MIN_WORDS = 12
const REWORDED_SHARE = 0.85

/** Whether `whole` says what `part` says: its words in order, or nearly all of a longer text's words. */
function says(whole: string, part: string): boolean {
  const partWords = wordsOf(part)
  const wholeWords = wordsOf(whole)
  if (partWords.length === 0) return whole.includes(part.trim())
  if (` ${wholeWords.join(" ")} `.includes(` ${partWords.join(" ")} `)) return true
  const distinct = new Set(partWords)
  if (distinct.size < REWORDED_MIN_WORDS) return false
  const held = new Set(wholeWords)
  return [...distinct].filter((w) => held.has(w)).length >= distinct.size * REWORDED_SHARE
}

/** The texts to keep of an answer written around its closing calls: each thing is said once, last. */
function saidOnce<T extends { text: string }>(parts: readonly T[]): T[] {
  let kept: T[] = []
  for (const part of parts) {
    if (!/\S/.test(part.text)) continue
    kept = kept.filter((earlier) => !says(part.text, earlier.text))
    if (!kept.some((earlier) => says(earlier.text, part.text))) kept.push(part)
  }
  return kept
}

/** The index of the timeline's last tool entry that is not a close of the reply, or -1. */
function lastWork(timeline: TurnTimelineEntry[]): number {
  return timeline.findLastIndex((entry) => entry.kind === "tool" && !entry.closes)
}

/** The answer in parts, one between two closing calls, with the entries each is made of. */
function answerParts(
  timeline: TurnTimelineEntry[],
): Array<{ text: string; entries: TurnTimelineEntry[] }> {
  const parts = [{ text: "", entries: [] as TurnTimelineEntry[] }]
  for (const entry of timeline.slice(lastWork(timeline) + 1)) {
    const part = parts[parts.length - 1]
    if (entry.kind === "tool") parts.push({ text: "", entries: [] })
    else if (entry.kind === "text" && part) {
      part.text += entry.text
      part.entries.push(entry)
    }
  }
  return saidOnce(parts)
}

/** The text after the timeline's last tool that worked (reasoning and closing calls ignored). */
export function textAfterLastTool(timeline: TurnTimelineEntry[]): string {
  return joinParts(answerParts(timeline).map((part) => part.text))
}

const joinParts = (texts: readonly string[]): string =>
  texts.length === 1 ? (texts[0] ?? "") : joinStepTexts(texts)

/** The timeline without any text that is not its answer's. */
export function withoutInterimText(timeline: TurnTimelineEntry[]): TurnTimelineEntry[] {
  const kept = new Set(answerParts(timeline).flatMap((part) => part.entries))
  return timeline.filter((entry) => entry.kind !== "text" || kept.has(entry))
}

/** The same answer built as the stream arrives, for a caller that keeps no timeline. */
export function createAnswerText() {
  let parts = [{ text: "" }]
  return {
    add(delta: string): void {
      const part = parts[parts.length - 1]
      if (part) part.text += delta
    },
    toolCall(toolName: string): void {
      if (closesReply(toolName)) parts.push({ text: "" })
      else parts = [{ text: "" }]
    },
    reset(): void {
      parts = [{ text: "" }]
    },
    get text(): string {
      return joinParts(saidOnce(parts).map((part) => part.text))
    },
  }
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
 * sent once a step ends without one, or the turn ends. A call that closes the
 * reply drops nothing: the answer is held until the next step shows whether it
 * is worked on, said again, or done. Text written after a
 * step's last tool call is held across into the next step, exactly as
 * `textAfterLastTool` keeps it in the stored reply. Tool rows, reasoning and
 * the turn's other frames are not gated: the room still sees the turn work.
 */
export function createLiveTextGate(shared: boolean, emit: (delta: string) => void) {
  const held = createAnswerText()
  let stepCalledTool = false
  const flush = () => {
    const delta = held.text
    held.reset()
    if (delta) emit(delta)
  }
  return {
    /** A text delta from the model. */
    text(delta: string): void {
      if (!shared) emit(delta)
      else held.add(delta)
    },
    /** The step calls a tool: the text held so far was working notes, unless the tool closes it. */
    toolCall(toolName: string): void {
      stepCalledTool = true
      held.toolCall(toolName)
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

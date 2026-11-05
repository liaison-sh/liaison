// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A step that asks the person's agent something (`say`, done by their own
 * message) completes the moment the request is sent; the agent's answer then
 * streams in that conversation while the next step is on screen. Until that
 * turn ends, the conversation the request went into stays ringed: the agent's
 * live turn while it can be seen, else the conversation's message list. Found
 * from the step's own composer, so it is the docked chat window, the Chats
 * thread or the task discussion the request was typed into, wherever that is.
 */
import type { EffectiveBeat } from "@liaison/shared"
import { getChannelAgentStream } from "~/modules/threads/message-store"
import { LIVE_TURN_ANCHOR } from "./agent-turn-watch"
import { visiblePart } from "./anchor-tracker"
import { resolveVisibleAnchor } from "./visible-anchor"

/** A conversation's message list (`MessageList`): what is ringed while its live turn is out of sight. */
export const CONVERSATION_ANCHOR = "message-scroll-container"

/** How long a sent request waits for its turn to start before the ring lets go. */
export const ASK_TURN_START_MS = 120_000

/** A do beat the person completes by sending their agent a request. */
export function isAskBeat(beat: EffectiveBeat): boolean {
  return (
    beat.kind === "do" &&
    beat.say !== undefined &&
    beat.anchor !== undefined &&
    beat.event?.entity === "message" &&
    beat.event.action === "create"
  )
}

/** The message list of the conversation `composer` writes into: the nearest one up its ancestors. */
export function conversationOf(composer: HTMLElement): HTMLElement | null {
  for (let node = composer.parentElement; node; node = node.parentElement) {
    const list = resolveVisibleAnchor(CONVERSATION_ANCHOR, node)
    if (list) return list
  }
  return null
}

/** The thread a composer writes to, when it says (`data-thread-id`). */
export function threadOf(composer: HTMLElement): string | null {
  const own =
    composer.closest<HTMLElement>("[data-thread-id]") ?? composer.querySelector("[data-thread-id]")
  return own?.getAttribute("data-thread-id") || null
}

/** What to ring in the conversation: its live turn while some of it shows, else the list itself. */
export function askRingElement(conversation: HTMLElement): HTMLElement {
  const live = resolveVisibleAnchor(LIVE_TURN_ANCHOR, conversation)
  return live && visiblePart(live) ? live : conversation
}

/**
 * The agent's turn runs in that conversation: its stream says so when the
 * thread is known, else its live turn is on screen.
 */
export function turnRunsIn(threadId: string | null, conversation: HTMLElement): boolean {
  if (threadId) return getChannelAgentStream(threadId).state === "streaming"
  return resolveVisibleAnchor(LIVE_TURN_ANCHOR, conversation) !== null
}

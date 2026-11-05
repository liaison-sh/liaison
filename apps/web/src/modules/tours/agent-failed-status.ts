// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A step waiting on the agent's answer to a recorded question, whose turn
 * ended without one (refused before it ran, failed, cut off): the server says
 * so in the step's status (`agent-failed`, apps/api tours `beat-status.ts`),
 * whoever started the turn (the tour, or the person's own message). The card
 * then stops saying the agent works: it says the agent could not answer, with
 * the refusal's own words, and Try again sends the same question again in the
 * same conversation (`askAgain`); the step then waits on that message's turn.
 * Once a turn runs again, or a later message's answer took the step over, the
 * failure is no longer said.
 */
import type { EffectiveBeat, TourBeatStatus } from "@liaison/shared"
import { type Accessor, createEffect, on } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import { sendMessage } from "~/modules/threads/message-store"
import { currentViewForTurn } from "~/modules/threads/thread-send"
import { type FailedTurn, tourStore } from "./tour-store"

type AgentFailed = Extract<TourBeatStatus, { kind: "agent-failed" }>

/** What the panel keeps of the server's `agent-failed`. */
export function failedTurnOf(status: AgentFailed): FailedTurn {
  return {
    threadId: status.threadId,
    message: status.message ?? "",
    code: status.code,
    askId: status.askId,
    question: status.question,
  }
}

/**
 * Follow the server's word on the step: a new `agent-failed` (a message that
 * got no answer, said once per message) calls `onFailed`; a status that no
 * longer says it clears a failure this watch set.
 */
export function watchServerAgentFailure(
  beat: Accessor<EffectiveBeat | undefined>,
  status: Accessor<TourBeatStatus | undefined>,
  onFailed: (beatId: string, turn: FailedTurn) => void,
): void {
  /** `beatId:askId` of the failure said last. */
  let said: string | null = null
  createEffect(
    on(
      () => {
        const b = beat()
        return b ? { beatId: b.id, status: status() } : null
      },
      (now) => {
        if (!now) return
        const s = now.status
        if (s?.kind === "agent-failed") {
          const key = `${now.beatId}:${s.askId}`
          if (said === key) return
          said = key
          onFailed(now.beatId, failedTurnOf(s))
          return
        }
        if (said === null) return
        const own = said.startsWith(`${now.beatId}:`)
        said = null
        const current = tourStore.autoplay
        if (
          own &&
          current.beatId === now.beatId &&
          current.status === "agentFailed" &&
          current.turn?.askId !== undefined
        ) {
          tourStore.setAutoplay("idle", now.beatId)
        }
      },
    ),
  )
}

/**
 * Try again on a step whose question got no answer: the same question, sent
 * again in the same conversation as the person (with the screen they are on,
 * as their composer sends it). The step stops saying it failed at once and
 * waits on that message's turn; a send that fails says the failure again.
 */
export async function askAgain(
  api: { post: (path: string, body: unknown) => Promise<unknown> },
  beatId: string,
  turn: FailedTurn,
  fallbackUserId = "",
): Promise<boolean> {
  if (!turn.question) return false
  const token = userFromToken()
  const user = { id: token?.userId ?? fallbackUserId, name: token?.name ?? "" }
  tourStore.setAutoplay("idle", beatId)
  const currentView = currentViewForTurn()
  try {
    await sendMessage(api, turn.threadId, turn.question, user, {
      ...(currentView ? { currentView } : {}),
    })
  } catch {
    tourStore.setAutoplay("agentFailed", beatId, null, turn)
    return false
  }
  const tourId = tourStore.current?.tourId
  if (tourId) await tourStore.refresh(tourId)
  return true
}

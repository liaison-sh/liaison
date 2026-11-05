// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE STEERING ACTIONS (P3-T16, D55). P2's request cards and header render a
// control only once its action is registered in session-actions.ts; this
// module registers them, each sending one owner command through P3's client
// (session-commands.ts):
//
//   stop              -> stop {}
//   decidePermission  -> permission_decision {requestId, allow, scope}
//   answerQuestion    -> answer {requestId, answers}
//   decidePlan        -> permission_decision on the plan_request (approve = allow)
//   fullOutput        -> the cut output, read from the node (full-output.ts, T22)
//
// The cards call these fire-and-forget, so a refused command is told here: a
// toast with what failed, then the error goes back to the caller.

import { ApiError } from "~/lib/api-error"
import { log } from "~/lib/logger"
import { tNow } from "~/modules/i18n/i18n-context"
import { addToast } from "~/modules/shell/toast-store"
import { fullOutput } from "./full-output"
import { registerSessionActions, type SessionActions, sessionActions } from "./session-actions"
import { answer, approvePlan, decide, keepPlanning, stopSession } from "./session-commands"

async function told(sessionId: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send()
  } catch (err) {
    log.warn({ err, sessionId }, "a session command was not sent")
    const error = err instanceof ApiError || err instanceof Error ? err.message : String(err)
    addToast({
      message: tNow("kernel.nodeSessions.steer.composer.sendFailed", { error }),
      type: "error",
    })
    throw err
  }
}

export const steeringActions: Required<
  Pick<SessionActions, "stop" | "decidePermission" | "answerQuestion" | "decidePlan" | "fullOutput">
> = {
  stop: (sessionId) => told(sessionId, () => stopSession(sessionId)),
  decidePermission: (sessionId, requestId, allow, scope) =>
    told(sessionId, () => decide(sessionId, requestId, allow, scope)),
  answerQuestion: (sessionId, requestId, answers) =>
    told(sessionId, () => answer(sessionId, requestId, answers)),
  decidePlan: (sessionId, requestId, approve) =>
    told(sessionId, () =>
      approve ? approvePlan(sessionId, requestId) : keepPlanning(sessionId, requestId),
    ),
  fullOutput: async (sessionId, toolUseId) => {
    let out: string | null = null
    await told(sessionId, async () => {
      out = await fullOutput(sessionId, toolUseId)
    })
    return out
  },
}

/** Registers the steering actions unless they already are. Returns the unregister, or null. */
export function ensureSteeringActions(): (() => void) | null {
  if (sessionActions().decidePermission === steeringActions.decidePermission) return null
  return registerSessionActions(steeringActions)
}

// Imported by the composer, which every session view renders: the actions are
// there as soon as a session is open.
ensureSteeringActions()

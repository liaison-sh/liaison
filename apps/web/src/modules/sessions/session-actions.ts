// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION ACTIONS SEAM (P2-D1). P2's transcript cards, tool rows and header
// are read-only: each renders an action's control only once that action is
// registered here, and calls it. P3 registers the steering actions from its own
// command module (spec-protocol.md, Commands), so P2's files never change for
// them:
//
//   stop              -> `stop {}`
//   decidePermission  -> `permission_decision {requestId, allow, scope}`
//   answerQuestion    -> `answer {requestId, answers}`
//   decidePlan        -> `permission_decision` on a plan_request (allow approves)
//   fullOutput        -> the full-output read (R26), null while unavailable

import { createSignal } from "solid-js"

export interface SessionActions {
  stop?(sessionId: string): Promise<void>
  decidePermission?(
    sessionId: string,
    requestId: string,
    allow: boolean,
    scope: "once" | "session",
  ): Promise<void>
  answerQuestion?(
    sessionId: string,
    requestId: string,
    answers: Record<string, string>,
  ): Promise<void>
  decidePlan?(sessionId: string, requestId: string, approve: boolean): Promise<void>
  fullOutput?(sessionId: string, toolUseId: string): Promise<string | null>
}

const [registrations, setRegistrations] = createSignal<readonly SessionActions[]>([])

/** Add actions (later registrations win per action). Returns the unregister. */
export function registerSessionActions(actions: SessionActions): () => void {
  const entry = { ...actions }
  setRegistrations((list) => [...list, entry])
  return () => setRegistrations((list) => list.filter((e) => e !== entry))
}

/** The registered actions, merged; reactive. */
export function sessionActions(): SessionActions {
  return Object.assign({}, ...registrations()) as SessionActions
}

/** Tests: drop every registration. */
export function resetSessionActions(): void {
  setRegistrations([])
}

// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * Agent-facing language about what a PENDING approval means for the human.
 *
 * Both gated seams (the in-app agent's tool-bridge and the MCP tool-call path)
 * already told the agent "this did not execute, do not claim it did". What
 * neither said is the part the USER needs: the action is inert until a specific
 * human decides it, and WHO that human is.
 *
 * The 2026-09-11 Elevator Sound session is the failure this closes. Three
 * correct requests were staged; the agent reported them as "en attente" and
 * stopped there. Nobody with the approve scope was ever told to act, the queue
 * grew to 14 items (the oldest 4 days old, customer replies among them), and
 * the user read the silence as "Liaison is broken" — re-asking each time, which
 * only stacked duplicates. The staging moment is the one place where the agent
 * can say "this will not happen until X approves it", so it says it there.
 *
 * `requesterCanApprove` is computed once in execute-tool (the decision-audience
 * membership that also drives createApprovalRequest); both seams consume THAT
 * value rather than re-deriving it, so the two messages can never disagree
 * about who is being asked to act.
 */
/**
 * `canListApprovals` says whether THIS turn holds `kernel__approvals_list`. The
 * follow-up advice names the tool only when the agent can call it: an agent
 * told to call a tool it does not have calls it anyway, and the call fails as
 * an unavailable tool instead of answering the user.
 */
export function approvalActionRequiredClause(
  requesterCanApprove: boolean,
  canListApprovals = true,
  deciders: readonly string[] = [],
): string {
  const named = deciders.length > 0 ? deciders.join(", ") : null
  const who = requesterCanApprove
    ? "WHO MUST ACT: the user you are talking to IS an eligible approver. They can decide it themselves on the approval card. Tell them plainly, in your own words and without hedging, that the action runs ONLY once they approve it, and that leaving it in the queue means it never happens at all."
    : named
      ? `WHO MUST ACT: the user you are talking to is NOT an eligible approver for this action, so they CANNOT unblock it themselves. It was sent for a decision to ${named}. Do not tell the user to approve it. Tell them plainly that it waits on ${named}, that nothing happens until a decision is made, and that chasing ${named} is the next step.`
      : "WHO MUST ACT: the user you are talking to is NOT an eligible approver for this action, so they CANNOT unblock it themselves. Do not tell them to approve it. Tell them plainly that it is waiting on whoever holds the approve scope for it, that nothing happens until that person decides, and that chasing that approver is the next step."
  return `${who} NEVER leave the user with only "it is pending" and no idea that a human decision is the thing standing between this request and a real effect. If the user LATER says this never happened, did not arrive, or that "it is not working", do NOT redo the work and do NOT stage it again: ${
    canListApprovals
      ? "call kernel__approvals_list first — the request is almost certainly still sitting there undecided, and saying so IS the answer."
      : "you cannot list the approval queue from here, so say that the request is almost certainly still waiting in the approvals queue undecided; saying so IS the answer."
  }`
}

/**
 * What a gated tool's `gatedAgentNotes` ask the agent to say (D18): every note
 * carrying a `relay` instruction, appended to the pending message, which is the
 * part of the result an agent reliably acts on. Empty when there is none.
 */
export function gatedNotesRelay(notes: Record<string, unknown> | undefined): string {
  if (!notes) return ""
  const relays: string[] = []
  for (const [field, value] of Object.entries(notes)) {
    const relay = (value as { relay?: unknown } | null)?.relay
    if (typeof relay === "string" && relay.length > 0) {
      relays.push(`This result carries \`${field}\`: ${relay}`)
    }
  }
  return relays.length > 0 ? ` ${relays.join(" ")}` : ""
}

/**
 * The one recipe for building a sequenced approval request, appended to a gated result
 * that hands out `outputs` (@ref tokens). Short and numbered on purpose: it is read by
 * small models that follow steps literally.
 */
export function sequencingRecipe(outputs: Record<string, string> | undefined): string {
  if (!outputs || Object.keys(outputs).length === 0) return ""
  const listed = Object.entries(outputs)
    .map(([key, token]) => `${key} = "${token}"`)
    .join(", ")
  return (
    `TO CHAIN A LATER STEP that needs this one's result (its outputs: ${listed}): ` +
    "1. This call is done; do not call this tool again. " +
    "2. Call the next tool NOW, without waiting for the approval, and put the token from `outputs` " +
    "(the whole string, exactly as shown) in the field that needs that value; inside text, write the " +
    "token where the value goes. " +
    "3. That call joins this request and runs after this one once the person approves; its own " +
    "result gives new `outputs` for the step after it. " +
    "4. Repeat until every step is proposed, then tell the user what waits for approval. " +
    "Never pass the bare approvalRequestId, never edit a token, never invent one."
  )
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A person decided an approval from its card. The card dispatches this DOM
 * event (bubbling) from itself as the decision is sent, so the conversation
 * holding the card can react: the agent's follow-up comes next, and a chat
 * that scrolled up to the card goes back to following its newest message.
 */
export const APPROVAL_DECIDED_EVENT = "liaison:approval-decided"

/** Announce a decision made on the card `el` (no-op without one). */
export function announceApprovalDecided(el: HTMLElement | undefined): void {
  el?.dispatchEvent(new CustomEvent(APPROVAL_DECIDED_EVENT, { bubbles: true }))
}

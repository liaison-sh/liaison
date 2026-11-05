// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Ticket-draft CLAIM guard for routine ticks (guard 3 of the BL-275 family).
 *
 * Failure mode observed live (staging, 2026-07-07, gemini-flash tick on
 * ticket-5096): the tick's posted output announced "Gated Reply Drafted ...
 * pending your approval" while the server log shows ZERO tickets:reply calls —
 * the model narrated the deliverable instead of producing it, and the human
 * reading the routine thread would wait forever for an approval that does not
 * exist. Prompt-level rules ("never claim a draft unless you called
 * tickets:reply this tick") lower the frequency but cannot make it zero, so
 * this deterministic backstop verifies the claim against ground truth (an
 * approval_requests row for the tick's ticket, created during the tick) and
 * re-prompts ONCE to actually call tickets:reply.
 *
 * Pure logic lives here (unit-tested); the DB existence check + wiring live in
 * kernel-jobs.ts next to the other completeness guards.
 */

/** Ticket id carried by a tickets event that fired this tick, or null. */
export function extractTicketIdFromTriggerEvent(triggerEvent: unknown): string | null {
  if (!triggerEvent || typeof triggerEvent !== "object") return null
  const ev = triggerEvent as {
    app?: unknown
    entity?: unknown
    entityId?: unknown
    data?: { ticketId?: unknown } | null
  }
  if (ev.app !== "tickets") return null
  const fromData = ev.data && typeof ev.data === "object" ? ev.data.ticketId : undefined
  const id = typeof fromData === "string" && fromData ? fromData : ev.entityId
  return typeof id === "string" && id.length > 0 ? id : null
}

// A tick that legitimately produced no draft usually SAYS so — those phrasings
// must not trip the guard (it would re-prompt a correct stand-down).
const NO_DRAFT_RE =
  /\b(no (customer )?draft|did not draft|no reply (was )?(needed|drafted)|stand(ing)?\s+down|stood down|no action (was )?(needed|taken)|drafting nothing)\b/i

// Positive claim: the output tells the human a gated reply/draft exists or is
// awaiting their decision. Kept deliberately narrow-ish: generic mentions of
// the word "approval" alone (e.g. "this tool requires approval") do not match;
// the observed fabrications all pair draft/reply language with pending/queued/
// prepared language.
const CLAIM_RE =
  /\b(draft(ed)?( and)?( queued| prepared| submitted| created| staged)?\b.{0,80}?(pending|await|approv)|(pending|awaiting)\s+(your\s+)?approval|gated (reply|draft|email)|reply (draft|is) (queued|prepared|staged|pending)|approve (the|this) (pending )?(reply|draft)|once approved.{0,80}(draft|reply|message)|approval\s*#|kernel:approval_request:|pending action:?\s*.{0,40}approval)\b/is

/**
 * True when the tick's posted text claims a customer draft exists. `null`/empty
 * text never claims.
 */
export function postedTextClaimsDraft(postedText: string | null | undefined): boolean {
  if (!postedText) return false
  if (NO_DRAFT_RE.test(postedText)) return false
  return CLAIM_RE.test(postedText)
}

/** One-shot steer for a tick that claimed a draft it never created. */
export function buildDraftClaimReprompt(ticketId: string): string {
  return [
    "DRAFT-CLAIM CORRECTION (deterministic post-tick check, not an opinion):",
    `your tick output claims a gated customer reply/draft exists for ticket ${ticketId},`,
    "but NO tickets__reply call was made this tick — no approval request exists, and a",
    "human acting on your summary would wait for a draft that will never appear.",
    "Do ONE of the following NOW:",
    "(a) if this ticket needs a reply (it is our turn), CALL tickets__reply with the full",
    "customer-facing draft per the support voice skill — the call itself creates the pending",
    "approval; then restate your summary accurately; or",
    "(b) if on reflection no reply is warranted (noise, human-driven, awaiting customer),",
    "post a corrected summary that says plainly NO draft was created and why.",
    "Never describe a draft as existing or pending unless you called tickets__reply this tick.",
  ].join(" ")
}

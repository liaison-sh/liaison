// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A STOPPED ROUTINE SAYS TO THE PERSON READING IT (P8-FX2, SK-2 and the
// UI half of it).
//
// The worker writes two things when a tick stops: a status, which is a
// database enum, and a reason, which is a sentence naming the scopes that are
// missing. The list and the detail view rendered the enum with its underscores
// swapped for spaces ("paused scope mismatch", "skipped_scope_mismatch") and
// dropped the sentence entirely, so a person learned THAT their routine was
// paused and never why. These are the labels, in one place, so the list, the
// detail banner and the run history all say the same words.
//
// An unknown status still renders: a status this file has never heard of is
// shown with its underscores opened up rather than swallowed, because a label
// nobody wrote is better than a blank chip.

/** A translator, as `useI18n().t` hands one over. */
type Translate = (key: string) => string

/** The routine's own lifecycle status, as catalog keys. */
const ROUTINE_STATUS_KEYS: Record<string, string> = {
  active: "kernel.agents.status.active",
  completed: "kernel.agents.status.completed",
  paused_user: "kernel.agents.status.pausedUser",
  paused_scope_mismatch: "kernel.agents.status.pausedScopeMismatch",
  paused_no_credits: "kernel.agents.status.pausedNoCredits",
}

/** One tick's outcome, as catalog keys. */
const RUN_STATUS_KEYS: Record<string, string> = {
  running: "kernel.agents.status.running",
  succeeded: "kernel.agents.status.succeeded",
  failed: "kernel.agents.status.failed",
  no_run: "kernel.agents.status.noRun",
  skipped_scope_mismatch: "kernel.agents.status.skippedScopeMismatch",
  skipped_no_credits: "kernel.agents.status.skippedNoCredits",
  waiting_approval: "kernel.agents.status.waitingApproval",
  waiting_mailbox: "kernel.agents.status.waitingMailbox",
  mailbox_wait_expired: "kernel.agents.status.mailboxWaitExpired",
  mailbox_wait_dismissed: "kernel.agents.status.mailboxWaitDismissed",
}

function humanize(status: string): string {
  return status.replace(/_/g, " ")
}

export function routineStatusLabel(t: Translate, status: string): string {
  const key = ROUTINE_STATUS_KEYS[status]
  return key ? t(key) : humanize(status)
}

export function runStatusLabel(t: Translate, status: string): string {
  const key = RUN_STATUS_KEYS[status]
  return key ? t(key) : humanize(status)
}

/**
 * The sentence to show under a stopped routine: the worker's own reason when
 * it wrote one, and otherwise the label, so the line is never empty. The
 * worker's reason already opens with "Paused:" and names the scopes.
 */
export function routineStoppedReason(
  t: Translate,
  status: string,
  lastRunError: string | null,
): string {
  const reason = lastRunError?.trim()
  return reason && reason.length > 0 ? reason : routineStatusLabel(t, status)
}

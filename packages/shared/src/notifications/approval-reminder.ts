// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How often a person's agent reminds them of their own requests that still
// wait for a decision (Settings -> Notifications, "Approval reminders"). Kept
// per person in `kernel.user_preferences.notification_channels` as
// `approvalReminder`; no stored value means the default, daily.

export const APPROVAL_REMINDER_FREQUENCIES = ["daily", "every_3_days", "weekly", "off"] as const
export type ApprovalReminderFrequency = (typeof APPROVAL_REMINDER_FREQUENCIES)[number]

export const DEFAULT_APPROVAL_REMINDER = "daily" satisfies ApprovalReminderFrequency

/**
 * Hours per frequency: a request must have waited at least this long before it
 * is reminded of, and a person gets at most one reminder per this many hours.
 */
export const APPROVAL_REMINDER_HOURS: Record<Exclude<ApprovalReminderFrequency, "off">, number> = {
  daily: 24,
  every_3_days: 72,
  weekly: 168,
}

export function isApprovalReminderFrequency(v: unknown): v is ApprovalReminderFrequency {
  return typeof v === "string" && (APPROVAL_REMINDER_FREQUENCIES as readonly string[]).includes(v)
}

/** A stored value as a frequency: anything absent or unknown reads as the default. */
export function readApprovalReminder(stored: unknown): ApprovalReminderFrequency {
  return isApprovalReminderFrequency(stored) ? stored : DEFAULT_APPROVAL_REMINDER
}

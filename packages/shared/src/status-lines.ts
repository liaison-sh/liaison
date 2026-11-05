// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * STATUS LINES: system rows that say how something is going ("Routine X is
 * running", settled in place when the run ends). They are part of the
 * conversation's story but never news: they never count as unread for anyone,
 * on the server's counts (the thread list, the badge, a read mark's recount)
 * or in the client's live bump. Keyed on `metadata.type`.
 */
export const STATUS_LINE_TYPES = ["routine-run"] as const

/** Whether a message is a status line: a system row whose `metadata.type` is one. */
export function isStatusLine(message: {
  authorType?: string | null
  metadata?: { type?: unknown } | null
}): boolean {
  return (
    message.authorType === "system" &&
    typeof message.metadata?.type === "string" &&
    (STATUS_LINE_TYPES as readonly string[]).includes(message.metadata.type)
  )
}

// SPDX-License-Identifier: FSL-1.1-ALv2
import { STATUS_LINE_TYPES } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"

/**
 * A STATUS LINE IS NEVER UNREAD (`STATUS_LINE_TYPES`, "Routine X is running"):
 * a predicate on a message aliased `m`, for every count that says what is
 * unread (the thread list, `countThreadUnread`, the badge). The client's live
 * bump skips the same rows (`isStatusLine`).
 */
export function notStatusLine() {
  return drizzleSql`NOT (
    m.author_type = 'system'
    AND COALESCE(m.metadata->>'type', '') IN (${drizzleSql.join(
      STATUS_LINE_TYPES.map((t) => drizzleSql`${t}`),
      drizzleSql`, `,
    )})
  )`
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gmail's Primary / Other split (S13, A40), one SQL predicate for the inbox
// list and the agent's mail search.
//
//   Primary = carries CATEGORY_PERSONAL, or carries no CATEGORY_* label at all
//             (Gmail's uncategorised default, and every non-Gmail mailbox).
//   Other   = carries a CATEGORY_* label but not CATEGORY_PERSONAL.
//   all     = both: no filter.
//
// Measured on a production deployment 2026-10-07: the sync stores
// CATEGORY_PERSONAL explicitly (4133 rows), and only 5 of 7069 INBOX messages
// carry no category. Conversation labels are the union of their messages'.

import { sql as drizzleSql, type SQL } from "drizzle-orm"

export const MAIL_CATEGORIES = ["primary", "other", "all"] as const
export type MailCategory = (typeof MAIL_CATEGORIES)[number]

export function isMailCategory(value: unknown): value is MailCategory {
  return typeof value === "string" && (MAIL_CATEGORIES as readonly string[]).includes(value)
}

/** Undefined stays undefined (no filter); anything else must be a category. */
export function parseMailCategory(value: unknown): MailCategory | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (!isMailCategory(value)) throw new Error("category must be primary, other or all")
  return value
}

/**
 * The condition on a conversation's `labels` (jsonb array) for a category, or
 * null when it does not narrow.
 */
export function mailCategoryCondition(labels: SQL, category: MailCategory | undefined): SQL | null {
  if (!category || category === "all") return null
  const personal = drizzleSql`COALESCE(${labels}, '[]'::jsonb) @> '["CATEGORY_PERSONAL"]'::jsonb`
  const categorized = drizzleSql`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(${labels}, '[]'::jsonb)) AS category_label(value)
    WHERE left(category_label.value, 9) = 'CATEGORY_'
  )`
  return category === "primary"
    ? drizzleSql`(${personal} OR NOT ${categorized})`
    : drizzleSql`(NOT ${personal} AND ${categorized})`
}

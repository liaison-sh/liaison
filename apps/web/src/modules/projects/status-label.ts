// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared "internal enum -> human label" formatter for project statuses.
//
// Statuses are seeded (and can be renamed) as raw enum-shaped strings such as
// "in_progress" — every surface that renders a status label must prettify it
// the same way, or the same status reads "In progress" on one surface and
// "IN_PROGRESS" on another (PRJ-4).
import { tNow } from "~/modules/i18n/i18n-context"

/** The five columns every new project is seeded with, stored as these tokens. */
const SEEDED = new Set(["backlog", "todo", "in_progress", "done", "cancelled"])

/**
 * "in_progress" -> "In progress" ("En cours" for a French reader), "Done"
 * stays "Done". A seeded default column is the product's word and reads in the
 * reader's language; a column someone named is data and is only tidied.
 */
export function prettyStatus(label: string): string {
  if (SEEDED.has(label)) return tNow(`projects.statusDefault.${label}`)
  const cleaned = label.replace(/[_-]+/g, " ")
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

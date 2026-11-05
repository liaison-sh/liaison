// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A NAME FOR AN APPROVAL THAT NOBODY SUMMARIZED.
//
// An approval row titles itself from its author's `summary.title`. A tool with
// no registered summarizer, a summarizer that threw, and every row written
// outside `executeTool` (fixtures, the demo world, a backfill) leave that null,
// and the feed then fell back to `humanizeToolName` -- which is the SAME string
// the row's action badge already carries. The row deduplicated the two and
// rendered a badge, a handle and no title at all: four kinds ("Kernel: update
// skill", "Kernel: contacts merge", "Invoicing: record document refund",
// "Shopify: create discount") were indistinguishable from each other in the
// feed, while a ticket reply beside them read as a sentence.
//
// The payload already holds what the row is ABOUT. This names the row from it:
// the skill being rewritten, the two contacts being merged, the document being
// refunded, the discount code being minted. It is pure and total -- a tool it
// has never seen still gets the first nameable field in its payload, and a
// payload with nothing nameable answers null so the caller keeps the humanized
// "<App>: <action>" fallback. Nothing here can make a title WORSE than the one
// it replaces, and nothing here can render blank.
import { humanizeToolName, splitToolName } from "~/modules/approvals/event-data"

/** How much of a payload value can reach a row title before it is clipped. */
const MAX_DETAIL_CHARS = 80

/**
 * Payload keys that name the thing an action acts on, most specific first.
 * The sweep is the LAST resort: an explicit rule below beats it every time.
 */
const NAMEABLE_KEYS = [
  "documentNumber",
  "invoiceNumber",
  "orderNumber",
  "code",
  "handle",
  "subject",
  "ticketSubject",
  "name",
  "title",
  "label",
  "slug",
  "email",
  "to",
  "query",
]

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null
  // A single line, always: a payload body can carry a whole document and a row
  // title is one line of a 390px phone row.
  const flat = value.replace(/\s+/g, " ").trim()
  if (flat.length === 0) return null
  // A bare uuid names nothing a human recognises, and it is exactly what the
  // raw id fields hold.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(flat)) return null
  return flat.length > MAX_DETAIL_CHARS
    ? `${flat.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}...`
    : flat
}

function firstOf(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = clean(payload[key])
    if (value) return value
  }
  return null
}

/**
 * The action half of `humanizeToolName`, sentence-cased: "Kernel: update skill"
 * -> "Update skill". The app is already on the row's badge, so repeating it in
 * the title is the very duplication that hid the title in the first place.
 */
export function approvalActionPhrase(toolName: string): string {
  const full = humanizeToolName(toolName)
  const idx = full.indexOf(": ")
  const phrase = idx === -1 ? full : full.slice(idx + 2)
  if (phrase.length === 0) return full
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

export interface ApprovalTitleLookups {
  /** Skill names by id, for the skill tools whose payload carries only a uuid. */
  skillNamesById?: Record<string, string>
}

/**
 * A title for an approval that has no author summary, or null when the payload
 * says nothing a person would recognise. Never returns an empty string, never
 * returns a raw tool id and never returns a bare uuid.
 */
export function deriveApprovalTitle(
  toolName: string,
  payload: Record<string, unknown> | null | undefined,
  lookups: ApprovalTitleLookups = {},
): string | null {
  const detail = deriveApprovalDetail(toolName, payload, lookups)
  if (!detail) return null
  return `${approvalActionPhrase(toolName)}: ${detail}`
}

/**
 * The payload half of `deriveApprovalTitle` alone ("Panier moyen", "INV-42"),
 * so a reader's client can put its own words for the action in front of it.
 */
export function deriveApprovalDetail(
  toolName: string,
  payload: Record<string, unknown> | null | undefined,
  lookups: ApprovalTitleLookups = {},
): string | null {
  if (!payload || typeof payload !== "object") return null
  const { appName, toolShortName } = splitToolName(toolName)
  return deriveDetail(appName, toolShortName, payload, lookups)
}

function deriveDetail(
  appName: string,
  toolShortName: string,
  payload: Record<string, unknown>,
  lookups: ApprovalTitleLookups,
): string | null {
  // A SKILL is named by its row, not by the edit: `kernel:update_skill` takes
  // the skill's uuid and a body, so the only readable name lives in the skills
  // table and the caller resolves it.
  if (appName === "kernel" && /_skill$/.test(toolShortName)) {
    const id = typeof payload.id === "string" ? payload.id : null
    const fromRow = id ? clean(lookups.skillNamesById?.[id]) : null
    return fromRow ?? firstOf(payload, ["name", "title"])
  }

  // A MERGE destroys a row, so both sides belong in the title: which record
  // survives and which one disappears is the entire decision.
  if (toolShortName === "contacts_merge") {
    const primary = firstOf(payload, ["primaryContact", "primaryContactName", "primaryName"])
    const duplicate = firstOf(payload, [
      "duplicateContact",
      "duplicateContactName",
      "duplicateName",
    ])
    if (primary && duplicate) return `${primary} and ${duplicate}`
    return primary ?? duplicate
  }

  // A DISCOUNT is cited by the code customers type, not by its internal title.
  if (/^discounts_/.test(toolShortName)) {
    return firstOf(payload, ["code", "title", "name"])
  }

  return firstOf(payload, NAMEABLE_KEYS)
}

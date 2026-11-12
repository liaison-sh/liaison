// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The issue date a caller states on a new document: what it decides, and when it is refused.

import { type IssueDateParts, issueDateParts, type TimeSurface } from "../issue-date"
import { dateOnly, isCalendarDate } from "./db-helpers"
import type { ErrorEnvelope, MutationsDb } from "./shared"

function dateRefused(code: string, message: string): { ok: false; error: ErrorEnvelope } {
  return { ok: false, error: { status: "error", error: { code, message } } }
}

/**
 * The date and number year of a document whose caller may state its date, or the typed refusal.
 * The date decides both, since a number and its date belong to one year: a stated date in a past
 * year takes that year's series, never the current year's number. So is a date after today refused:
 * no number issued today can follow it, and every default date would precede it. Numbers and dates
 * also run together in a credit note series, so a date before its last number is refused before a
 * number is taken; a quote, proforma or purchase order records no sale, so no order binds it.
 * A credit note that names its invoice also follows it: it corrects something that already exists.
 * Only a date someone states is held to this: with none it takes today, so a refund or an order edit
 * still gets its credit note whatever the invoice's date.
 */
export async function statedIssueDate(
  ctx: TimeSurface & { db: Pick<MutationsDb, "findMany"> },
  issuer: { id: string; timezone?: string | null },
  type: string,
  stated: string | null | undefined,
  original?: { number?: string | null; issued_at?: unknown } | null,
): Promise<({ ok: true } & IssueDateParts) | { ok: false; error: ErrorEnvelope }> {
  const today = await issueDateParts(ctx, issuer)
  if (!today.ok || stated == null || stated === "") return today
  const date = dateOnly(stated)
  if (!date || !isCalendarDate(date)) {
    return dateRefused(
      "issued_at_invalid",
      `issued_at ${JSON.stringify(stated)} is not a date, so nothing was issued and no number was used. ` +
        "Pass YYYY-MM-DD, or omit issued_at to use today.",
    )
  }
  if (date > today.issued_at) {
    return dateRefused(
      "issue_date_in_future",
      `issued_at ${date} is after today (${today.issued_at} in the issuer's time zone), so nothing was issued ` +
        "and no number was used. Pass today or an earlier date, or omit issued_at to use today.",
    )
  }
  const originalDate = dateOnly(original?.issued_at)
  if (originalDate && date < originalDate) {
    return dateRefused(
      "issue_date_before_original",
      `issued_at ${date} is before ${String(original?.number ?? "the invoice")} (${originalDate}), the invoice this ` +
        "credit note corrects, so nothing was issued and no number was used. Pass that date or a later one, " +
        "or omit issued_at to use today.",
    )
  }
  const year = Number(date.slice(0, 4))
  if (type === "credit_note") {
    const [last] = (await ctx.db.findMany("documents", {
      where: { issuer_profile_id: issuer.id, type, year_of_issue: year },
      orderBy: { number_int: "desc" },
      limit: 1,
    })) as Array<Record<string, unknown>>
    const lastDate = dateOnly(last?.issued_at)
    if (lastDate && date < lastDate) {
      return dateRefused(
        "issue_date_before_last_number",
        `issued_at ${date} is before ${String(last?.number ?? "the last credit note")} (${lastDate}), the last number ` +
          `of the ${year} series, so nothing was issued and no number was used. Pass that date or a later one, ` +
          "or omit issued_at to use today.",
      )
    }
  }
  return { ok: true, year_of_issue: year, issued_at: date }
}

/**
 * A quote on an issuer linked to a Shopify shop is made as a draft order and mirrored back when the
 * draft order exists, which an approval in Shopify can put days away, so it takes that day. Another
 * date is refused before the draft order exists; today's date is no choice to refuse.
 */
export async function draftOrderDateRefusal(
  ctx: TimeSurface,
  issuer: { timezone?: string | null },
  stated: string | null | undefined,
): Promise<ErrorEnvelope | null> {
  if (stated == null || stated === "") return null
  const today = await issueDateParts(ctx, issuer)
  if (!today.ok) return today.error
  if (dateOnly(stated) === today.issued_at) return null
  return dateRefused(
    "issue_date_set_by_draft_order",
    `This issuer is linked to a Shopify shop, so the quote is made as a draft order and takes the day that draft ` +
      `order is created, not ${String(stated)}. Nothing was issued and no number was used. Omit issued_at, or ` +
      "issue the quote from an issuer with no shop.",
  ).error
}

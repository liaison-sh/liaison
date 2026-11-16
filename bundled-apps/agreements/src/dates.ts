// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Job `dates-daily`: what the calendar changes about agreements, once a day. A signed
// agreement inside its notice period raises `agreements/agreement:expiring` once for that
// date; a send whose every link expired with nobody signed becomes `expired`. Nothing is
// mailed from here: a reminder to a signer is always a person's gated reminder.

import { type AgreementsCtx, todayOf } from "./ctx"
import { latestOf, linksOf } from "./send"

interface DatedAgreement {
  id: string
  number: string
  title: string
  status: string
  ends_on?: string | null
  renews_on?: string | null
  notice_days?: number | null
  expiring_notified_on?: string | null
}

/** A date-only string moved by whole days, in UTC so no clock change shifts it. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number)
  const t = Date.UTC(y as number, (m as number) - 1, d as number) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

export async function datesDaily(ctx: AgreementsCtx) {
  const today = todayOf(ctx)
  let expiring = 0
  let expired = 0
  const signed = (await ctx.db.findMany("agreements", {
    where: { status: "signed" },
    limit: 2000,
  })) as DatedAgreement[]
  for (const a of signed) {
    const date = a.renews_on ?? a.ends_on ?? null
    if (!date || a.notice_days == null || a.expiring_notified_on === date) continue
    if (today < addDays(date, -a.notice_days) || today > date) continue
    await ctx.db.update("agreements", a.id, { expiring_notified_on: date })
    await ctx.emit?.({
      entity: "agreement",
      action: "expiring",
      entityId: a.id,
      data: { number: a.number, title: a.title, date, notice_days: a.notice_days },
    })
    expiring += 1
  }
  const waiting = (await ctx.db.findMany("agreements", {
    where: { status: "sent" },
    limit: 2000,
  })) as DatedAgreement[]
  for (const a of waiting) {
    const v = await latestOf(ctx, a.id)
    if (!v) continue
    const links = await linksOf(ctx, v.id)
    if (links.length === 0 || !links.every((l) => l.state === "expired")) continue
    await ctx.db.update("agreements", a.id, { status: "expired" })
    await ctx.emit?.({
      entity: "agreement",
      action: "expired",
      entityId: a.id,
      data: { number: a.number, version: v.number },
    })
    expired += 1
  }
  return {
    status: "ok",
    message: `Dates of ${today}: ${expiring} agreement(s) entered their notice period, ${expired} send(s) expired with nobody signed. Nothing was mailed.`,
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// retainer-timebox-roll (daily): each active retainer's next month gets its included hours as a
// timebox on the retainer's project, through projects' own timebox tool. Only the month to come is
// written: the current month keeps what it was given (terms changed during a month apply from the
// next; a signed renewal's hours apply from its first month). It reads schedules only, never anyone's time or activity, and drafts nothing.

import type { CrossAppExecuteTool } from "./cross-app"
import {
  isRetainerMonth,
  isRetainerSchedule,
  monthOf,
  nextMonth,
  termsForMonth,
} from "./recurring/retainer"
import { writeRetainerTimeboxes } from "./recurring/tools"

type Row = Record<string, unknown>

export interface RetainerRollCtx {
  db: { findMany(table: string, q: { where?: Row; limit?: number }): Promise<unknown> }
  executeTool: CrossAppExecuteTool
  time: { civil(o: { timezone: string }): Promise<{ date: string }> }
}

export async function retainerTimeboxRoll(
  ctx: RetainerRollCtx,
): Promise<{ written: number; months: string[] }> {
  const schedules = (await ctx.db.findMany("recurring_schedules", {
    where: { status: "active" },
    limit: 2000,
  })) as Row[]
  const months = new Set<string>()
  let written = 0
  for (const s of schedules) {
    if (!isRetainerSchedule(s) || typeof s.retainer_project_id !== "string") continue
    const issuer = (await ctx.db.findMany("issuer_profiles", {
      where: { id: String(s.issuer_profile_id) },
      limit: 1,
    })) as Row[]
    const timezone = String(issuer[0]?.timezone || "UTC")
    const month = nextMonth(monthOf((await ctx.time.civil({ timezone })).date))
    // A retainer that is off by then bills that month with the month-end run: no included hours.
    if (!isRetainerMonth(s, month)) continue
    const done = await writeRetainerTimeboxes(
      ctx as never,
      { id: String(s.id), retainer_project_id: s.retainer_project_id },
      [month],
      // A renewal signed for this month on gives it the renewed hours.
      Number(termsForMonth(s, month).retainer_minutes),
    )
    written += done.length
    for (const m of done) months.add(m)
  }
  return { written, months: [...months] }
}

export async function retainerTimeboxRollJobHandler(_payload: unknown, ctx: RetainerRollCtx) {
  return retainerTimeboxRoll(ctx)
}

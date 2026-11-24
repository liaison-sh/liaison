// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One change of a schedule at a time. A retainer's dated terms are one column, so a write made from
// a row read before another change would lose that change's entry. A change claims the row with a
// token, reads it, and writes only while the row still holds its token and the version it read:
// of two changes at once, the one that does not find its own writes nothing. (`ctx.db.updateMany`
// takes no `id`, so the token is also what names the row.)
import type { MutationsCtx } from "../mutations/shared"

const ENTITY = "recurring_schedules"

/** A claim on a schedule: what `writeVersion` writes on. */
export interface ScheduleClaim {
  token: string
  version: number
}

/** Claim the schedule for one change. Read the row after it, never before. */
export async function claimSchedule(
  ctx: { db: Pick<MutationsCtx["db"], "update"> },
  id: string,
): Promise<string> {
  const token = crypto.randomUUID()
  await ctx.db.update(ENTITY, id, { edit_token: token })
  return token
}

/** Write a change on the version it was made from; false when another change came first. */
export async function writeVersion(
  ctx: { db: Pick<MutationsCtx["db"], "updateMany"> },
  claim: ScheduleClaim,
  data: Record<string, unknown>,
): Promise<boolean> {
  const { count } = await ctx.db.updateMany(ENTITY, {
    where: { edit_token: claim.token, version: claim.version },
    data: { ...data, edit_token: null },
  })
  return count === 1
}

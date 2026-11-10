// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `subscriptions_search`: the mirror's subscriptions, masked. `id` returns that
// one row. Plan names come from Stripe, so the tool declares `taintSource`.
import { limitOf, offsetOf, pageOf, type ReadCtx, readPage, subscriptionItem } from "./read-common"

type Obj = Record<string, unknown>

export async function subscriptionsSearch(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const limit = limitOf(p.limit)
  const offset = offsetOf(p.cursor)
  const where: Obj = {}
  if (typeof p.id === "string" && p.id) where.stripe_id = p.id
  if (typeof p.customerId === "string" && p.customerId) where.customer_id = p.customerId
  if (typeof p.status === "string" && p.status) where.status = p.status
  const query = typeof p.query === "string" ? p.query.trim().toLowerCase() : ""
  if (query && !where.stripe_id) {
    // A plan name: kept from at most 1 000 rows of the other filters.
    const rows = ((await ctx.db.findMany("stripe_subscriptions", { where, limit: 1000 })) as Obj[]).filter((r) =>
      String(r.plan_name ?? "").toLowerCase().includes(query),
    )
    const page = rows.slice(offset, offset + limit)
    return pageOf(page.map(subscriptionItem), page, offset, limit, "subscriptions", rows.length > offset + limit)
  }
  const { rows, more } = await readPage(ctx, "stripe_subscriptions", where, offset, limit, {
    current_period_end: "desc",
    id: "asc",
  })
  return pageOf(rows.map(subscriptionItem), rows, offset, limit, "subscriptions", more)
}

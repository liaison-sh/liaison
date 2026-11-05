// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Resolve a shipment row from whatever reference a caller holds.
//
// Several tools (print_pack, ready_set_packed, import_label_document) accept
// either the local row id (a UUID, `shipment.id`) or the carrier's order id
// (`shipment.boxtal_order_id`, a carrier-issued string that is NOT a UUID).
// They used to query `id` first with the raw reference. A carrier order id
// reaching the uuid `id` column makes postgres refuse the whole query
// ("invalid input syntax for type uuid"), so the fallback to
// `boxtal_order_id` never ran and the tool failed on a database error instead
// of finding the row. The `id` column is now only asked for a UUID-shaped
// reference; any other reference goes straight to the carrier order id.

import type { BoxtalToolCtx } from "./ctx"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when `ref` has the shape of a local shipment row id (a UUID). */
export function isShipmentRowId(ref: string): boolean {
  return UUID_RE.test(ref)
}

/**
 * The shipment row `ref` names: by local row id when `ref` is a UUID, then by
 * carrier order id. `orderIdFirst` asks the carrier order id first (for tools
 * whose callers mostly hold the carrier's id). Null when no row matches.
 */
export async function findShipmentByRef<T = Record<string, unknown>>(
  ctx: Pick<BoxtalToolCtx, "db">,
  ref: string,
  opts: { orderIdFirst?: boolean } = {},
): Promise<T | null> {
  const byId = async () =>
    isShipmentRowId(ref)
      ? ((await ctx.db.findMany("shipment", { where: { id: ref }, limit: 1 })) as T[])
      : []
  const byOrderId = async () =>
    (await ctx.db.findMany("shipment", { where: { boxtal_order_id: ref }, limit: 1 })) as T[]
  const [first, second] = opts.orderIdFirst ? [byOrderId, byId] : [byId, byOrderId]
  const rows = await first()
  if (rows.length > 0) return rows[0] ?? null
  return (await second())[0] ?? null
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UNITS STILL TO SHIP, PER PRODUCT CODE: the To prepare worklist (`prep_list`'s unscoped read)
// folded into one row per short product code, so a dashboard can show how many of each product
// the open orders still need, next to stock or production figures.
//
// The codes are the ones the worklist's products column shows: each row's products summary goes
// through `resolveProductCodes` with the org's product-code mapping, so a retail sku and its
// wholesale variant land on the same code. A partially shipped order counts only its remaining
// lines, because its cached summary is the remaining batch's. A summary that is not a quantity list
// (an order-less row with no goods lines, "-") contributes nothing.
//
// A read: it never calls the Boxtal API (prep_list's unscoped read does not either).

import type { BoxtalToolCtx } from "./ctx"
import { type PrepRow, prepList } from "./prep"
import {
  EMPTY_PRODUCT_CODE_CONFIG,
  type ProductCodeConfig,
  resolveProductCodes,
  sortByProductRank,
} from "./product-codes"
import { loadProductCodeConfig } from "./settings"

export interface ToShipByProductRow {
  /** Short product code, as the worklist's products column shows it. */
  code: string
  /** Units of this code still to ship, summed over every worklist row. */
  units: number
  /** How many worklist rows (orders) still need at least one unit of this code. */
  orders: number
}

export interface ToShipByProductResult {
  rows: ToShipByProductRow[]
  /** Sum of `units` over every row. */
  total_units: number
  /** When the worklist was read (ISO 8601). */
  as_of: string
  /** True when the worklist scan was bounded (the 250 most recent open orders): counts may be low. */
  truncated: boolean
}

/** The part of a worklist row the count reads. */
export type ToShipSourceRow = Pick<PrepRow, "products"> &
  Partial<Pick<PrepRow, "partially_shipped" | "remaining_units">>

/**
 * Fold worklist rows into units per product code. Pure, and the test seam.
 *
 * A row whose every unit already has a live shipment (`partially_shipped` with
 * `remaining_units: 0`) counts nothing. Rows come out in the org's code rank order (lower rank
 * first); codes with the same rank, or an org with no ranks, read alphabetically.
 */
export function aggregateToShipByProduct(
  rows: readonly ToShipSourceRow[],
  config: ProductCodeConfig = EMPTY_PRODUCT_CODE_CONFIG,
): { rows: ToShipByProductRow[]; total_units: number } {
  const byCode = new Map<string, ToShipByProductRow>()
  for (const row of rows) {
    if (row.partially_shipped && row.remaining_units === 0) continue
    for (const { code, qty } of resolveProductCodes(row.products, config)) {
      if (!(qty > 0)) continue
      const existing = byCode.get(code)
      if (existing) {
        existing.units += qty
        existing.orders += 1
      } else {
        byCode.set(code, { code, units: qty, orders: 1 })
      }
    }
  }
  const alphabetical = [...byCode.values()].sort((a, b) => {
    const ua = a.code.toUpperCase()
    const ub = b.code.toUpperCase()
    return ua < ub ? -1 : ua > ub ? 1 : 0
  })
  const out = sortByProductRank(alphabetical, config)
  return { rows: out, total_units: out.reduce((s, r) => s + r.units, 0) }
}

/** `to_ship_by_product`: the To prepare worklist as units per product code. */
export async function toShipByProduct(
  ctx: BoxtalToolCtx,
  now: () => Date = () => new Date(),
): Promise<ToShipByProductResult> {
  const [list, config] = await Promise.all([prepList(ctx, {}), loadProductCodeConfig(ctx)])
  const { rows, total_units } = aggregateToShipByProduct(list.rows, config)
  return { rows, total_units, as_of: now().toISOString(), truncated: list.truncated === true }
}

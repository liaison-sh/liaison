// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PRODUCTS COLUMN RESOLUTION: the pure half of the prep grid's narrowest useful cell.
//
// The sku to short-code mapping is org data and is applied server-side (`prep_list` builds a
// document-less row's products from the order's line items through the org's
// `product_code_aliases`), so the list this cell receives already carries the org's short codes.
// What the cell still does is merge: a Shopify order can carry one product on several line items,
// and an operator packing that box needs `3x`, not two numbers to add up in their head. The
// renderer keeps the summary it received on the cell's `title`.
//
// No dash punctuation in anything this returns: `formatProductCode` uses the "3xK1" form the
// column has always used.

export { type ProductCode, resolveProductCodes, shortProductCode } from "../product-codes"

import type { ProductCode } from "../product-codes"

/** Longest code the grid's chip renders in full. Past it the code is elided and the cell's
 *  `title` (the verbatim original summary) is the full reading. */
const CHIP_MAX = 12

/**
 * Display form of one resolved code inside the grid's cell: capped, and with a Shopify gid (which
 * an un-profiled free-text line can carry) reduced to its recognisable tail rather than 40
 * characters of url.
 */
export function productChipLabel(code: string): string {
  const gid = code.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/)
  if (gid) return `V${(gid[1] ?? "").slice(-6)}`
  return code.length > CHIP_MAX ? `${code.slice(0, CHIP_MAX - 1)}…` : code
}

/**
 * Text form of one entry, quantity included only when it is not 1: `3xK1`, `K1`. A column of
 * "1x" prefixes is noise on every retail row, and the quantities that matter when packing are the
 * ones above one.
 */
export function formatProductCode(entry: ProductCode): string {
  return entry.qty === 1 ? entry.code : `${entry.qty}x${entry.code}`
}

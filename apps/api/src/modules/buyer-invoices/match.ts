// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which sales a buyer's website request may see. The website sends the identity its own server
// holds for the signed-in buyer (an email, a Shopify customer id, its own user id); each sale
// keeps the identity captured when it was sold. A sale S matches a request R if and only if:
//  1. no conflict: for every strong id kind set on both, the values are equal (one conflicting
//     id excludes the sale, whatever else matches), and
//  2. a match: some strong id kind is set on both, or S has no strong id at all and R's email
//     equals S's email.
// So an email alone never reaches a sale that carries a strong id, and a wrong id next to a
// right email excludes the sale. Pure: the store pre-selects candidates by any shared value and
// this rule decides.

export interface BuyerIdentity {
  /** Trimmed, lower case, nothing else folded. */
  email: string | null
  shopifyCustomerId: string | null
  hubUserId: string | null
}

const STRONG = ["shopifyCustomerId", "hubUserId"] as const

export function normaliseIdentity(raw: {
  email?: string | null
  shopifyCustomerId?: string | null
  hubUserId?: string | null
}): BuyerIdentity {
  const clean = (v: string | null | undefined) => {
    const t = (v ?? "").trim()
    return t === "" ? null : t
  }
  const email = clean(raw.email)
  return {
    email: email ? email.toLowerCase() : null,
    shopifyCustomerId: clean(raw.shopifyCustomerId),
    hubUserId: clean(raw.hubUserId),
  }
}

export function hasIdentity(i: BuyerIdentity): boolean {
  return i.email !== null || i.shopifyCustomerId !== null || i.hubUserId !== null
}

export function saleMatches(request: BuyerIdentity, sale: BuyerIdentity): boolean {
  let strongShared = false
  for (const kind of STRONG) {
    const r = request[kind]
    const s = sale[kind]
    if (r !== null && s !== null) {
      if (r !== s) return false
      strongShared = true
    }
  }
  if (strongShared) return true
  const saleHasStrong = STRONG.some((k) => sale[k] !== null)
  return !saleHasStrong && request.email !== null && request.email === sale.email
}

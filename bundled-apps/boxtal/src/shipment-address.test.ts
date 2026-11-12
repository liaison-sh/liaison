// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which address a shipment draft ships to once the contact has an address book: the order's own
// ship-to wins, a verified delivery address is used only when the order carries none, the draft
// says whether the two agree (address_check), and the location never mixes sources.
import { describe, expect, it } from "bun:test"
import type { GoldenCase, GoldenShopifyAddress } from "./__fixtures__/address-golden"
import { docId, goldenCtx } from "./__fixtures__/address-harness"
import { shipmentDraftCreate } from "./shipment"

const ORDER_SITE: GoldenShopifyAddress = {
  name: "Lena Brandt",
  company: "Werkton Distribution GmbH",
  address1: "Werkstr. 6",
  address2: null,
  city: "Remagen",
  zip: "53424",
  countryCode: "DE",
  phone: null,
}
const COPIED_SITE = {
  name: "Paul Rehm",
  company: null,
  email: "orders@werkton.example",
  phone: "+4915100000001",
  street: "Fliederstrasse 7",
  city: "Remagen",
  postalCode: "53424",
  countryIsoCode: "DE",
  state: null,
}
function verifiedRow(
  over: Record<string, string | boolean | null>,
): Record<string, string | boolean | null> {
  return {
    role: "delivery",
    name: "Lena Brandt",
    company: "Werkton Distribution GmbH",
    street1: "Werkstrasse 6",
    city: "Remagen",
    postalCode: "53424",
    countryIso2: "DE",
    phone: "+492642000000",
    email: "lager@werkton.example",
    origin: "manual",
    verified: true,
    verifiedAt: "2026-10-20T09:00:00.000Z",
    verifiedBy: "user-1",
    verifiedByName: "Sam Operator",
    verificationSource: "purchase_order",
    ...over,
  }
}

function b2bCase(over: Partial<GoldenCase>): GoldenCase {
  return {
    id: "case-90",
    doc: {
      counterparty_country: "DE",
      counterparty_name: "Werkton Distribution GmbH",
      counterparty_email: "orders@werkton.example",
      counterparty_contact_id: "22222222-2222-4222-8222-222222222222",
      counterparty_address: "Werkton Distribution GmbH\nFliederstrasse 7\n53424 Remagen",
      shopify_order_id: "7300001",
    },
    contactAddress: COPIED_SITE,
    order: { shippingAddress: ORDER_SITE, customerAddress: null, email: "orders@werkton.example" },
    ...over,
  }
}

async function draftOf(c: GoldenCase, orderShipTo = true) {
  const { ctx, calls } = goldenCtx(c)
  const draft = await shipmentDraftCreate(ctx, {
    document_ref: docId(c),
    ...(orderShipTo ? {} : { orderShipTo: false }),
  })
  return { draft, calls }
}

describe("shipment draft address: order ship-to and the address book", () => {
  it("ships to the order's own address over a different contact copy, and says it matches the verified one", async () => {
    // The order ships to street A, the contact carries a copy of another site (street B), and the
    // address book holds a verified address C that is A written differently.
    const { draft } = await draftOf(b2bCase({ book: [verifiedRow({})] }))
    expect(draft.recipient_address).toMatchObject({
      street: "Werkstr. 6",
      city: "Remagen",
      postalCode: "53424",
      countryIsoCode: "DE",
      company: "Werkton Distribution GmbH",
      name: "Lena Brandt",
    })
    // The phone may come from the verified address (same place), never from the copy of the other site.
    expect(draft.recipient_address?.phone).toBe("+492642000000")
    expect(draft.address_check).toMatchObject({
      state: "match",
      used: {
        source: "order",
        address_id: "addr-case-90-0",
        verified_at: "2026-10-20T09:00:00.000Z",
        verified_by_name: "Sam Operator",
        verification_source: "purchase_order",
      },
      order_address: { street: "Werkstr. 6", postalCode: "53424" },
      verified_address: { id: "addr-case-90-0", street: "Werkstrasse 6" },
    })
  })

  it("says the order and the verified address differ, and still ships to the order (a person decides)", async () => {
    const { draft } = await draftOf(
      b2bCase({ book: [verifiedRow({ street1: "Industriepark 3", postalCode: "53424" })] }),
    )
    expect(draft.recipient_address).toMatchObject({ street: "Werkstr. 6", postalCode: "53424" })
    // No phone from a verified address at another place either.
    expect(draft.recipient_address?.phone ?? null).toBeNull()
    expect(draft.address_check?.state).toBe("differs")
    expect(draft.address_check?.used).toEqual({ source: "order" })
    expect(draft.address_check?.verified_address).toMatchObject({ street: "Industriepark 3" })
  })

  it("a different house number is a different address", async () => {
    const { draft } = await draftOf(b2bCase({ book: [verifiedRow({ street1: "Werkstrasse 8" })] }))
    expect(draft.address_check?.state).toBe("differs")
  })

  it("uses the verified address outright when the order carries none", async () => {
    const { draft } = await draftOf(
      b2bCase({
        order: { shippingAddress: null, customerAddress: null, email: null },
        book: [verifiedRow({})],
      }),
    )
    expect(draft.recipient_address).toMatchObject({
      street: "Werkstrasse 6",
      city: "Remagen",
      postalCode: "53424",
      phone: "+492642000000",
      email: "lager@werkton.example",
    })
    expect(draft.address_check).toMatchObject({
      state: "verified_only",
      used: { source: "verified", address_id: "addr-case-90-0", verified_by_name: "Sam Operator" },
      order_address: null,
    })
  })

  it("uses the verified address over the contact copy for an invoice with no order", async () => {
    const { draft } = await draftOf(
      b2bCase({
        doc: { ...b2bCase({}).doc, shopify_order_id: null },
        order: undefined,
        book: [verifiedRow({})],
      }),
    )
    expect(draft.recipient_address).toMatchObject({
      street: "Werkstrasse 6",
      phone: "+492642000000",
    })
    expect(draft.address_check?.state).toBe("verified_only")
  })

  it("ignores unverified, stale, archived and non-delivery rows", async () => {
    const { draft } = await draftOf(
      b2bCase({
        order: undefined,
        doc: { ...b2bCase({}).doc, shopify_order_id: null },
        book: [
          verifiedRow({
            verified: false,
            verifiedAt: null,
            verifiedBy: null,
            verifiedByName: null,
            verificationSource: null,
          }),
          verifiedRow({ stale: true, staleAt: "2026-10-25T00:00:00.000Z" }),
          verifiedRow({ archived: true }),
          verifiedRow({ role: "billing" }),
        ],
      }),
    )
    expect(draft.address_check?.state).toBe("no_verified")
    expect(draft.recipient_address?.street).toBe("Fliederstrasse 7")
  })

  it("never mixes a location: street and postal code always come from the same source", async () => {
    const order = { ...ORDER_SITE, phone: "+492642111111" }
    const variants: GoldenCase[] = [
      b2bCase({}),
      b2bCase({ contactAddress: { ...COPIED_SITE, postalCode: null } }),
      b2bCase({ contactAddress: { ...COPIED_SITE, phone: null } }),
      b2bCase({ order: { shippingAddress: { ...order, zip: null }, email: null } }),
      b2bCase({
        order: { shippingAddress: order, email: null },
        book: [verifiedRow({ street1: "Industriepark 3", postalCode: "53111" })],
      }),
      b2bCase({
        order: { shippingAddress: null, customerAddress: null },
        book: [verifiedRow({ postalCode: null })],
      }),
      b2bCase({
        order: {
          shippingAddress: null,
          customerAddress: { ...order, address1: "Am Hang 1", zip: "53489" },
        },
      }),
    ]
    const sources = (c: GoldenCase): Array<[string | null, string | null]> => {
      const out: Array<[string | null, string | null]> = []
      const o = c.order?.shippingAddress
      if (o) out.push([[o.address1, o.address2].filter(Boolean).join(", ") || null, o.zip ?? null])
      const d = c.order?.customerAddress
      if (d) out.push([[d.address1, d.address2].filter(Boolean).join(", ") || null, d.zip ?? null])
      if (c.contactAddress)
        out.push([c.contactAddress.street ?? null, c.contactAddress.postalCode ?? null])
      for (const b of c.book ?? [])
        out.push([(b.street1 as string | null) ?? null, (b.postalCode as string | null) ?? null])
      out.push(["Werkton Distribution GmbH, Fliederstrasse 7", "53424"])
      return out
    }
    for (const c of variants) {
      for (const orderShipTo of [true, false]) {
        const { draft } = await draftOf(c, orderShipTo)
        const a = draft.recipient_address
        const pair: [string | null, string | null] = [a?.street ?? null, a?.postalCode ?? null]
        const from = sources(c).filter(
          ([s, p]) => s === pair[0] && (p === pair[1] || pair[1] == null),
        )
        expect({
          variant: variants.indexOf(c),
          orderShipTo,
          pair,
          found: from.length > 0,
        }).toMatchObject({ found: true })
        // A postal code is never carried without a street from the same source.
        if (pair[1] != null)
          expect(sources(c).some(([s, p]) => s === pair[0] && p === pair[1])).toBe(true)
      }
    }
  })

  it("reads the order once per label-path build and never on the worklist path", async () => {
    const usd = b2bCase({
      doc: { ...b2bCase({}).doc, counterparty_country: "US" },
      book: [verifiedRow({})],
    })
    const label = await draftOf(usd)
    expect(label.calls.filter((t) => t === "shopify:orders_get")).toHaveLength(1)
    expect(label.calls.filter((t) => t === "kernel:contacts_addresses_list")).toHaveLength(1)
    const worklist = await draftOf(usd, false)
    expect(worklist.calls.filter((t) => t === "shopify:orders_get")).toHaveLength(0)
  })

  it("the worklist path uses the order address prep_sync cached, so the grid agrees with the label", async () => {
    const { draft } = await draftOf(b2bCase({ cachedShipTo: true, book: [verifiedRow({})] }), false)
    expect(draft.recipient_address?.street).toBe("Werkstr. 6")
    expect(draft.address_check?.state).toBe("match")
  })

  it("the worklist path without a cached order address never uses a verified address in its place", async () => {
    // The order may carry an address the worklist cannot see; a verified address must not stand in.
    const { draft } = await draftOf(
      b2bCase({ book: [verifiedRow({ street1: "Industriepark 3" })] }),
      false,
    )
    expect(draft.address_check?.used?.source).not.toBe("verified")
  })
})

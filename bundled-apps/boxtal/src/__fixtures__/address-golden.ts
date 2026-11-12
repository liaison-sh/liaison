// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ~50 real-shaped synthetic orders for the address golden test (address-golden.test.ts). None of
// these customers has a VERIFIED address: the test proves that for them the draft is exactly what
// it was before the address book existed, except the one documented change (the order's own
// ship-to beats a different address copied onto the contact).
//
// Shapes mirror what the prep grid sees in production: a contact address copied from the order by
// prep_sync (identical, or written differently), contacts with no address or no phone, orders with
// no shipping address (customer default only), invoices with no order, order-less proformas with
// a typed recipient, US/CA states, and B2B customers whose copied contact address is another site.
// All names and addresses are invented.

export interface GoldenShopifyAddress {
  name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  zip?: string | null
  countryCode?: string | null
  phone?: string | null
  province?: string | null
  provinceCode?: string | null
}

export interface GoldenCase {
  id: string
  /** Invoice fields the draft reads. */
  doc: {
    counterparty_country: string
    counterparty_name: string
    counterparty_email: string | null
    counterparty_contact_id: string | null
    counterparty_address: string | null
    shopify_order_id: string | null
  }
  /** The contact's metadata.shipping_address (undefined: the contact has none). */
  contactAddress?: Record<string, string | null>
  /** shopify:orders_get result (undefined: no order or no read). */
  order?: {
    shippingAddress?: GoldenShopifyAddress | null
    customerAddress?: GoldenShopifyAddress | null
    email?: string | null
  }
  /** Order-less row: prep_order_state.recipient. */
  prepRecipient?: Record<string, string | null>
  /** Unverified address-book rows (a legacy copy or a typed address, never verified). */
  book?: Array<Record<string, string | boolean | null>>
  /** prep_sync cached the order's ship-to on prep_meta (bulk drafts read it). */
  cachedShipTo?: boolean
  /** The documented change: the order's own ship-to now beats a different contact copy. */
  orderBeatsContactCopy?: boolean
}

let seq = 0
function uuid(): string {
  seq++
  const hex = seq.toString(16).padStart(12, "0")
  return `00000000-0000-4000-8000-${hex}`
}

function shop(a: GoldenShopifyAddress): GoldenShopifyAddress {
  return { address2: null, company: null, province: null, provinceCode: null, ...a }
}

function copyOf(a: GoldenShopifyAddress, email: string | null): Record<string, string | null> {
  return {
    name: a.name ?? null,
    company: a.company ?? null,
    email,
    phone: a.phone ?? null,
    street: [a.address1, a.address2].filter((v) => v && v.trim()).join(", ") || null,
    city: a.city ?? null,
    postalCode: a.zip ?? null,
    countryIsoCode: a.countryCode ?? null,
    state: a.provinceCode ?? a.province ?? null,
  }
}

function invoiceText(a: GoldenShopifyAddress, withCompany = false): string {
  const lines = [withCompany ? a.company : null, a.address1, a.address2, `${a.zip} ${a.city}`]
  return lines.filter((l): l is string => Boolean(l && l.trim())).join("\n")
}

function base(
  country: string,
  name: string,
  email: string | null,
  opts: { contact?: boolean; order?: boolean; address?: string | null } = {},
): GoldenCase["doc"] {
  return {
    counterparty_country: country,
    counterparty_name: name,
    counterparty_email: email,
    counterparty_contact_id: opts.contact === false ? null : uuid(),
    counterparty_address: opts.address ?? null,
    shopify_order_id: opts.order === false ? null : String(7100000 + seq),
  }
}

export function goldenCases(): GoldenCase[] {
  seq = 0
  const cases: GoldenCase[] = []
  const add = (c: Omit<GoldenCase, "id">) =>
    cases.push({ id: `case-${String(cases.length + 1).padStart(2, "0")}`, ...c })

  // A. French B2C: prep_sync copied the order's ship-to onto the contact verbatim.
  const fr: GoldenShopifyAddress[] = [
    {
      name: "Camille Rousseau",
      address1: "12 rue des Lilas",
      city: "Lyon",
      zip: "69003",
      countryCode: "FR",
      phone: "+33612345601",
    },
    {
      name: "Hugo Lambert",
      address1: "4 avenue Jean Jaures",
      address2: "Bat B",
      city: "Nantes",
      zip: "44000",
      countryCode: "FR",
      phone: "+33612345602",
    },
    {
      name: "Lea Fontaine",
      address1: "78 boulevard Voltaire",
      city: "Paris",
      zip: "75011",
      countryCode: "FR",
      phone: "+33612345603",
    },
    {
      name: "Nathan Girard",
      address1: "3 impasse des Tilleuls",
      city: "Rennes",
      zip: "35000",
      countryCode: "FR",
      phone: "+33612345604",
    },
    {
      name: "Manon Leroy",
      address1: "21 rue Nationale",
      city: "Lille",
      zip: "59000",
      countryCode: "FR",
      phone: "+33612345605",
    },
    {
      name: "Louis Morel",
      company: "Studio Morel",
      address1: "9 quai de la Fosse",
      city: "Nantes",
      zip: "44100",
      countryCode: "FR",
      phone: "+33612345606",
    },
    {
      name: "Chloe Andre",
      address1: "150 route de Narbonne",
      city: "Toulouse",
      zip: "31400",
      countryCode: "FR",
      phone: "+33612345607",
    },
    {
      name: "Jules Mercier",
      address1: "2 place Bellecour",
      city: "Lyon",
      zip: "69002",
      countryCode: "FR",
      phone: "+33612345608",
    },
    {
      name: "Ines Blanc",
      address1: "45 cours Mirabeau",
      city: "Aix-en-Provence",
      zip: "13100",
      countryCode: "FR",
      phone: "+33612345609",
    },
    {
      name: "Theo Garnier",
      address1: "6 allee des Pins",
      city: "Bordeaux",
      zip: "33000",
      countryCode: "FR",
      phone: "+33612345610",
    },
  ]
  fr.forEach((a, i) => {
    const email = `buyer${i}@mail.example`
    const s = shop(a)
    add({
      doc: base("FR", a.name!, email, { address: invoiceText(s) }),
      contactAddress: copyOf(s, email),
      order: { shippingAddress: s, email },
      cachedShipTo: i % 2 === 0,
    })
  })

  // B. EU B2C: the contact copy is written differently from the order (abbreviation, case,
  // punctuation, spacing in the postal code). Same place.
  const eu: Array<[GoldenShopifyAddress, string]> = [
    [
      {
        name: "Jonas Becker",
        address1: "Lindenstrasse 14",
        city: "Koeln",
        zip: "50674",
        countryCode: "DE",
        phone: "+4917011100001",
      },
      "Lindenstr. 14",
    ],
    [
      {
        name: "Anna Schulz",
        address1: "Gartenweg 3a",
        city: "Bonn",
        zip: "53111",
        countryCode: "DE",
        phone: "+4917011100002",
      },
      "GARTENWEG 3 A",
    ],
    [
      {
        name: "Marco Bianchi",
        address1: "Via Roma 22",
        city: "Milano",
        zip: "20121",
        countryCode: "IT",
        phone: "+393331110003",
      },
      "via roma, 22",
    ],
    [
      {
        name: "Lucia Garcia",
        address1: "Calle Mayor 7",
        city: "Madrid",
        zip: "28013",
        countryCode: "ES",
        phone: "+34611110004",
      },
      "Calle Mayor, 7",
    ],
    [
      {
        name: "Sander de Vries",
        address1: "Keizersgracht 101",
        city: "Amsterdam",
        zip: "1015 CJ",
        countryCode: "NL",
        phone: "+31611110005",
      },
      "Keizersgracht 101",
    ],
    [
      {
        name: "Elise Peeters",
        address1: "Avenue Louise 54",
        city: "Bruxelles",
        zip: "1050",
        countryCode: "BE",
        phone: "+32471110006",
      },
      "Av. Louise 54",
    ],
  ]
  eu.forEach(([a, written], i) => {
    const email = `eu${i}@mail.example`
    const s = shop(a)
    add({
      doc: base(a.countryCode!, a.name!, email, { address: invoiceText(s) }),
      contactAddress: {
        ...copyOf(s, email),
        street: written,
        postalCode: i === 4 ? "1015CJ" : (a.zip ?? null),
      },
      order: { shippingAddress: s, email },
      cachedShipTo: i % 2 === 1,
    })
  })

  // C. No contact on the invoice; the order carries the ship-to.
  const noContact: GoldenShopifyAddress[] = [
    {
      name: "Paul Simon",
      address1: "8 rue Gambetta",
      city: "Tours",
      zip: "37000",
      countryCode: "FR",
      phone: "+33612340001",
    },
    {
      name: "Eva Novak",
      address1: "Hlavni 12",
      city: "Brno",
      zip: "60200",
      countryCode: "CZ",
      phone: "+420601110002",
    },
    {
      name: "Ole Hansen",
      address1: "Storgata 5",
      city: "Oslo",
      zip: "0155",
      countryCode: "NO",
      phone: null,
    },
    {
      name: "Mia Weber",
      address1: "Bahnhofstrasse 40",
      city: "Zuerich",
      zip: "8001",
      countryCode: "CH",
      phone: "+41791110004",
    },
    {
      name: "Tom Murphy",
      address1: "14 Grafton Street",
      city: "Dublin",
      zip: "D02 X285",
      countryCode: "IE",
      phone: "+353861110005",
    },
  ]
  noContact.forEach((a, i) => {
    const email = `nc${i}@mail.example`
    const s = shop(a)
    add({
      doc: base(a.countryCode!, a.name!, email, { contact: false, address: invoiceText(s) }),
      order: { shippingAddress: s, email },
    })
  })

  // D. A contact with no copied address yet; the order carries the ship-to.
  const noCopy: GoldenShopifyAddress[] = [
    {
      name: "Sarah Klein",
      address1: "Rosenweg 2",
      city: "Mainz",
      zip: "55116",
      countryCode: "DE",
      phone: "+4917022200001",
    },
    {
      name: "Lucas Petit",
      address1: "33 rue de la Paix",
      city: "Reims",
      zip: "51100",
      countryCode: "FR",
      phone: "+33622220002",
    },
    {
      name: "Giulia Ferri",
      company: "Ferri Suoni",
      address1: "Corso Vittorio 9",
      city: "Torino",
      zip: "10121",
      countryCode: "IT",
      phone: "+393332220003",
    },
    {
      name: "Kenji Sato",
      address1: "2-3-1 Nishi-Shinjuku",
      city: "Tokyo",
      zip: "163-8001",
      countryCode: "JP",
      phone: "+81312340004",
    },
  ]
  noCopy.forEach((a, i) => {
    const email = `ncp${i}@mail.example`
    const s = shop(a)
    add({
      doc: base(a.countryCode!, a.name!, email, { address: invoiceText(s, Boolean(a.company)) }),
      order: { shippingAddress: s, email },
      cachedShipTo: i === 0,
    })
  })

  // E. A contact copy with no phone (an old copy); the order has the phone. Same place.
  const noPhone: GoldenShopifyAddress[] = [
    {
      name: "Remi Faure",
      address1: "17 rue Victor Hugo",
      city: "Grenoble",
      zip: "38000",
      countryCode: "FR",
      phone: "+33633330001",
    },
    {
      name: "Lena Wolf",
      address1: "Marktplatz 1",
      city: "Heidelberg",
      zip: "69117",
      countryCode: "DE",
      phone: "+4917033300002",
    },
    {
      name: "Pedro Silva",
      address1: "Rua Augusta 100",
      city: "Lisboa",
      zip: "1100-053",
      countryCode: "PT",
      phone: "+351911110003",
    },
    {
      name: "Anouk Janssen",
      address1: "Oudegracht 50",
      city: "Utrecht",
      zip: "3511 AR",
      countryCode: "NL",
      phone: null,
    },
  ]
  noPhone.forEach((a, i) => {
    const email = `np${i}@mail.example`
    const s = shop(a)
    add({
      doc: base(a.countryCode!, a.name!, email, { address: invoiceText(s) }),
      contactAddress: { ...copyOf(s, null), phone: null },
      order: { shippingAddress: s, email },
    })
  })

  // F. A manual invoice (no order) with a contact address on file.
  const manual: GoldenShopifyAddress[] = [
    {
      name: "Atelier Sonore",
      company: "Atelier Sonore SARL",
      address1: "5 rue du Port",
      city: "Marseille",
      zip: "13002",
      countryCode: "FR",
      phone: "+33491110001",
    },
    {
      name: "Klangwerk GmbH",
      company: "Klangwerk GmbH",
      address1: "Industriestr. 20",
      city: "Stuttgart",
      zip: "70565",
      countryCode: "DE",
      phone: "+49711110002",
    },
    {
      name: "Nordic Tone AS",
      company: "Nordic Tone AS",
      address1: "Industriveien 4",
      city: "Grimstad",
      zip: "4879",
      countryCode: "NO",
      phone: "+4737110003",
    },
    {
      name: "Ruta Kalnina",
      address1: "Brivibas iela 30",
      city: "Riga",
      zip: "LV-1050",
      countryCode: "LV",
      phone: "+37121110004",
    },
  ]
  manual.forEach((a, i) => {
    const s = shop(a)
    add({
      doc: base(a.countryCode!, a.name!, `man${i}@mail.example`, {
        order: false,
        address: invoiceText(s, Boolean(a.company)),
      }),
      contactAddress: copyOf(s, null),
    })
  })

  // G. No order and no contact: only the invoice text (multiline, US order, one comma line).
  add({
    doc: base("FR", "Yanis Robert", "g0@mail.example", {
      contact: false,
      order: false,
      address: "50 rue des Trois Rois\n44000 NANTES",
    }),
  })
  add({
    doc: base("US", "Harbor Sound LLC", "g1@mail.example", {
      contact: false,
      order: false,
      address: "250 W 57th St\nNew York, NY 10019",
    }),
  })
  add({
    doc: base("NO", "Fjord Audio", "g2@mail.example", {
      contact: false,
      order: false,
      address: "Industriveien 4, 4879, Grimstad",
    }),
  })
  add({ doc: base("FR", "Sans Adresse", null, { contact: false, order: false, address: null }) })

  // H. The order has no shipping address; the customer default is on the order and the contact
  // copy came from it.
  const defaults: GoldenShopifyAddress[] = [
    {
      name: "Iris Moulin",
      address1: "11 rue Pasteur",
      city: "Dijon",
      zip: "21000",
      countryCode: "FR",
      phone: "+33644440001",
    },
    {
      name: "Felix Braun",
      address1: "Hafenstrasse 8",
      city: "Hamburg",
      zip: "20459",
      countryCode: "DE",
      phone: "+4917044400002",
    },
    {
      name: "Sofia Rossi",
      address1: "Via Dante 3",
      city: "Bologna",
      zip: "40125",
      countryCode: "IT",
      phone: "+393334440003",
    },
  ]
  defaults.forEach((a, i) => {
    const email = `def${i}@mail.example`
    const s = shop(a)
    add({
      doc: base(a.countryCode!, a.name!, email, { address: invoiceText(s) }),
      contactAddress: i === 2 ? undefined : copyOf(s, email),
      order: { shippingAddress: null, customerAddress: s, email },
    })
  })

  // I. North America: a state on the order and on the copy, or only on the invoice text.
  const us1 = shop({
    name: "Grace Lee",
    address1: "1200 Market St",
    city: "Philadelphia",
    zip: "19107",
    countryCode: "US",
    phone: "+12155550101",
    province: "Pennsylvania",
    provinceCode: "PA",
  })
  add({
    doc: base("US", "Grace Lee", "us0@mail.example", {
      address: "1200 Market St\n19107 Philadelphia, Pennsylvania",
    }),
    contactAddress: copyOf(us1, "us0@mail.example"),
    order: { shippingAddress: us1, email: "us0@mail.example" },
  })
  const us2 = shop({
    name: "Owen Clark",
    address1: "11418 Richmond Hill",
    city: "New York",
    zip: "10001",
    countryCode: "US",
    phone: "+12125550102",
  })
  add({
    doc: base("US", "Owen Clark", "us1@mail.example", {
      order: false,
      address: "11418 Richmond Hill\n10001 New York, New York",
    }),
    contactAddress: copyOf(us2, null),
  })
  const ca = shop({
    name: "Chloe Tremblay",
    address1: "500 Rue Sherbrooke O",
    city: "Montreal",
    zip: "H3A 3G6",
    countryCode: "CA",
    phone: "+15145550103",
    province: "Quebec",
    provinceCode: "QC",
  })
  add({
    doc: base("CA", "Chloe Tremblay", "ca0@mail.example", { address: invoiceText(ca) }),
    order: { shippingAddress: ca, email: "ca0@mail.example" },
    cachedShipTo: true,
  })

  // J. Order-less proformas (return after repair) with a recipient typed into the prep grid.
  add({
    doc: base("FR", "Bastien Roux", "j0@mail.example", {
      order: false,
      contact: false,
      address: "8 chemin des Vignes\n84000 Avignon",
    }),
    prepRecipient: {
      name: "Bastien Roux",
      street: "8 chemin des Vignes",
      city: "Avignon",
      postalCode: "84000",
      countryIsoCode: "FR",
      phone: "+33655550001",
    },
  })
  add({
    doc: base("DE", "Tonstudio Nord", "j1@mail.example", {
      order: false,
      address: "Kaiserstr. 2\n24103 Kiel",
    }),
    contactAddress: {
      name: "Tonstudio Nord",
      street: "Kaiserstrasse 2",
      city: "Kiel",
      postalCode: "24103",
      countryIsoCode: "DE",
      phone: "+49431110002",
    },
    prepRecipient: {
      name: "Tonstudio Nord",
      street: "Kaiserstr. 2",
      city: "Kiel",
      postalCode: "24103",
      countryIsoCode: "DE",
    },
  })
  add({
    doc: base("GB", "Ivy Turner", "j2@mail.example", {
      order: false,
      contact: false,
      address: null,
    }),
    prepRecipient: {
      name: "Ivy Turner",
      street: "22 Baker Street",
      city: "London",
      postalCode: "NW1 6XE",
      countryIsoCode: "GB",
      phone: "+447700900003",
    },
  })

  // K. Unverified address-book rows only (the legacy copy backfilled into the book, or a typed
  // address), never verified: the draft ignores them.
  const bk = shop({
    name: "Noah Dubois",
    address1: "7 rue Colbert",
    city: "Reims",
    zip: "51100",
    countryCode: "FR",
    phone: "+33666660001",
  })
  add({
    doc: base("FR", "Noah Dubois", "k0@mail.example", { address: invoiceText(bk) }),
    contactAddress: copyOf(bk, "k0@mail.example"),
    order: { shippingAddress: bk, email: "k0@mail.example" },
    book: [
      {
        role: "delivery",
        street1: "7 rue Colbert",
        city: "Reims",
        postalCode: "51100",
        countryIso2: "FR",
        origin: "legacy_metadata",
      },
    ],
  })
  add({
    doc: base("FR", "Alice Perrin", "k1@mail.example", {
      order: false,
      address: "40 rue Faidherbe\n59800 Lille",
    }),
    book: [
      {
        role: "delivery",
        street1: "1 place du Theatre",
        city: "Lille",
        postalCode: "59000",
        countryIso2: "FR",
        origin: "manual",
      },
    ],
  })

  // L. The documented change: a B2B customer whose copied contact address is ANOTHER site (the
  // customer's default address, copied by an earlier sync) while this order ships elsewhere.
  const b2b: Array<[GoldenShopifyAddress, GoldenShopifyAddress]> = [
    [
      {
        name: "Lena Brandt",
        company: "Werkton Distribution GmbH",
        address1: "Werkstr. 6",
        city: "Remagen",
        zip: "53424",
        countryCode: "DE",
        phone: null,
      },
      {
        name: "Paul Rehm",
        address1: "Fliederstrasse 7",
        city: "Remagen",
        zip: "53424",
        countryCode: "DE",
        phone: "+4915100000001",
      },
    ],
    [
      {
        name: "Receiving",
        company: "Sonora Pro BV",
        address1: "Havenweg 12",
        city: "Rotterdam",
        zip: "3011 AB",
        countryCode: "NL",
        phone: "+31101110002",
      },
      {
        name: "Joost Smit",
        company: "Sonora Pro BV",
        address1: "Kantoorlaan 1",
        city: "Delft",
        zip: "2611 AA",
        countryCode: "NL",
        phone: "+31151110002",
      },
    ],
    [
      {
        name: "Magasin",
        company: "Audio Sud SAS",
        address1: "ZA des Pins, lot 4",
        city: "Montpellier",
        zip: "34000",
        countryCode: "FR",
        phone: "+33467110003",
      },
      {
        name: "Compta",
        company: "Audio Sud SAS",
        address1: "12 avenue de la Gare",
        city: "Nimes",
        zip: "30000",
        countryCode: "FR",
        phone: "+33466110003",
      },
    ],
  ]
  b2b.forEach(([orderAddr, copied], i) => {
    const email = `b2b${i}@mail.example`
    const o = shop(orderAddr)
    add({
      doc: base(orderAddr.countryCode!, orderAddr.company!, email, {
        address: invoiceText(shop(copied), true),
      }),
      contactAddress: copyOf(shop(copied), email),
      order: { shippingAddress: o, customerAddress: shop(copied), email },
      cachedShipTo: i !== 1,
      orderBeatsContactCopy: true,
    })
  })
  // The same, with an old copy that has no phone (the field-by-field merge used to mix it).
  const oldCopy = shop({
    name: "Store",
    company: "Bergklang AG",
    address1: "Seestrasse 50",
    city: "Luzern",
    zip: "6003",
    countryCode: "CH",
    phone: "+41411110004",
  })
  add({
    doc: base("CH", "Bergklang AG", "b2b3@mail.example", { address: invoiceText(oldCopy, true) }),
    contactAddress: {
      name: "Bergklang AG",
      street: "Postfach 12",
      city: "Luzern",
      postalCode: "6002",
      countryIsoCode: "CH",
      phone: null,
    },
    order: { shippingAddress: oldCopy, email: "b2b3@mail.example" },
    orderBeatsContactCopy: true,
  })

  return cases
}

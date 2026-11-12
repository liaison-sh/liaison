// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure UI-logic tests for the standalone surfaces (bun:test, no jsdom). Pins
// that each component module imports cleanly under the host shim and that the
// extracted pure helpers cover their branches.
import { describe, expect, it } from "bun:test"
import { AddShipmentPanel, catalogOptionsFrom, missingRecipientFields } from "./AddShipmentPanel"
import { Catalog, profileHasWeight } from "./Catalog"
import { CreateDraft, canSubmit, recipientAddressComplete } from "./CreateDraft"
import { openPreparingTab } from "./file-open"
import { BoxtalAppIcon } from "./icon"
import { formatQueueDate, formatQueueParcels, formatQueueTimestamp } from "./kit"
import { PrepGrid } from "./PrepGrid"
import { resolveQueueId } from "./Queues"
import { printPackSummary } from "./ReadyRows"
import {
  matchesStatusFilter,
  resolveSelectedShipmentId,
  resolveStatusFilter,
  ShipmentDetailPanel,
  Shipments,
  shipmentColumns,
  shipmentsHrefForStatus,
} from "./Shipments"
import { isActive } from "./sidebar"

describe("standalone surfaces import cleanly as Components", () => {
  it("every surface is a function component", () => {
    for (const c of [
      Catalog,
      CreateDraft,
      Shipments,
      ShipmentDetailPanel,
      BoxtalAppIcon,
      PrepGrid,
      AddShipmentPanel,
    ]) {
      expect(typeof c).toBe("function")
    }
  })

  it("the shared bearer file open imports without a DOM", () => {
    expect(typeof openPreparingTab).toBe("function")
  })
})

describe("AddShipmentPanel: what the label still needs", () => {
  const full = {
    name: "Repair Owner",
    company: "",
    email: "owner@example.com",
    phone: "",
    street: "9 rue Neuve",
    city: "Nantes",
    postalCode: "44000",
    countryIsoCode: "FR",
  }

  it("is satisfied by name, street, city, postal code, country and email", () => {
    expect(missingRecipientFields(full)).toEqual([])
  })

  it("names each missing field in the operator's words, in the order they are asked for", () => {
    expect(missingRecipientFields({ ...full, city: "", countryIsoCode: "" })).toEqual([
      "city",
      "country",
    ])
    expect(missingRecipientFields({ ...full, name: "  " })).toEqual(["name"])
  })

  // Email is required (not just a nicety): invoicing refuses to issue the row's proforma without
  // one (counterpartyCompletenessError), so a submit that reached the server without it used to
  // fail with an opaque 500 instead of a disabled button naming the reason.
  it("names email as missing when blank, so the proforma issuer's own requirement surfaces before submit", () => {
    expect(missingRecipientFields({ ...full, email: "" })).toEqual(["email"])
    expect(missingRecipientFields({ ...full, email: "   " })).toEqual(["email"])
  })
})

// Add shipment used to offer only a free-text "Catalog reference" input, with no read of the
// catalog at all: a typed reference that did not match a shipping profile exactly left the row
// needing a fix, and the operator had no way to see what would actually resolve. catalogOptionsFrom
// is the pure shaping step behind the new item picker's <select> options.
describe("catalogOptionsFrom: packages_list shaped into pickable item options", () => {
  it("turns shipping profiles into options keyed by product_source:product_id", () => {
    const opts = catalogOptionsFrom({
      profiles: [{ product_source: "shopify", product_id: "SKU-1", short_code: "ES" }],
    })
    expect(opts).toEqual([
      { value: "shopify:SKU-1", product_source: "shopify", product_id: "SKU-1", label: "ES" },
    ])
  })

  it("falls back to the key itself as the label when a profile has no short_code", () => {
    const opts = catalogOptionsFrom({
      profiles: [{ product_source: "shopify", product_id: "SKU-2" }],
    })
    expect(opts[0]!.label).toBe("shopify:SKU-2")
  })

  it("turns local products into local: options labelled by name", () => {
    const opts = catalogOptionsFrom({ local_products: [{ sku: "RAL-44", label: "Hard Cover" }] })
    expect(opts).toEqual([
      { value: "local:RAL-44", product_source: "local", product_id: "RAL-44", label: "Hard Cover" },
    ])
  })

  it("a local product's human label wins over a bare profile for the same source:id", () => {
    const opts = catalogOptionsFrom({
      profiles: [{ product_source: "local", product_id: "RAL-44" }],
      local_products: [{ sku: "RAL-44", label: "Hard Cover" }],
    })
    expect(opts).toHaveLength(1)
    expect(opts[0]!.label).toBe("Hard Cover")
  })

  it("sorts by label and skips entries with no usable id", () => {
    const opts = catalogOptionsFrom({
      profiles: [
        { product_source: "shopify", product_id: "Z9", short_code: "ZZ" },
        { product_source: "shopify", product_id: null },
      ],
      local_products: [
        { sku: "A1", label: "AA Widget" },
        { sku: null, label: "no sku" },
      ],
    })
    expect(opts.map((o) => o.label)).toEqual(["AA Widget", "ZZ"])
  })

  it("is empty for an empty or missing response", () => {
    expect(catalogOptionsFrom(undefined)).toEqual([])
    expect(catalogOptionsFrom({})).toEqual([])
  })
})

describe("profileHasWeight", () => {
  it("true only for a positive unit_weight", () => {
    expect(profileHasWeight({ unit_weight: 1 })).toBe(true)
    expect(profileHasWeight({ unit_weight: 0 })).toBe(false)
    expect(profileHasWeight({ unit_weight: null })).toBe(false)
  })
})

describe("canSubmit", () => {
  const ok = {
    document_ref: "d",
    parcels: [],
    customsArticles: [{ description: "x", quantity: 1, unitWeight: 1, tariffNumber: "1" }],
    unresolved: [],
    recipient: "",
    route: "",
  }
  it("requires a draft + offer + no unresolved + no blocked", () => {
    expect(canSubmit(ok as any, "CHRP-Chrono18")).toBe(true)
    expect(canSubmit(ok as any, null)).toBe(false)
    expect(canSubmit(null, "CHRP-Chrono18")).toBe(false)
    expect(canSubmit({ ...ok, unresolved: [{ reason: "no_profile" }] } as any, "x")).toBe(false)
    expect(
      canSubmit(
        { ...ok, customsArticles: [{ ...ok.customsArticles[0], blocked: true }] } as any,
        "x",
      ),
    ).toBe(false)
  })

  it("with a recipient arg, requires a complete recipient address (B1)", () => {
    const full = {
      name: "Acme",
      phone: "+12125550100",
      email: "",
      street: "350 5th Ave",
      city: "New York",
      postalCode: "10118",
      countryIsoCode: "US",
    }
    expect(canSubmit(ok as any, "CHRP-Chrono18", full)).toBe(true)
    expect(canSubmit(ok as any, "CHRP-Chrono18", { ...full, phone: "" })).toBe(false)
    expect(canSubmit(ok as any, "CHRP-Chrono18", { ...full, street: "" })).toBe(false)
  })
})

describe("recipientAddressComplete", () => {
  const full = {
    name: "Acme",
    phone: "+12125550100",
    email: "",
    street: "350 5th Ave",
    city: "New York",
    postalCode: "10118",
    countryIsoCode: "US",
  }
  it("true only when name/phone/street/city/postal/country are all present", () => {
    expect(recipientAddressComplete(full)).toBe(true)
    for (const k of ["name", "phone", "street", "city", "postalCode", "countryIsoCode"] as const) {
      expect(recipientAddressComplete({ ...full, [k]: "  " })).toBe(false)
    }
    // email is optional.
    expect(recipientAddressComplete({ ...full, email: "" })).toBe(true)
  })
})

describe("resolveSelectedShipmentId (master/detail default)", () => {
  const rows = [{ id: "s1" }, { id: "s2" }] as Parameters<typeof resolveSelectedShipmentId>[1]
  it("defaults to the first visible row when nothing is explicitly selected", () => {
    expect(resolveSelectedShipmentId(null, rows)).toBe("s1")
  })
  it("honours an explicit selection over the default", () => {
    expect(resolveSelectedShipmentId("s2", rows)).toBe("s2")
  })
  it("is null when the list is empty (shows the empty state, not a stale detail)", () => {
    expect(resolveSelectedShipmentId(null, [])).toBe(null)
  })
})

describe("resolveStatusFilter (the sidebar's In transit / Delivered links)", () => {
  // The sidebar navigates to /boxtal/shipments?status=<filter>, but the tab is a
  // singleton pinned to the bare /boxtal/shipments pattern -- nothing re-mounts
  // it. A local filter signal therefore ignored both links and rendered the
  // unfiltered list, which is what made those rows look dead.
  it("reads the status the sidebar links carry", () => {
    expect(resolveStatusFilter("/boxtal/shipments?status=delivered")).toBe("delivered")
    expect(resolveStatusFilter("/boxtal/shipments?status=in-transit")).toBe("in-transit")
  })
  it("falls back to all for the bare list URL", () => {
    expect(resolveStatusFilter("/boxtal/shipments")).toBe("all")
    expect(resolveStatusFilter(undefined)).toBe("all")
  })
  it("ignores an unknown status rather than filtering everything out", () => {
    // A hand-typed or stale URL must not render an empty list with no way back.
    expect(resolveStatusFilter("/boxtal/shipments?status=bogus")).toBe("all")
    expect(resolveStatusFilter("/boxtal/shipments?status=")).toBe("all")
  })
  it("finds status among other query params, in any position", () => {
    expect(resolveStatusFilter("/boxtal/shipments?q=acme&status=delivered")).toBe("delivered")
    expect(resolveStatusFilter("/boxtal/shipments?status=delivered&q=acme")).toBe("delivered")
  })
  it("does not confuse another tab's URL for a status", () => {
    expect(resolveStatusFilter("/boxtal/queue/ready")).toBe("all")
  })
})

describe("sidebar isActive (one active row at a time)", () => {
  it("lights only the matching query-scoped row on a filtered shipments URL", () => {
    const path = "/boxtal/shipments?status=delivered"
    expect(isActive(path, "/boxtal/shipments?status=delivered")).toBe(true)
    // Field regression 2026-08-04: "All shipments" highlighted together with
    // "Delivered" because the bare href matched through the stripped query.
    expect(isActive(path, "/boxtal/shipments")).toBe(false)
    expect(isActive(path, "/boxtal/shipments?status=in-transit")).toBe(false)
  })
  it("lights the bare All shipments row only on the bare URL", () => {
    expect(isActive("/boxtal/shipments", "/boxtal/shipments")).toBe(true)
    expect(isActive("/boxtal/shipments", "/boxtal/shipments?status=delivered")).toBe(false)
  })
  it("still matches sub-paths for bare rows", () => {
    expect(isActive("/boxtal/queue/to-prepare", "/boxtal/queue/to-prepare")).toBe(true)
    expect(isActive("/boxtal/catalog/packs", "/boxtal/catalog")).toBe(true)
  })
})

describe("shipmentsHrefForStatus", () => {
  it("drops the param for all so the sidebar's All shipments row stays active", () => {
    expect(shipmentsHrefForStatus("all")).toBe("/boxtal/shipments")
  })
  it("round-trips every filter through resolveStatusFilter", () => {
    for (const f of ["all", "in-transit", "delivered"] as const) {
      expect(resolveStatusFilter(shipmentsHrefForStatus(f))).toBe(f)
    }
  })
  it("emits exactly the hrefs the sidebar links use", () => {
    // Pins the two surfaces together: if either side's URL shape drifts, the
    // links go dead again silently.
    expect(shipmentsHrefForStatus("in-transit")).toBe("/boxtal/shipments?status=in-transit")
    expect(shipmentsHrefForStatus("delivered")).toBe("/boxtal/shipments?status=delivered")
  })
})

describe("matchesStatusFilter", () => {
  const row = (tracking: string | null) =>
    ({ id: "s1", title: "t", attributes: { tracking_status: tracking } }) as Parameters<
      typeof matchesStatusFilter
    >[0]
  it("delivered matches only DELIVERED", () => {
    expect(matchesStatusFilter(row("DELIVERED"), "delivered")).toBe(true)
    expect(matchesStatusFilter(row("IN_TRANSIT"), "delivered")).toBe(false)
    expect(matchesStatusFilter(row(null), "delivered")).toBe(false)
  })
  it("in-transit spans the three moving states", () => {
    for (const t of ["SHIPPED", "IN_TRANSIT", "OUT_FOR_DELIVERY"]) {
      expect(matchesStatusFilter(row(t), "in-transit")).toBe(true)
    }
    expect(matchesStatusFilter(row("DELIVERED"), "in-transit")).toBe(false)
  })
  it("all keeps every row, including untracked ones", () => {
    expect(matchesStatusFilter(row(null), "all")).toBe(true)
    expect(matchesStatusFilter(row("EXCEPTION"), "all")).toBe(true)
  })
})

describe("resolveQueueId (queue tab routing)", () => {
  // Regression x2: (1) props.queueId is never passed by the tab framework;
  // (2) the singleton tab's entityId is frozen at first open and nothing
  // updates it on in-tab sidebar navigation. The REACTIVE pathname is the
  // source of truth; props are fallbacks only.
  it("reads the queue from the live pathname first", () => {
    expect(resolveQueueId("/boxtal/queue/ready", "to-prepare")).toBe("ready")
    expect(resolveQueueId("/boxtal/queue/to-prepare", "ready")).toBe("to-prepare")
    expect(resolveQueueId("/boxtal/queue/ready?x=1", undefined)).toBe("ready")
  })
  it("falls back to entityId then queueId when the URL is not a queue route", () => {
    expect(resolveQueueId("/boxtal/shipments", "ready")).toBe("ready")
    expect(resolveQueueId(undefined, "ready")).toBe("ready")
    expect(resolveQueueId(undefined, undefined, "to-prepare")).toBe("to-prepare")
  })
})

describe("formatQueueDate (the shared worklist date column)", () => {
  it("formats a real ISO date", () => {
    expect(formatQueueDate("2026-08-21T08:00:00.000Z")).toBe(
      new Date("2026-08-21T08:00:00.000Z").toLocaleDateString(),
    )
  })

  it('renders a dash for a missing or unparseable date, never "Invalid Date"', () => {
    expect(formatQueueDate(null)).toBe("-")
    expect(formatQueueDate(undefined)).toBe("-")
    expect(formatQueueDate("")).toBe("-")
    expect(formatQueueDate("not-a-date")).toBe("-")
  })
})

describe("formatQueueTimestamp (the shared request timestamp: the queues sort key)", () => {
  it("shows the TIME as well as the day, so same-day rows read in their queue order", () => {
    const out = formatQueueTimestamp("2026-09-14T13:42:39.000Z")
    expect(out).toContain(new Date("2026-09-14T13:42:39.000Z").toLocaleDateString())
    expect(out.split(" ").length).toBeGreaterThan(1)
  })

  it("parses the Postgres timestamp shape (space separator), which Safari rejects natively", () => {
    expect(formatQueueTimestamp("2026-09-14 13:42:39.878342+00")).not.toBe("-")
  })

  it("renders a dash for a missing or unparseable value", () => {
    expect(formatQueueTimestamp(null)).toBe("-")
    expect(formatQueueTimestamp("nope")).toBe("-")
  })
})

describe("printPackSummary (two separate print jobs, copy count spelled out)", () => {
  it("names both jobs with the export copy count", () => {
    const s = printPackSummary({
      label: { file_id: "f1", filename: "label-TRK.pdf" },
      invoice: { file_id: "f2", copies: 3, reason: "export_non_eu" },
    })
    expect(s).toContain("Label: opened (label printer)")
    expect(s).toContain("print 3 copies on A4")
    expect(s).toContain("export outside EU")
  })
  it("EU route reads 1 copy", () => {
    const s = printPackSummary({
      label: { file_id: "f1", filename: "l.pdf" },
      invoice: { file_id: "f2", copies: 1, reason: "eu_or_domestic" },
    })
    expect(s).toContain("print 1 copy on A4")
    expect(s).toContain("EU or domestic")
  })
  it("surfaces label and invoice failures readably, and errors verbatim", () => {
    const s = printPackSummary({
      label: null,
      label_error: "Label not available yet.",
      invoice: { file_id: null, copies: 3, reason: "export_non_eu" },
      invoice_error: "No rendered PDF",
    })
    expect(s).toContain("Label: Label not available yet.")
    expect(s).toContain("Invoice: No rendered PDF")
    expect(
      printPackSummary({
        label: null,
        invoice: { file_id: null, copies: 3, reason: "export_non_eu" },
        error: { code: "not_found", message: "No shipment row matches" },
      }),
    ).toBe("No shipment row matches")
  })
})

// The desktop list cut the declared value mid-number ("918.0", "3 988.0") and
// showed the Order and Tracking headers over empty cells: five columns squeezed
// alike inside the narrow master pane. The atoms take their own width now.
describe("shipmentColumns: an atom takes its own width", () => {
  const byKey = () => new Map(shipmentColumns().map((c) => [c.key, c]))

  it("declares every column the header promises", () => {
    expect([...byKey().keys()]).toEqual([
      "recipient",
      "carrier",
      "value",
      "order-status",
      "tracking-status",
    ])
  })

  it("fits the value column, with tabular figures, so a number is never cut", () => {
    const value = byKey().get("value")
    expect(value?.numeric).toBe(true)
    expect(value?.fit).toBe(true)
    expect(value?.align).toBe("right")
  })

  it("fits the Order and Tracking columns so their badges are never squeezed to nothing", () => {
    expect(byKey().get("order-status")?.fit).toBe(true)
    expect(byKey().get("tracking-status")?.fit).toBe(true)
  })

  it("leaves the recipient column free to absorb the remaining width", () => {
    const recipient = byKey().get("recipient")
    expect(recipient?.role).toBe("anchor")
    expect(recipient?.fit).toBeUndefined()
  })
})

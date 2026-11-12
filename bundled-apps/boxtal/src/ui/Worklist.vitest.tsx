// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shipping worklist, rendered: ONE table of every state, a background refresh updates rows in place (same DOM nodes, no
// loading state, no suspended tab), and a To prepare row shows the shipping the customer paid
// beside the carrier quote. Synthetic data only.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createResource, Suspense } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ── host mock: Solid's own createResource, its refetch kept so a test can play the host's resync ──
const refetchers: Array<() => unknown> = []
type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void }
function deferred(): Deferred {
  let resolve!: (v: unknown) => void
  const promise = new Promise<unknown>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
// When set, the next list read waits on it (so a test can look at the screen mid-refresh).
let gate: Deferred | null = null
let readyRows: () => unknown[] = () => []
let prepRows: () => unknown[] = () => []
const invoked: Array<{ name: string; args: Record<string, unknown> }> = []

vi.mock("@liaison/host", () => ({
  currentPath: () => "/boxtal/queue/worklist",
  navigate: () => {},
  accessToken: () => null,
  getContext: () => ({ orgId: "org-test" }),
  fetch: () => Promise.reject(new Error("no fetch")),
  hostLocale: () => "en",
  fetchBlob: () => Promise.reject(new Error("no blob")),
  openFile: () => {},
  app: {
    createResource: (fetcher: () => Promise<unknown>) => {
      const res = createResource(fetcher)
      refetchers.push(() => res[1].refetch())
      return res
    },
    listMyApprovals: () => Promise.resolve([]),
    listDocumentTemplates: () => Promise.resolve([]),
    printDocuments: () => Promise.reject(new Error("no print")),
    opensFiles: () => false,
    openFile: async () => false,
    trackOpenRecord: () => {},
    invokeTool: async (name: string, args: Record<string, unknown> = {}) => {
      invoked.push({ name, args })
      const wait = gate
      if (name === "ready_list") {
        if (wait) await wait.promise
        return { rows: readyRows() }
      }
      if (name === "prep_list") {
        if (wait && !args.order_keys) await wait.promise
        const all = prepRows() as Array<{ order_key: string }>
        const keys = args.order_keys as string[] | undefined
        return {
          rows: keys ? all.filter((r) => keys.includes(r.order_key)) : all,
          total: all.length,
          last_sync_at: "2026-11-09T08:00:00.000Z",
          truncated: false,
          last_sync_error: null,
          invoicing_available: true,
        }
      }
      if (name === "prep_select_offer") return { ok: true }
      throw new Error(`no ${name}`)
    },
  },
}))

const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

function readyRow(id: string) {
  return {
    id,
    recipient: `Recipient ${id}`,
    carrier: "UPSE-Standard",
    tracking_number: null,
    cost: 9,
    order_status: "CONFIRMED",
    has_label: true,
    invoice_ref: null,
    shipment_ref: null,
    destination: "FR",
    status: null,
    packed: false,
    packed_at: null,
    fulfillment_state: null,
    fulfillment_error: null,
    attention: null,
    requested_at: null,
    order_name: `#${id}`,
    order_created_at: null,
    category: null,
    items: null,
    products: null,
    weight: null,
    package_count: null,
    parcels: [],
  }
}

function offer(code: string, carrier: string, priceMinor: number) {
  return {
    carrier,
    service: `${carrier} Standard`,
    currency: "EUR",
    offer_code: code,
    delivery_date: null,
    price_ht_minor: priceMinor,
    price_ttc_minor: priceMinor,
    is_pickup_point: false,
    eta_business_days: 2,
  }
}

function prepRow(key: string, extra: Record<string, unknown> = {}) {
  const offers = [offer("CHEAP-1", "FedEx", 7990), offer("FAST-2", "UPS", 9836)]
  return {
    order_key: key,
    document_ref: `doc-${key}`,
    anchor_kind: "invoice",
    invoice_ref: `INV-${key}`,
    order_name: `#${key}`,
    order_created_at: "2026-11-01T10:00:00Z",
    customer: `Customer ${key}`,
    destination: "US",
    order_tags: [],
    products: "1xAA",
    grand_total_minor: 120000,
    currency: "USD",
    customer_shipping_minor: 4550,
    customer_shipping_currency: "USD",
    parcels: [{ width: 20, height: 10, length: 30, weight: 2 }],
    package_count: 1,
    category: "sale",
    status: "to_prepare",
    status_note: null,
    staff_note: null,
    quote: {
      cheapest: offers[0],
      alternates: [offers[1]],
      offers,
      selected_offer_code: null,
      selected: null,
      quoted_at: "2026-11-09T08:00:00Z",
      stale: false,
    },
    state: "ready",
    excluded: false,
    validated: false,
    invoice: {
      state: "issued",
      document_id: `doc-${key}`,
      number: `INV-${key}`,
      approval_id: null,
      kind: "invoice",
    },
    shipment: null,
    recipient: null,
    ...extra,
  }
}

beforeEach(() => {
  refetchers.length = 0
  invoked.length = 0
  gate = null
  try {
    localStorage.clear()
  } catch {
    // no storage: the grid falls back to an inert one
  }
})
afterEach(() => cleanup())

describe("Bought labels background refresh", () => {
  it("keeps the row DOM nodes and never suspends the tab while it refreshes", async () => {
    // Every read returns NEW objects with the same data, as the real tool does.
    readyRows = () => [readyRow("1"), readyRow("2")]
    prepRows = () => []
    const { ShippingWorklist } = await import("./Queues")
    render(() => (
      <Suspense fallback={<div data-testid="tab-suspended" />}>
        <ShippingWorklist initialFilter="all" />
      </Suspense>
    ))
    await flush()
    const before = screen.getByTestId("boxtal-ready-country-1")
    const beforeRow = screen.getByTestId("boxtal-ready-row-1")
    expect(screen.queryByTestId("tab-suspended")).toBeNull()

    gate = deferred()
    // The bought labels' read is the worklist's first resource (created before the table's).
    void refetchers[0]!() // the host's resync / the minute timer / window focus
    await flush()
    // Mid-refresh: the rows are still on screen, nothing suspended, nothing blanked.
    expect(screen.queryByTestId("tab-suspended")).toBeNull()
    expect(screen.getByTestId("boxtal-ready-country-1")).toBe(before)

    gate.resolve(undefined)
    gate = null
    await flush()
    // Landed: unchanged rows are the very same elements.
    expect(screen.getByTestId("boxtal-ready-country-1")).toBe(before)
    expect(screen.getByTestId("boxtal-ready-row-1")).toBe(beforeRow)
  })
})

describe("To prepare background refresh", () => {
  it("keeps the row DOM nodes and shows no loading or refreshing banner once read live", async () => {
    prepRows = () => [prepRow("1001"), prepRow("1002")]
    const { PrepGrid } = await import("./PrepGrid")
    render(() => (
      <Suspense fallback={<div data-testid="tab-suspended" />}>
        <PrepGrid />
      </Suspense>
    ))
    await flush()
    const before = screen.getByTestId("boxtal-prep-estimate-1001")
    expect(screen.queryByTestId("boxtal-prep-refresh-banner")).toBeNull()

    gate = deferred()
    void refetchers.at(-1)!() // the host's resync / a stale tab coming back into view
    await flush()
    expect(screen.queryByTestId("tab-suspended")).toBeNull()
    expect(screen.queryByTestId("boxtal-prep-grid-loading")).toBeNull()
    expect(screen.queryByTestId("boxtal-prep-refresh-banner")).toBeNull()
    expect(screen.getByTestId("boxtal-prep-estimate-1001")).toBe(before)

    gate.resolve(undefined)
    gate = null
    await flush()
    expect(screen.getByTestId("boxtal-prep-estimate-1001")).toBe(before)
  })
})

describe("To prepare: what the customer paid for shipping", () => {
  it("shows the order's paid shipping beside the quote, and keeps it after another offer is picked", async () => {
    let selected: string | null = null
    prepRows = () => {
      const row = prepRow("2001")
      if (selected) {
        const q = row.quote as {
          offers: Array<{ offer_code: string }>
          selected: unknown
          selected_offer_code: string | null
        }
        q.selected_offer_code = selected
        q.selected = q.offers.find((o) => o.offer_code === selected) ?? null
      }
      return [
        row,
        prepRow("2002", { customer_shipping_minor: null, customer_shipping_currency: null }),
      ]
    }
    const { PrepGrid } = await import("./PrepGrid")
    render(() => <PrepGrid />)
    await flush()

    const paid = screen.getByTestId("boxtal-prep-estimate-2001-paid")
    expect(paid.textContent).toBe("Paid 45.50 USD")
    expect(paid.className).toContain("text-blue-500")
    // Next to the quote it compares with, in the same cell.
    expect(screen.getByTestId("boxtal-prep-estimate-2001").textContent).toContain("79.90 EUR")
    // No shipping line known: nothing is invented.
    expect(screen.queryByTestId("boxtal-prep-estimate-2002-paid")).toBeNull()

    selected = "FAST-2"
    const select = screen.getByTestId("boxtal-prep-estimate-2001-offer-select") as HTMLSelectElement
    select.value = "FAST-2"
    fireEvent.change(select)
    await flush(8)
    expect(invoked.some((c) => c.name === "prep_select_offer")).toBe(true)
    expect(screen.getByTestId("boxtal-prep-estimate-2001").textContent).toContain("98.36 EUR")
    expect(screen.getByTestId("boxtal-prep-estimate-2001-paid").textContent).toBe("Paid 45.50 USD")
  })
})

describe("One shipping worklist", () => {
  const packedRow = () => ({ ...readyRow("32"), packed: true, fulfillment_state: "fulfilled" })

  it("All renders ONE table holding the rows of every state, each with a State cell", async () => {
    prepRows = () => [prepRow("3001")]
    readyRows = () => [readyRow("31"), packedRow()]
    const { ShippingWorklist } = await import("./Queues")
    render(() => <ShippingWorklist initialFilter="all" />)
    await flush(8)

    const tables = screen.getAllByRole("table")
    expect(tables).toHaveLength(1)
    const table = tables[0]!
    // No second list with its own header.
    expect(screen.queryByTestId("boxtal-ready-to-ship")).toBeNull()
    const prep = screen.getByTestId("boxtal-prep-row-3001")
    const ready = screen.getByTestId("boxtal-ready-row-31")
    expect(table.contains(prep)).toBe(true)
    expect(table.contains(ready)).toBe(true)
    expect(table.contains(screen.getByTestId("boxtal-ready-row-32"))).toBe(true)
    expect(screen.getByTestId("boxtal-prep-state-3001").textContent).toBe("To prepare")
    expect(screen.getByTestId("boxtal-ready-state-31").textContent).toBe("Label bought")
    expect(screen.getByTestId("boxtal-ready-state-32").textContent).toBe("Packed, fulfilled")
    // States in workflow order: the order to prepare comes before the bought labels.
    expect(prep.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Each row keeps its own actions: the quote picking on the To prepare row, the packed tick on
    // the bought label.
    expect(screen.getByTestId("boxtal-prep-estimate-3001")).toBeTruthy()
    expect(screen.getByTestId("boxtal-ready-packed-31")).toBeTruthy()
  })

  it("the state filters narrow that one table", async () => {
    prepRows = () => [prepRow("3001")]
    readyRows = () => [readyRow("31"), packedRow()]
    const { ShippingWorklist } = await import("./Queues")
    render(() => <ShippingWorklist initialFilter="all" />)
    await flush(8)

    fireEvent.click(screen.getByTestId("boxtal-worklist-filter-packed"))
    await flush()
    expect(screen.getByTestId("boxtal-worklist-filter-packed").getAttribute("aria-pressed")).toBe(
      "true",
    )
    expect(screen.getByTestId("boxtal-worklist-filter-all").getAttribute("aria-pressed")).toBe(
      "false",
    )
    expect(screen.getByTestId("boxtal-worklist-filter-all").className).not.toContain(
      "bg-surface-active",
    )
    expect(screen.getAllByRole("table")).toHaveLength(1)
    expect(screen.queryByTestId("boxtal-prep-row-3001")).toBeNull()
    expect(screen.queryByTestId("boxtal-ready-row-31")).toBeNull()
    expect(screen.getByTestId("boxtal-ready-row-32")).toBeTruthy()

    fireEvent.click(screen.getByTestId("boxtal-worklist-filter-to_prepare"))
    await flush()
    expect(screen.getByTestId("boxtal-prep-row-3001")).toBeTruthy()
    expect(screen.queryByTestId("boxtal-ready-row-31")).toBeNull()
    expect(screen.queryByTestId("boxtal-ready-row-32")).toBeNull()
    // The counts still come from every bought label, whatever the filter.
    expect(screen.getByTestId("boxtal-worklist-filter-ready").textContent).toContain("2")
  })
})

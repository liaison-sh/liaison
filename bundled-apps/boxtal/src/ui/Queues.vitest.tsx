// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bought labels of the one shipping worklist, rendered: the Country column (ISO-2, name on hover), its sort and its filter, and
// the "tracking to confirm" row a label read could not settle.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"

function readyRow(id: string, destination: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    recipient: `Recipient ${id}`,
    carrier: "UPSE-StandardAP",
    tracking_number: null,
    cost: 9,
    order_status: "CONFIRMED",
    has_label: true,
    invoice_ref: null,
    shipment_ref: null,
    destination,
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
    ...extra,
  }
}

const ROWS = [
  readyRow("1", "US"),
  readyRow("2", "DE", { tracking_to_confirm: true }),
  readyRow("3", null),
  readyRow("4", "FR", { tracking_number: "1ZW4941Y0492530257" }),
]
// Row 1 needs one of the org's templates (a document rule matched it).
Object.assign(ROWS[0]!, {
  needed_template_ids: ["tpl-tsca"],
  attention: {
    rules: ["Plate to the US"],
    documents: [{ name: "TSCA certificate", note: null, template_id: "tpl-tsca" }],
    knowledge_refs: [],
    summary: "Needs: TSCA certificate (Plate to the US)",
  },
})

const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = []

const hostFetch = vi.fn((url: string) =>
  url.startsWith("/api/documents/templates")
    ? Promise.resolve([
        { id: "tpl-tsca", name: "TSCA certificate" },
        { id: "tpl-thanks", name: "Thank-you letter" },
      ])
    : Promise.reject(new Error("no fetch")),
)

vi.mock("@liaison/host", () => ({
  currentPath: () => "/boxtal/queue/ready",
  navigate: () => {},
  accessToken: () => null,
  getContext: () => ({ orgId: "org-test" }),
  fetch: (url: string) => hostFetch(url),
  hostLocale: () => "en",
  fetchBlob: () => Promise.reject(new Error("no blob")),
  openFile: () => {},
  app: {
    createResource: (fetcher: () => Promise<unknown>) => createResource(fetcher),
    // The page's path of the typed calls (no frame): straight to the kernel route.
    listDocumentTemplates: (entity: string) =>
      hostFetch(`/api/documents/templates?app=boxtal&entity=${entity}`),
    printDocuments: () => Promise.reject(new Error("no print")),
    listMyApprovals: () => Promise.resolve([]),
    trackOpenRecord: () => {},
    opensFiles: () => false,
    openFile: async () => false,
    invokeTool: (name: string, args: Record<string, unknown> = {}) => {
      toolCalls.push({ name, args })
      if (name === "ready_list") return Promise.resolve({ rows: ROWS })
      // No order to prepare: the table holds the bought labels alone.
      if (name === "prep_list") {
        return Promise.resolve({
          rows: [],
          total: 0,
          last_sync_at: "2026-11-09T08:00:00.000Z",
          truncated: false,
          last_sync_error: null,
          invoicing_available: true,
        })
      }
      if (name === "ready_set_packed") {
        return Promise.resolve({
          shipment_id: args.shipment_id,
          packed: true,
          packed_at: "2026-11-09T10:00:00.000Z",
          fulfillment_state: "fulfilled",
          fulfillment_error: null,
          tracking_number: args.tracking_number ?? null,
        })
      }
      return Promise.reject(new Error(`no ${name}`))
    },
  },
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

async function mount(filter: "all" | "packed" = "all") {
  const { ShippingWorklist } = await import("./Queues")
  render(() => <ShippingWorklist initialFilter={filter} />)
  for (let i = 0; i < 4; i++) await flush()
}

/** The ready rows' ids, in the order the table shows them. */
function shownOrder(): string[] {
  return screen.getAllByTestId(/^boxtal-ready-country-\d+$/).map((el) => el.getAttribute("data-testid")!.replace("boxtal-ready-country-", ""))
}

afterEach(() => cleanup())

describe("Bought labels: Country column", () => {
  it("shows each row's ISO-2 code with the country name on hover", async () => {
    await mount()
    const us = screen.getByTestId("boxtal-ready-country-1")
    expect(us.textContent).toBe("US")
    expect(us.getAttribute("title")).toBe("United States")
    expect(screen.getByTestId("boxtal-ready-country-3").textContent).toBe("-")
  })

  it("sorts by country (blank last), then descending, then back to the queue order", async () => {
    await mount()
    expect(shownOrder()).toEqual(["1", "2", "3", "4"])
    // The table's own Country sort orders the bought labels too.
    const sort = screen.getByTestId("boxtal-prep-sort-country")
    fireEvent.click(sort)
    expect(shownOrder()).toEqual(["2", "4", "1", "3"])
    fireEvent.click(sort)
    expect(shownOrder()).toEqual(["1", "4", "2", "3"])
    fireEvent.click(sort)
    expect(shownOrder()).toEqual(["1", "2", "3", "4"])
  })

  it("the table's country filter narrows the bought labels", async () => {
    await mount()
    const filter = screen.getByTestId("boxtal-prep-country") as HTMLSelectElement
    expect([...filter.options].map((o) => o.value)).toEqual(["", "DE", "FR", "US"])
    filter.value = "FR"
    fireEvent.change(filter)
    expect(shownOrder()).toEqual(["4"])
  })

  it("a row whose label read gave no number says tracking to confirm", async () => {
    await mount()
    expect(screen.getByTestId("boxtal-ready-tracking-to-confirm-2").textContent).toContain("Tracking to confirm")
    expect(screen.queryByTestId("boxtal-ready-tracking-to-confirm-1")).toBeNull()
  })

  it("a row with no tracking number to fulfil with offers to pack it with the number on the label", async () => {
    toolCalls.length = 0
    await mount()
    expect(screen.queryByTestId("boxtal-ready-typed-tracking-1")).toBeNull()
    const input = screen.getByTestId("boxtal-ready-typed-tracking-input-2") as HTMLInputElement
    fireEvent.input(input, { target: { value: "8777 4092 5574" } })
    fireEvent.click(screen.getByTestId("boxtal-ready-typed-tracking-submit-2"))
    await flush()
    await flush()
    expect(toolCalls.find((c) => c.name === "ready_set_packed")?.args).toEqual({
      shipment_id: "2",
      packed: true,
      tracking_number: "8777 4092 5574",
    })
    // Packed with its number: the field is gone.
    expect(screen.queryByTestId("boxtal-ready-typed-tracking-2")).toBeNull()
  })

  it("a filter with no match keeps the filters on screen and offers to clear them", async () => {
    // "Packed" with nothing packed yet: rows exist, none match.
    await mount("packed")
    expect(screen.queryByTestId("boxtal-ready-empty")).toBeNull()
    const filter = screen.getByTestId("boxtal-prep-country") as HTMLSelectElement
    expect(screen.getByTestId("boxtal-worklist-no-match").textContent).toContain("No rows match these filters")
    filter.value = "FR"
    fireEvent.change(filter)
    fireEvent.click(screen.getByTestId("boxtal-worklist-clear-filters"))
    expect(screen.getByTestId("boxtal-worklist-filter-all").getAttribute("aria-pressed")).toBe("true")
    expect((screen.getByTestId("boxtal-prep-country") as HTMLSelectElement).value).toBe("")
    expect(shownOrder()).toEqual(["1", "2", "3", "4"])
  })
})

describe("Bought labels: Print documents control", () => {
  it("each row's Documents fold carries the control, closed until opened (no template read per row)", async () => {
    hostFetch.mockClear()
    await mount()
    expect(screen.getByTestId("boxtal-print-documents-1-toggle")).toBeTruthy()
    expect(screen.getByTestId("boxtal-print-documents-4-toggle")).toBeTruthy()
    expect(screen.queryByTestId("boxtal-print-documents-1-panel")).toBeNull()
    expect(hostFetch).not.toHaveBeenCalled()
  })

  it("opening it lists the shipment's templates, the needed one pre-ticked and marked Needed", async () => {
    hostFetch.mockClear()
    await mount()
    fireEvent.click(screen.getByTestId("boxtal-print-documents-1-toggle"))
    await flush()
    await flush()
    expect(screen.getByTestId("boxtal-print-documents-1-panel")).toBeTruthy()
    expect(hostFetch).toHaveBeenCalledWith("/api/documents/templates?app=boxtal&entity=shipment")
    expect((screen.getByTestId("boxtal-print-documents-1-check-tpl-tsca") as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId("boxtal-print-documents-1-check-tpl-thanks") as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId("boxtal-print-documents-1-needed-tpl-tsca")).toBeTruthy()
    expect(screen.queryByTestId("boxtal-print-documents-1-needed-tpl-thanks")).toBeNull()
  })
})

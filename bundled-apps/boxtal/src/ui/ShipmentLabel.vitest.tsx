// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shipment detail's label Download. It rendered with no handler, so a click did nothing on any
// surface. Pinned: it asks print_pack for the upright label and hands the file to the host (the
// framed screen has no network of its own); a missing label says why; other documents show no
// dead button.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({ tools: [] as Array<{ name: string; args: unknown }>, opened: [] as string[], label: "f-label" as string | null }))

vi.mock("@liaison/host", () => ({
  currentPath: () => "/boxtal/shipments",
  fetchBlob: () => Promise.reject(new Error("framed: no fetch")),
  openFile: () => Promise.resolve(false),
  app: {
    trackOpenRecord: () => {},
    opensFiles: () => true,
    openFile: (fileId: string) => {
      calls.opened.push(fileId)
      return Promise.resolve(true)
    },
    invokeTool: (name: string, args: unknown) => {
      calls.tools.push({ name, args })
      if (name === "get_documents") return Promise.resolve({ documents: [{ type: "LABEL", format: "PDF" }, { type: "CN23", format: "PDF" }] })
      if (name === "print_pack") {
        return Promise.resolve(calls.label ? { label: { file_id: calls.label, filename: "label.pdf" } } : { label: null, label_error: "Boxtal has not served the label yet." })
      }
      return Promise.reject(new Error(`no ${name}`))
    },
  },
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

const shipment = {
  id: "2611081522DHLE5ANCFR",
  title: "Client Bordeaux",
  attributes: { order_status: "CONFIRMED", tracking_status: null, carrier: "DHLE", declared_value: 0, currency: "EUR", document_ref: null },
}

async function mount() {
  const { ShipmentDetailPanel } = await import("./Shipments")
  render(() => <ShipmentDetailPanel shipment={shipment as never} />)
  for (let i = 0; i < 4; i++) await flush()
}

afterEach(() => {
  cleanup()
  calls.tools.length = 0
  calls.opened.length = 0
  calls.label = "f-label"
})

describe("shipment detail: the label's Download", () => {
  it("opens the shipment's label through the host", async () => {
    await mount()
    fireEvent.click(screen.getByTestId("boxtal-doc-LABEL"))
    for (let i = 0; i < 4; i++) await flush()
    expect(calls.tools.find((c) => c.name === "print_pack")?.args).toEqual({ shipment_id: "2611081522DHLE5ANCFR" })
    expect(calls.opened).toEqual(["f-label"])
  })

  it("says why when the label is not there yet", async () => {
    calls.label = null
    await mount()
    fireEvent.click(screen.getByTestId("boxtal-doc-LABEL"))
    for (let i = 0; i < 4; i++) await flush()
    expect(calls.opened).toEqual([])
    expect(screen.getByTestId("boxtal-detail-doc-open-error").textContent).toContain("not served the label yet")
  })

  it("shows no button it cannot honour", async () => {
    await mount()
    expect(screen.queryByTestId("boxtal-doc-CN23")).toBeNull()
  })
})

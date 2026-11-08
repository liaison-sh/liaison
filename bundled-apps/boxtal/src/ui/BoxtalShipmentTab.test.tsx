// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BoxtalShipmentTab + pure UI-logic tests. Bundled-app UI tests run under
// bun:test (no jsdom) — we pin: the component module imports cleanly, the CTA
// binds `shipment_draft_create`, and the pure status/document mappers cover
// every enum value.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BoxtalShipmentTab,
  DRAFT_CREATE_TOOL,
  documentTypeLabel,
  orderStatusBadge,
  trackingStatusBadge,
} from "./BoxtalShipmentTab"

const ORDER_STATUSES = ["PENDING", "REQUESTED", "CONFIRMED", "CANCELLED"] as const
const TRACKING_STATUSES = [
  "ANNOUNCED",
  "SHIPPED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "FAILED_ATTEMPT",
  "REACHED_DELIVERY_PICKUP_POINT",
  "DELIVERED",
  "RETURNED",
  "EXCEPTION",
] as const

describe("BoxtalShipmentTab", () => {
  it("exports a Component", () => {
    expect(typeof BoxtalShipmentTab).toBe("function")
  })

  it("binds the draft-create tool name for the CTA", () => {
    expect(DRAFT_CREATE_TOOL).toBe("shipment_draft_create")
  })

  it("reads the kernel-standard `entityId` prop (not `documentRef`)", () => {
    const src = readFileSync(join(import.meta.dir, "BoxtalShipmentTab.tsx"), "utf-8")
    expect(src).toContain("props.entityId")
    expect(src).not.toContain("props.documentRef")
  })
})

// Ready-to-ship print station: the Label/Invoice row buttons were rendered with
// NO onClick (dead buttons), and Print pack called window.open AFTER the async
// print_pack — outside the user gesture, so the popup-blocker swallowed the tabs
// ("almost nothing is clickable, can't retrieve invoices or label"). Pin the fix.
describe("Ready-to-ship document retrieval (Queues.tsx)", () => {
  const queuesSrc = readFileSync(join(import.meta.dir, "Queues.tsx"), "utf-8")

  it("wires the Label and Invoice row buttons to live retrieval (no longer dead)", () => {
    expect(queuesSrc).toContain('onClick={() => void retrieveDoc(row, "label")}')
    expect(queuesSrc).toContain('onClick={() => void retrieveDoc(row, "invoice")}')
  })

  it("pre-opens the tab inside the click gesture so the popup-blocker keeps it", () => {
    // A synchronously-opened window, navigated to the blob URL after the fetch. The pair now lives
    // in file-open.ts (shared with the prep grid's invoice and label buttons); Queues.tsx still has
    // to call openPreparingTab BEFORE it awaits anything, which is the half that actually breaks.
    const fileOpenSrc = readFileSync(join(import.meta.dir, "file-open.ts"), "utf-8")
    expect(fileOpenSrc).toContain('window.open("", "_blank")')
    expect(fileOpenSrc).toContain("win.location.href = url")
    expect(queuesSrc).toContain("const labelWin = openPreparingTab()")
    expect(queuesSrc).toContain("const invoiceWin = openPreparingTab()")
  })

  it("does not gate document retrieval on the stale has_label cache", () => {
    expect(queuesSrc).not.toContain("disabled={!row.has_label}")
  })

  it("asks before unticking in the app's own dialog: a framed screen has no window.confirm", () => {
    expect(queuesSrc).not.toContain("window.confirm")
    expect(queuesSrc).toContain('testid="boxtal-unpack-confirm"')
    expect(queuesSrc).toContain("void togglePacked(ask.row, true)")
  })

  it("the shipment tab opens its label through the host, never a dead in-app link", () => {
    const tabSrc = readFileSync(join(import.meta.dir, "BoxtalShipmentTab.tsx"), "utf-8")
    expect(tabSrc).not.toContain("/boxtal/documents/")
    expect(tabSrc).toContain('"import_label_document"')
    expect(tabSrc).toContain('await loadFileInto(res.label_file_id, win, "label")')
  })
})

describe("orderStatusBadge", () => {
  it("maps every order status to a label + variant", () => {
    for (const s of ORDER_STATUSES) {
      const badge = orderStatusBadge(s)
      expect(badge.label.length).toBeGreaterThan(0)
      expect(["neutral", "info", "success", "warning", "danger"]).toContain(badge.variant)
    }
  })
  it("CONFIRMED is success, CANCELLED is danger", () => {
    expect(orderStatusBadge("CONFIRMED").variant).toBe("success")
    expect(orderStatusBadge("CANCELLED").variant).toBe("danger")
  })
  it("a null status → an Unlinked/neutral badge", () => {
    expect(orderStatusBadge(null).variant).toBe("neutral")
  })
})

describe("trackingStatusBadge", () => {
  it("maps every tracking status to a label + variant", () => {
    for (const s of TRACKING_STATUSES) {
      const badge = trackingStatusBadge(s)
      expect(badge.label.length).toBeGreaterThan(0)
      expect(["neutral", "info", "success", "warning", "danger"]).toContain(badge.variant)
    }
  })
  it("DELIVERED is success; EXCEPTION/RETURNED are danger/warning", () => {
    expect(trackingStatusBadge("DELIVERED").variant).toBe("success")
    expect(trackingStatusBadge("EXCEPTION").variant).toBe("danger")
  })
})

describe("documentTypeLabel", () => {
  it("maps each document type to a display label", () => {
    expect(documentTypeLabel("LABEL")).toBe("Shipping label")
    expect(documentTypeLabel("CN23")).toBe("CN23 customs")
    expect(documentTypeLabel("PROFORMA")).toBe("Pro-forma invoice")
    expect(documentTypeLabel("VOUCHER")).toBe("Carrier voucher")
  })
})

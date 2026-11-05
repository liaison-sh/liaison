// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  applyDocumentCreated,
  applyTrackingChanged,
  finalizeCreated,
  isLiveShipment,
  markUncertain,
  reserveCreate,
  shipmentRefFromLabelUrl,
} from "./link-store"
import { createMockDb } from "./test-db"

function makeCtx() {
  const db = createMockDb()
  return { ctx: { db } as any, db }
}

const reserveInput = {
  document_ref: "doc-1",
  external_id: "ext-1",
  contact_ref: "contact-1",
  offer_code: "CHRP-Chrono18",
  recipient_summary: "Acme Corp, Paris",
  route_summary: "FR → US",
  declared_total: 225,
  currency: "EUR",
}

describe("link-store", () => {
  it("reserveCreate inserts a create_in_flight row with null order/boxtal ids", async () => {
    const { ctx, db } = makeCtx()
    const res = await reserveCreate(ctx, reserveInput)
    expect(res.ok).toBe(true)
    const rows = db.__all("shipment")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      document_ref: "doc-1",
      link_state: "create_in_flight",
      order_status: null,
      boxtal_order_id: null,
    })
  })

  it("a second reserveCreate for the same non-cancelled document_ref → duplicate", async () => {
    const { ctx, db } = makeCtx()
    await reserveCreate(ctx, reserveInput)
    const res2 = await reserveCreate(ctx, reserveInput)
    expect(res2.ok).toBe(false)
    expect((res2 as { reason: string }).reason).toBe("duplicate")
    expect(db.__all("shipment")).toHaveLength(1)
  })

  it("finalizeCreated flips link_state→created, order_status→PENDING, backfills boxtal_order_id", async () => {
    const { ctx, db } = makeCtx()
    const res = await reserveCreate(ctx, reserveInput)
    const rowId = (res as { id: string }).id
    await finalizeCreated(ctx, rowId, { boxtal_order_id: "ord-1" })
    const row = db.__all("shipment").find((r) => r.id === rowId)!
    expect(row.link_state).toBe("created")
    expect(row.order_status).toBe("PENDING")
    expect(row.boxtal_order_id).toBe("ord-1")
  })

  it("markUncertain flips link_state→create_uncertain and keeps the row", async () => {
    const { ctx, db } = makeCtx()
    const res = await reserveCreate(ctx, reserveInput)
    const rowId = (res as { id: string }).id
    await markUncertain(ctx, rowId)
    const row = db.__all("shipment").find((r) => r.id === rowId)!
    expect(row.link_state).toBe("create_uncertain")
    expect(db.__all("shipment")).toHaveLength(1)
  })

  it("applyTrackingChanged updates only when `at` is newer than stored", async () => {
    const { ctx, db } = makeCtx()
    const res = await reserveCreate(ctx, reserveInput)
    await finalizeCreated(ctx, (res as { id: string }).id, { boxtal_order_id: "ord-1" })
    await applyTrackingChanged(ctx, "ord-1", {
      tracking_status: "IN_TRANSIT",
      tracking_number: "TRK1",
      at: "2026-06-02T10:00:00Z",
    })
    let row = db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    expect(row.tracking_status).toBe("IN_TRANSIT")
    expect(row.tracking_number).toBe("TRK1")
    // an OLDER event must not regress the status
    await applyTrackingChanged(ctx, "ord-1", {
      tracking_status: "SHIPPED",
      tracking_number: "TRK1",
      at: "2026-06-01T08:00:00Z",
    })
    row = db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    expect(row.tracking_status).toBe("IN_TRANSIT")
  })

  it("applyTrackingChanged orders by epoch, not lexicographically (I4 — tz offsets)", async () => {
    const { ctx, db } = makeCtx()
    const res = await reserveCreate(ctx, reserveInput)
    await finalizeCreated(ctx, (res as { id: string }).id, { boxtal_order_id: "ord-1" })
    // Stored: 10:00 UTC. Incoming: 11:30+02:00 == 09:30 UTC — chronologically
    // OLDER, but lexicographically GREATER. A string compare would wrongly apply
    // it; the epoch compare must reject it.
    await applyTrackingChanged(ctx, "ord-1", {
      tracking_status: "IN_TRANSIT",
      tracking_number: "TRK1",
      at: "2026-06-02T10:00:00Z",
    })
    const older = await applyTrackingChanged(ctx, "ord-1", {
      tracking_status: "SHIPPED",
      tracking_number: "TRK1",
      at: "2026-06-02T11:30:00+02:00", // == 09:30Z, older than stored 10:00Z
    })
    expect(older.applied).toBe(false)
    const row = db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    expect(row.tracking_status).toBe("IN_TRANSIT")
    // A genuinely newer offset-stamped event DOES apply.
    const newer = await applyTrackingChanged(ctx, "ord-1", {
      tracking_status: "OUT_FOR_DELIVERY",
      tracking_number: "TRK1",
      at: "2026-06-02T13:30:00+02:00", // == 11:30Z, newer
    })
    expect(newer.applied).toBe(true)
  })

  // Symptom: a status-only tracking event (no tracking_number on the payload)
  // wiped the previously stored tracking number, which silently blocked
  // auto-fulfilment (the webhook handler gates on tracking_number being present).
  it("applyTrackingChanged with a null tracking_number keeps the stored number, still updates status", async () => {
    const { ctx, db } = makeCtx()
    const res = await reserveCreate(ctx, reserveInput)
    await finalizeCreated(ctx, (res as { id: string }).id, { boxtal_order_id: "ord-1" })
    await applyTrackingChanged(ctx, "ord-1", {
      tracking_status: "IN_TRANSIT",
      tracking_number: "TRK1",
      at: "2026-06-02T10:00:00Z",
    })
    const statusOnly = await applyTrackingChanged(ctx, "ord-1", {
      tracking_status: "OUT_FOR_DELIVERY",
      tracking_number: null,
      at: "2026-06-02T11:00:00Z",
    })
    expect(statusOnly.applied).toBe(true)
    let row = db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    expect(row.tracking_status).toBe("OUT_FOR_DELIVERY")
    expect(row.tracking_number).toBe("TRK1")
    // A subsequent event WITH a number still overwrites as before.
    await applyTrackingChanged(ctx, "ord-1", {
      tracking_status: "DELIVERED",
      tracking_number: "TRK2",
      at: "2026-06-02T12:00:00Z",
    })
    row = db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    expect(row.tracking_number).toBe("TRK2")
  })

  it("applyTrackingChanged on an unknown order → applied:false", async () => {
    const { ctx } = makeCtx()
    const res = await applyTrackingChanged(ctx, "ghost", {
      tracking_status: "IN_TRANSIT",
      tracking_number: "X",
      at: "2026-06-02T10:00:00Z",
    })
    expect(res.applied).toBe(false)
  })

  it("applyDocumentCreated stores url-stripped descriptors and bumps order_status", async () => {
    const { ctx, db } = makeCtx()
    const res = await reserveCreate(ctx, reserveInput)
    await finalizeCreated(ctx, (res as { id: string }).id, { boxtal_order_id: "ord-1" })
    await applyDocumentCreated(ctx, "ord-1", [
      { url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" },
      { url: "https://signed/cn23.pdf", type: "CN23", format: "PDF_A4" },
    ])
    const row = db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    const docs = row.documents as Array<Record<string, unknown>>
    expect(docs).toHaveLength(2)
    expect(docs[0]).toEqual({ type: "LABEL", format: "PDF_A4" })
    expect("url" in docs[0]!).toBe(false)
    expect(row.order_status).toBe("CONFIRMED")
  })

  it("a cancelled shipment frees the document_ref for a new reserveCreate", async () => {
    const { ctx, db } = makeCtx()
    const res = await reserveCreate(ctx, reserveInput)
    const rowId = (res as { id: string }).id
    // cancel the prior row
    await db.update("shipment", rowId, { order_status: "CANCELLED" })
    const res2 = await reserveCreate(ctx, reserveInput)
    expect(res2.ok).toBe(true)
  })
})

describe("shipmentRefFromLabelUrl", () => {
  // Boxtal's label files are named after the reference their own shipment list shows — the code
  // the operator reads off their screen (2609141542FEDX1CS3FR). It is NOT the order payload's
  // `shipmentId` (an internal numeric id, 24315896, that appears nowhere in their UI) and NOT
  // the carrier tracking number.
  it("reads the reference out of a real signed label URL", () => {
    expect(
      shipmentRefFromLabelUrl(
        "https://document.boxtal.com/shipping-label/2609141542FEDX1CS3FR_bordereau_1.pdf?Expires=1791987747&Signature=abc",
      ),
    ).toBe("2609141542FEDX1CS3FR")
  })

  it("returns null rather than a fabricated reference for anything else", () => {
    expect(shipmentRefFromLabelUrl(null)).toBeNull()
    expect(shipmentRefFromLabelUrl(undefined)).toBeNull()
    expect(shipmentRefFromLabelUrl("https://document.boxtal.com/other/file.pdf")).toBeNull()
  })
})

describe("applyDocumentCreated: reference capture", () => {
  it("captures the reference from the label URL before the URLs are stripped", async () => {
    const db = createMockDb({ seed: { shipment: [{ id: "s1", boxtal_order_id: "o1", order_status: "PENDING" }] } })
    const ctx = { db } as any
    await applyDocumentCreated(ctx, "o1", [
      { url: "https://document.boxtal.com/shipping-label/2609141542FEDX1CS3FR_bordereau_1.pdf?x=1", type: "LABEL", format: "PDF_A4" },
    ])
    const row = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(row.boxtal_shipment_ref).toBe("2609141542FEDX1CS3FR")
    // URLs themselves are still never stored.
    expect(JSON.stringify(row.documents)).not.toContain("http")
  })

  it("a released (create_abandoned) reservation frees its document for a new label on a fresh unique key", async () => {
    const { ctx, db } = makeCtx()
    const first = await reserveCreate(ctx, reserveInput)
    expect(first.ok).toBe(true)
    // Still live: a second full create for the same invoice is a duplicate.
    expect(await reserveCreate(ctx, reserveInput)).toEqual({ ok: false, reason: "duplicate" })
    const firstId = (first as { id: string }).id
    await db.update("shipment", firstId, { link_state: "create_abandoned" })
    const second = await reserveCreate(ctx, reserveInput)
    expect(second.ok).toBe(true)
    const rows = db.__all("shipment")
    const released = rows.find((r) => r.id === firstId)!
    const fresh = rows.find((r) => r.id === (second as { id: string }).id)!
    // The released row keeps order_status NULL, so the DB partial unique on
    // (document_ref, kind, batch_seq) WHERE order_status IS DISTINCT FROM 'CANCELLED'
    // still counts it: the new reservation must take a different batch_seq.
    expect(released.order_status).toBeNull()
    expect(released.batch_seq).toBe(1)
    expect(fresh.batch_seq).toBe(2)
    expect(fresh.link_state).toBe("create_in_flight")
    // And the new one is live again: a third create is refused.
    expect(await reserveCreate(ctx, reserveInput)).toEqual({ ok: false, reason: "duplicate" })
  })

  it("isLiveShipment: cancelled and released rows are out of play, everything else is live", () => {
    expect(isLiveShipment({ order_status: "CANCELLED", link_state: "created" })).toBe(false)
    expect(isLiveShipment({ order_status: null, link_state: "create_abandoned" })).toBe(false)
    expect(isLiveShipment({ order_status: null, link_state: "create_in_flight" })).toBe(true)
    expect(isLiveShipment({ order_status: "PENDING", link_state: "created" })).toBe(true)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")

interface SchemaTable {
  fields: Record<string, unknown>
  constraints?: { unique?: Array<string[] | { columns: string[]; where: string }> }
  indexes?: string[][]
}

function loadSchema(): Record<string, SchemaTable> {
  const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    schema?: Record<string, SchemaTable>
  }
  if (!m.schema) throw new Error("manifest has no `schema` block")
  return m.schema
}

describe("Boxtal app schema (manifest.schema block)", () => {
  it("declares the full catalog + shipment table set", () => {
    const s = loadSchema()
    for (const t of [
      "shipping_profile",
      "pack",
      "pack_component",
      "local_product",
      "shipment",
      "webhook_delivery",
      "subscription",
      "app_config",
    ]) {
      expect(s[t], `table ${t}`).toBeDefined()
    }
  })

  it("shipping_profile: unique on (product_source, product_id)", () => {
    const t = loadSchema().shipping_profile!
    expect(t.fields.product_source).toBe("string")
    expect(t.fields.product_id).toBe("string")
    expect(t.fields.unit_weight).toBe("number")
    expect(t.fields.solo_length).toBe("number?")
    expect(t.fields.content_category).toBe("string?")
    expect(t.constraints?.unique).toContainEqual(["product_source", "product_id"])
  })

  it("shared profiles: a profile table and a variant -> profile link unique per variant", () => {
    const s = loadSchema()
    expect(s.shipping_profile!.fields.migrated_profile_id).toBe("string?")
    const profile = s.product_profile!
    expect(profile.fields.unit_weight).toBe("number")
    expect(profile.fields.short_code).toBe("string?")
    const link = s.product_profile_link!
    expect(link.fields).toEqual({
      product_source: "string",
      product_id: "string",
      profile_id: "string",
    })
    expect(link.constraints?.unique).toContainEqual(["product_source", "product_id"])
  })

  it("pack + pack_component: carton dims + component quantities", () => {
    const s = loadSchema()
    const pack = s.pack!
    expect(pack.fields.gross_weight).toBe("number")
    expect(pack.fields.length).toBe("number")
    // Nullable: existing rows have no value, and only a pack whose gross_weight
    // already carries a carton-ladder tare needs to set it.
    expect(pack.fields.carton_tare).toBe("number?")
    const comp = s.pack_component!
    expect(comp.fields.pack_id).toBe("string")
    expect(comp.fields.product_source).toBe("string")
    expect(comp.fields.product_id).toBe("string")
    expect(comp.fields.quantity).toBe("integer")
  })

  it("local_product: unique on sku", () => {
    const t = loadSchema().local_product!
    expect(t.fields.sku).toBe("string")
    expect(t.fields.label).toBe("string")
    expect(t.constraints?.unique).toContainEqual(["sku"])
  })

  it("shipment: link_state/order_status/tracking_status enums + partial-unique on document_ref", () => {
    const t = loadSchema().shipment!
    const link = t.fields.link_state as { enum?: string[] }
    expect(link.enum).toEqual([
      "create_in_flight",
      "created",
      "create_uncertain",
      "create_abandoned",
    ])
    const order = t.fields.order_status as { enum?: string[]; required?: boolean }
    expect(order.enum).toEqual(["PENDING", "REQUESTED", "CONFIRMED", "CANCELLED"])
    expect(order.required).toBe(false)
    const track = t.fields.tracking_status as { enum?: string[]; required?: boolean }
    expect(track.enum).toEqual([
      "ANNOUNCED",
      "SHIPPED",
      "IN_TRANSIT",
      "OUT_FOR_DELIVERY",
      "FAILED_ATTEMPT",
      "REACHED_DELIVERY_PICKUP_POINT",
      "DELIVERED",
      "RETURNED",
      "EXCEPTION",
    ])
    expect(track.required).toBe(false)
    expect(t.fields.documents).toEqual({ type: "json", default: [] })
    // partial unique frees the invoice slot when a shipment is cancelled, while
    // IS DISTINCT FROM keeps NULL/in-flight rows in the index so two concurrent
    // in-flight reservations for the same invoice collide at insert time.
    // (document_ref, kind, batch_seq): an invoice legitimately carries ONE outbound
    // leg AND ONE return leg, and an outbound leg may split into PARTIAL batches
    // (batch_seq 1..n, each with a line_quantities subset); only a second shipment
    // of the SAME kind and batch_seq collides (the concurrency backstop).
    expect(t.constraints?.unique).toContainEqual({
      columns: ["document_ref", "kind", "batch_seq"],
      where: "order_status IS DISTINCT FROM 'CANCELLED'",
    })
    expect(t.fields.batch_seq).toEqual({ type: "number", required: false, default: 1 })
    expect(t.fields.line_quantities).toEqual({ type: "json", required: false })
    expect(t.indexes).toContainEqual(["boxtal_order_id"])
    expect(t.indexes).toContainEqual(["document_ref"])
  })

  it("webhook_delivery: dedup by delivery_id, status enum, indexed by received_at", () => {
    const t = loadSchema().webhook_delivery!
    expect(t.fields.delivery_id).toBe("string")
    const status = t.fields.status as { enum?: string[] }
    expect(status.enum).toEqual(["processing", "processed", "failed"])
    expect(t.constraints?.unique).toContainEqual(["delivery_id"])
    expect(t.indexes).toContainEqual(["received_at"])
  })

  it("subscription: unique on event_type", () => {
    const t = loadSchema().subscription!
    expect(t.fields.event_type).toBe("string")
    expect(t.fields.subscription_id).toBe("string")
    expect(t.fields.callback_url).toBe("string")
    expect(t.constraints?.unique).toContainEqual(["event_type"])
  })

  it("app_config: unique on key, value json (holds webhook_status only)", () => {
    const t = loadSchema().app_config!
    expect(t.fields.key).toBe("string")
    expect(t.fields.value).toBe("json")
    expect(t.constraints?.unique).toContainEqual(["key"])
  })
})

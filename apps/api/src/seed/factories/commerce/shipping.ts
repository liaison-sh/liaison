// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shipping factory: a shipping app's sender address, product profiles,
// packs, attention rules, and the shipment and claim history its queues show,
// each shipment anchored to the invoicing document it ships against.
//
// Privileged: the app writes these rows from its handlers and its carrier sync
// over time (a label bought, a status polled, a claim filed); a seeded org
// needs that history at once, so the rows go in over the system connection
// through the app-table writer.
import { withSystemDb } from "~/db/privileged"
import type { SeedContext } from "~/seed/context"
import { type AppCell, iso, jsonCell, shiftTime, upsertAppRow } from "../app-tables"
import type { ComputedDocument } from "./invoicing"

export interface ShippingProductInput {
  sku: string
  label: string
  shortCode: string
  /** The variant (`product_source`, `product_id`) and its shipping profile fields (weights,
   *  dimensions, category...). */
  profile: Record<string, AppCell>
}

export interface PackInput {
  key: string
  name: string
  length: number
  width: number
  height: number
  grossWeight: number
  cartonTare: number
  /** The carrier's content category for the carton. */
  contentCategory: string
  components: { sku: string; productSource: string; productId: string; quantity: number }[]
}

export interface AttentionRuleInput {
  key: string
  name: string
  enabled: boolean
  conditions: { field: string; op: string; value: unknown }[]
  documents: { name: string; note: string }[]
}

export interface ShipmentSpec {
  key: string
  /** The invoicing document this parcel ships against, by spec key. */
  document: string
  kind: "outbound" | "return"
  linkState: "create_in_flight" | "created" | "create_uncertain"
  orderStatus: string | null
  trackingStatus: string | null
  offerCode: string | null
  trackingNumber: string | null
  hasLabel: boolean
  createdDaysAgo: number
  labelCostTtc: number | null
  returnReason?: string
  createdBy: "agent" | "user"
  /** Cartons, as measured when the label was bought. */
  parcels: { weight: number; length: number; width: number; height: number }[]
  products: string
  items: number
  category: "sale" | "repair" | "gift" | "return"
  staffNote?: string
}

export interface ClaimSpec {
  key: string
  shipment: string
  type: string
  amount: number
  status: string
  submitted: boolean
  daysAgo: number
}

export interface ShippingHistoryInput {
  senderAddress: Record<string, unknown>
  products: readonly ShippingProductInput[]
  packs: readonly PackInput[]
  attentionRules: readonly AttentionRuleInput[]
  shipments: readonly ShipmentSpec[]
  claims: readonly ClaimSpec[]
  documentsByKey: ReadonlyMap<string, ComputedDocument>
  /** The city a recipient summary names for a country. */
  cityFor: (country: string) => string
}

export async function seedShippingHistory(
  ctx: SeedContext,
  input: ShippingHistoryInput,
): Promise<void> {
  const { orgId, now } = ctx
  await withSystemDb("seed-shipping-history", async (tx) => {
    // Where the parcels leave from: a quote and a label need it.
    await upsertAppRow(tx, "boxtal", "app_config", {
      id: ctx.id("app_config", "sender_address"),
      org_id: orgId,
      key: "sender_address",
      value: jsonCell(input.senderAddress),
      created_at: iso(shiftTime(now, -300)),
      updated_at: iso(shiftTime(now, -30)),
    })
    for (const p of input.products) {
      // A shared profile, the variant's link to it, and the same values on the variant's old
      // per-variant row stamped with the profile: the app's previous release still reads that table
      // while a deploy overlaps the two (boxtal profiles.ts, ROLLING DEPLOY).
      const { product_source, product_id, ...fields } = p.profile
      const profileId = ctx.id("product_profile", p.sku)
      const stamps = { created_at: iso(shiftTime(now, -300)), updated_at: iso(shiftTime(now, -30)) }
      await upsertAppRow(tx, "boxtal", "product_profile", {
        id: profileId,
        org_id: orgId,
        ...fields,
        short_code: p.shortCode,
        label: p.label,
        ...stamps,
      })
      await upsertAppRow(tx, "boxtal", "product_profile_link", {
        id: ctx.id("product_profile_link", p.sku),
        org_id: orgId,
        product_source: product_source ?? null,
        product_id: product_id ?? null,
        profile_id: profileId,
        ...stamps,
      })
      await upsertAppRow(tx, "boxtal", "shipping_profile", {
        id: ctx.id("shipping_profile", p.sku),
        org_id: orgId,
        ...p.profile,
        short_code: p.shortCode,
        migrated_profile_id: profileId,
        ...stamps,
      })
      await upsertAppRow(tx, "boxtal", "local_product", {
        id: ctx.id("local_product", p.sku),
        org_id: orgId,
        sku: p.sku,
        label: p.label,
        created_at: iso(shiftTime(now, -300)),
        updated_at: iso(shiftTime(now, -30)),
      })
    }

    for (const p of input.packs) {
      const packId = ctx.id("pack", p.key)
      await upsertAppRow(tx, "boxtal", "pack", {
        id: packId,
        org_id: orgId,
        name: p.name,
        length: p.length,
        width: p.width,
        height: p.height,
        gross_weight: p.grossWeight,
        content_category: p.contentCategory,
        carton_tare: p.cartonTare,
        created_at: iso(shiftTime(now, -250)),
        updated_at: iso(shiftTime(now, -30)),
      })
      for (const c of p.components) {
        await upsertAppRow(tx, "boxtal", "pack_component", {
          id: ctx.id("pack_component", `${p.key}|${c.sku}`),
          org_id: orgId,
          pack_id: packId,
          product_source: c.productSource,
          product_id: c.productId,
          quantity: c.quantity,
          created_at: iso(shiftTime(now, -250)),
          updated_at: iso(shiftTime(now, -250)),
        })
      }
    }

    for (const r of input.attentionRules) {
      await upsertAppRow(tx, "boxtal", "attention_rule", {
        id: ctx.id("attention_rule", r.key),
        org_id: orgId,
        name: r.name,
        enabled: r.enabled,
        conditions: jsonCell(r.conditions),
        documents: jsonCell(r.documents),
        knowledge_ref: null,
        created_at: iso(shiftTime(now, -120)),
        updated_at: iso(shiftTime(now, -120)),
      })
    }

    for (const s of input.shipments) {
      const doc = input.documentsByKey.get(s.document)
      if (!doc)
        throw new Error(`shipping seed: shipment ${s.key} names unknown document ${s.document}`)
      const createdAt = shiftTime(now, -s.createdDaysAgo, 10)
      const weight = s.parcels.reduce((n, p) => n + p.weight, 0)
      const queueFacts = {
        customer: doc.party.name,
        destination: doc.party.country,
        items: s.items,
        products: s.products,
        weight: Math.round(weight * 100) / 100,
        parcels: s.parcels,
        package_count: s.parcels.length,
        category: s.category,
        order_name: doc.number,
        order_created_at: doc.issuedAt === null ? null : iso(doc.issuedAt),
        staff_note: s.staffNote ?? null,
      }
      await upsertAppRow(tx, "boxtal", "shipment", {
        id: ctx.id("shipment", s.key),
        org_id: orgId,
        boxtal_order_id: s.orderStatus === null ? null : `DEMO-ORD-${s.key}`,
        external_id: doc.number,
        document_ref: doc.id,
        contact_ref: null,
        offer_code: s.offerCode,
        tracking_number: s.trackingNumber,
        boxtal_shipment_ref: s.hasLabel ? `DEMO-SHP-${s.key}` : null,
        queue_facts: jsonCell(queueFacts),
        link_state: s.linkState,
        order_status: s.orderStatus,
        tracking_status: s.trackingStatus,
        status_fetched_at: s.trackingStatus === null ? null : iso(shiftTime(now, 0, -3)),
        polled_at: s.trackingStatus === null ? null : iso(shiftTime(now, 0, -3)),
        documents: jsonCell(s.hasLabel ? [{ type: "LABEL", format: "PDF" }] : []),
        // What the goods in the parcel are worth: a return anchored on a credit
        // note (a negative total) still declares the goods' positive value.
        declared_total: Math.abs(Number(doc.grandTotalMinor / 100n)),
        label_cost_ttc: s.labelCostTtc,
        currency: "EUR",
        recipient_summary: `${doc.party.name}, ${input.cityFor(doc.party.country)}, ${doc.party.country}`,
        route_summary: `FR to ${doc.party.country}`,
        kind: s.kind,
        return_reason: s.returnReason ?? null,
        created_by: s.createdBy,
        fulfillment_synced: s.orderStatus === "CONFIRMED",
        batch_seq: 1,
        created_at: iso(createdAt),
        updated_at: iso(createdAt),
      })
      // The print queue reads the order placement date from `prep_meta`, keyed
      // by the shipment's anchor document, so every seeded shipment carries one.
      await upsertAppRow(tx, "boxtal", "prep_meta", {
        id: ctx.id("prep_meta", s.key),
        org_id: orgId,
        document_ref: doc.id,
        shopify_order_id: null,
        order_name: doc.number,
        order_tags: jsonCell([s.category]),
        order_created_at: doc.issuedAt === null ? null : iso(doc.issuedAt),
        financial_status: doc.spec.paymentStatus === "paid" ? "paid" : "pending",
        cancelled_at: null,
        staff_note: s.staffNote ?? null,
        fetched_at: iso(createdAt),
        created_at: iso(createdAt),
        updated_at: iso(createdAt),
      })
    }

    for (const c of input.claims) {
      await upsertAppRow(tx, "boxtal", "claim", {
        id: ctx.id("claim", c.key),
        org_id: orgId,
        shipment_id: ctx.id("shipment", c.shipment),
        type: c.type,
        amount: c.amount,
        status: c.status,
        evidence_file_ids: jsonCell([]),
        submitted_to_carrier: c.submitted,
        created_at: iso(shiftTime(now, -c.daysAgo, 14)),
        updated_at: iso(shiftTime(now, -c.daysAgo, 14)),
      })
    }
  })
}

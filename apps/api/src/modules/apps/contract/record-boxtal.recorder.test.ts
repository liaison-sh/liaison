// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the Boxtal app's contract fixtures (fixtures/boxtal/*.json) against
// the Boxtal SANDBOX (test keys, never production ones), in a seeded demo org
// (the fictional demo company's invoices, shipments, packs and profiles), whose
// ids the scrub maps to the contract org's. Not part of any suite run (it skips
// unless CONTRACT_RECORD=1): run it by path when the app's egress changes, read
// what it wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-boxtal.recorder.test.ts)
//
// Needs BOXTAL_V1_TEST_KEY/_SECRET and BOXTAL_V3_TEST_KEY/_SECRET. The plan
// creates one sandbox shipment and cancels it at the end.
// CONTRACT_RECORD_ONLY=<entry,entry> writes only those entries.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { schemaRef } from "~/db/schema-ref"
import { seedDemoCommerce } from "~/seed/tiers/demo/seed-commerce"
import { type SeedDemoOrgResult, seedDemoOrg } from "~/seed/tiers/demo/seed-org"
import {
  connectCredentials,
  installForRecording,
  type RecordingOrg,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run.test-helpers"

const APP = "boxtal"
/** The apps the demo commerce layer writes (their tables must exist). */
const SEEDED_APPS = ["invoicing", "boxtal", "social", "pennylane", "monitoring"] as const
const KEYS = {
  v1Key: process.env.BOXTAL_V1_TEST_KEY ?? "",
  v1Secret: process.env.BOXTAL_V1_TEST_SECRET ?? "",
  v3Key: process.env.BOXTAL_V3_TEST_KEY ?? "",
  v3Secret: process.env.BOXTAL_V3_TEST_SECRET ?? "",
}
/** Signs the recorded webhook deliveries: the verifier checks it against the app's config. */
const SECRET = "contract-webhook-secret-not-real"
const CONFIG = { boxtalWebhookSecret: SECRET }
const BASE_TIME = new Date("2026-09-16T12:00:00.000Z")

type Rec = Record<string, unknown>
const params = (p: Rec) => ({ params: p })
const B = sql(schemaRef("app_boxtal"))

interface PlanState extends RecordingState {
  org: RecordingOrg
  /** A shipment row the seed created, with a Boxtal order id. */
  shipment?: Rec
  /** An invoicing document with no shipment yet. */
  documentRef?: string
  orderKey?: string
  profileA?: string
  profileB?: string
  packId?: string
  ruleId?: string
  draftId?: string
  offerCode?: string
  priceTtc?: number
  boxtalOrderId?: string
  createdShipmentId?: string
}

function signed(body: Rec): { headers: Record<string, string>; body: string } {
  const text = JSON.stringify(body)
  return {
    headers: {
      "content-type": "application/json",
      "x-bxt-signature": createHmac("sha256", SECRET).update(text).digest("hex"),
      "x-bxt-delivery-id": `contract-${String(body.type ?? "evt")}`,
    },
    body: text,
  }
}

async function rows(query: Promise<Rec[]>): Promise<Rec[]> {
  return [...(await query)].map((r) => ({ ...r }))
}

const I = sql(schemaRef("app_invoicing"))

async function one(query: Promise<Rec[]>): Promise<Rec> {
  const r = (await rows(query))[0]
  if (!r) throw new Error("the seeded org lacks a row this step needs")
  return r
}

/** A seeded shipment row by its state. */
const shipmentWhere = (
  s: PlanState,
  where: "exception" | "delivered" | "orphan" | "ready" | "return",
) => {
  const o = s.org.orgId
  switch (where) {
    case "exception":
      return one(
        sql`SELECT * FROM ${B}.shipment WHERE org_id = ${o} AND tracking_status = 'EXCEPTION' LIMIT 1`,
      )
    case "delivered":
      return one(
        sql`SELECT * FROM ${B}.shipment WHERE org_id = ${o} AND tracking_status = 'DELIVERED' LIMIT 1`,
      )
    case "orphan":
      return one(
        sql`SELECT * FROM ${B}.shipment WHERE org_id = ${o} AND link_state = 'create_in_flight' LIMIT 1`,
      )
    case "ready":
      return one(
        sql`SELECT * FROM ${B}.shipment WHERE org_id = ${o} AND order_status = 'PENDING' AND kind = 'outbound' LIMIT 1`,
      )
    case "return":
      return one(sql`SELECT * FROM ${B}.shipment WHERE org_id = ${o} AND kind = 'return' LIMIT 1`)
  }
}

const prepRow = (s: PlanState) =>
  one(sql`SELECT * FROM ${B}.prep_meta WHERE org_id = ${s.org.orgId} ORDER BY order_name LIMIT 1`)

const idOf = (a: unknown, ...path: string[]): string | undefined => {
  let v: unknown = a
  for (const k of path) v = (v as Rec | null)?.[k]
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined
}

const PARCEL = { length: 40, width: 30, height: 20, weight: 2.5 }
const TRACKING_EVENT = (orderId: string) => ({
  id: `evt-tracking-${orderId}`,
  type: "TRACKING_CHANGED",
  shippingOrderId: orderId,
  payload: {
    trackings: [
      {
        status: "IN_TRANSIT",
        trackingNumber: "1Z999AA10123456784",
        trackingDateTime: "2026-01-01T00:00:00Z",
      },
    ],
  },
})
const DOCUMENT_EVENT = (orderId: string) => ({
  id: `evt-document-${orderId}`,
  type: "DOCUMENT_CREATED",
  shippingOrderId: orderId,
})

/** The draft's invoice carries no postcode or phone: the operator completes them at shipping time. */
function createParams(s: PlanState): Rec {
  return {
    draft_id: s.draftId,
    offer_code: s.offerCode,
    quoted_price_ttc: s.priceTtc,
    recipient_phone: "+33100000000",
    recipient_address: {
      street: "3 rue Test",
      city: "Lyon",
      postalCode: "69002",
      countryIsoCode: "FR",
      email: "customer@example.com",
    },
  }
}

const STEPS: RecordingStep<PlanState>[] = [
  // — settings —
  { entry: "tool:settings_sender_address_get", input: () => params({}) },
  { entry: "tool:settings_sender_form_get", input: () => params({}) },
  { entry: "tool:settings_form_get", input: () => params({}) },
  {
    entry: "tool:settings_form_set",
    input: () => params({ exclude_pickup_point_services: true, label_format: "PDF_A4" }),
  },
  { entry: "tool:settings_label_format_get", input: () => params({}) },
  { entry: "tool:settings_label_format_set", input: () => params({ format: "PDF_A4" }) },
  { entry: "tool:settings_carrier_allowlist_get", input: () => params({}) },
  {
    entry: "tool:settings_carrier_allowlist_set",
    input: () => params({ carriers: [], exclude_pickup_point_services: true }),
  },
  { entry: "tool:settings_product_codes_get", input: () => params({}) },
  {
    entry: "tool:settings_product_codes_set",
    input: () =>
      params({
        strip_prefixes: ["RAL-"],
        strip_suffixes: ["-B2B"],
        aliases: [{ sku: "HARDCOVER", code: "HC" }],
      }),
  },
  { entry: "tool:settings_packaging_policy_get", input: () => params({}) },
  {
    entry: "tool:settings_packaging_policy_set",
    input: () =>
      params({
        raw_stack_max_height: 40,
        merge_leftovers_into_packs: true,
        nominal_proforma_value_minor: 1000,
      }),
  },
  {
    entry: "tool:settings_sender_address_set",
    input: async (s) => {
      const r = (
        await rows(
          sql`SELECT value FROM ${B}.app_config WHERE org_id = ${s.org.orgId} AND key = 'sender_address' LIMIT 1`,
        )
      )[0]
      const v = (
        typeof r?.value === "string" ? JSON.parse(r.value as string) : (r?.value ?? {})
      ) as Rec
      return params({
        name: v.name ?? "Shipping desk",
        company: v.company ?? "Demo company",
        email: "shipping@example.com",
        phone: "+33100000000",
        street: v.street ?? "1 rue de la Paix",
        city: v.city ?? "Paris",
        postalCode: v.postalCode ?? "75002",
        countryIsoCode: v.countryIsoCode ?? "FR",
      })
    },
  },
  // — catalog: profiles, packs, local products —
  { entry: "tool:packages_list", input: () => params({}) },
  { entry: "tool:list_content_categories", input: () => params({}) },
  {
    entry: "tool:product_profile_upsert",
    input: () =>
      params({
        product_source: "local",
        product_id: "CT-CABLE-1",
        unit_weight: 0.3,
        solo_length: 20,
        solo_width: 15,
        solo_height: 5,
        short_code: "CTC",
        label: "Patch cable set",
        accessory: true,
      }),
    after: (a, s) => {
      s.profileA = idOf(a, "profile", "id") ?? idOf(a, "id") ?? idOf(a, "profile_id")
    },
  },
  {
    entry: "tool:product_profile_link",
    input: (s) =>
      params({
        product_source: "local",
        product_id: "CT-CABLE-2",
        profile_id: s.profileA,
        confirm: true,
      }),
  },
  {
    entry: "tool:product_profile_unlink",
    input: () => params({ product_source: "local", product_id: "CT-CABLE-2" }),
  },
  // A second profile, merged into the first.
  {
    entry: "tool:product_profile_upsert",
    record: false,
    input: () =>
      params({
        product_source: "local",
        product_id: "CT-CABLE-3",
        unit_weight: 0.35,
        short_code: "CTD",
        label: "Patch cable set, long",
      }),
    after: (a, s) => {
      s.profileB = idOf(a, "id")
    },
  },
  {
    entry: "tool:product_profile_merge",
    input: (s) =>
      params({
        target_profile_id: s.profileA,
        source_profile_ids: [s.profileB],
        fields_from: s.profileA,
        confirm: true,
      }),
  },
  // A third profile, unlinked from its only product, then deleted.
  {
    entry: "tool:product_profile_upsert",
    record: false,
    input: () =>
      params({
        product_source: "local",
        product_id: "CT-CABLE-4",
        unit_weight: 0.2,
        short_code: "CTE",
        label: "Adapter",
      }),
    after: (a, s) => {
      s.profileB = idOf(a, "id")
    },
  },
  {
    entry: "tool:product_profile_unlink",
    record: false,
    input: () => params({ product_source: "local", product_id: "CT-CABLE-4" }),
  },
  { entry: "tool:product_profile_delete", input: (s) => params({ profile_id: s.profileB }) },
  {
    entry: "tool:local_product_upsert",
    input: () => params({ sku: "CT-CABLE-1", label: "Patch cable set" }),
  },
  {
    entry: "tool:pack_upsert",
    input: () =>
      params({
        name: "CT-CABLE-BOX",
        length: 25,
        width: 20,
        height: 10,
        gross_weight: 0.9,
        carton_tare: 0.2,
        components: [{ product_source: "local", product_id: "CT-CABLE-1", quantity: 2 }],
      }),
    after: (a, s) => {
      s.packId = idOf(a, "pack", "id") ?? idOf(a, "id")
    },
  },
  { entry: "tool:pack_delete", input: (s) => params({ id: s.packId }) },
  // — attention rules —
  { entry: "tool:attention_rules_list", input: () => params({}) },
  {
    entry: "tool:attention_rule_upsert",
    input: () =>
      params({
        name: "Battery inside: carrier declaration",
        enabled: true,
        conditions: [{ field: "destination", op: "in", value: ["US", "CA"] }],
        documents: [{ name: "Lithium battery declaration", note: "Print and sign before pickup." }],
      }),
    after: (a, s) => {
      s.ruleId = idOf(a, "rule", "id") ?? idOf(a, "id")
    },
  },
  { entry: "tool:attention_rule_delete", input: (s) => params({ id: s.ruleId }) },
  // — queues and reads —
  { entry: "tool:queue_counts", input: () => params({}) },
  { entry: "tool:to_prepare_list", input: () => params({}) },
  { entry: "tool:ready_list", input: () => params({}) },
  { entry: "tool:returns_list", input: () => params({}) },
  { entry: "tool:exceptions_list", input: () => params({}) },
  { entry: "tool:stuck_list", input: () => params({}) },
  { entry: "tool:search", input: () => params({ query: "INV-2026", limit: 5 }) },
  { entry: "search:search", input: () => params({ query: "INV-2026", limit: 5 }) },
  { entry: "tool:prep_list", input: () => params({ include_excluded: false }) },
  { entry: "tool:prep_unlinked_list", input: () => params({ limit: 10 }) },
  { entry: "tool:prep_sync", input: () => params({ limit: 5 }) },
  // — prep rows —
  {
    entry: "tool:prep_set_category",
    input: async (s) => params({ document_ref: (await prepRow(s)).document_ref, category: "sale" }),
  },
  {
    entry: "tool:prep_set_status",
    input: async (s) =>
      params({
        document_ref: (await prepRow(s)).document_ref,
        status: "on_hold",
        note: "Waiting for the customer's door code.",
      }),
  },
  {
    entry: "tool:prep_set_validated",
    input: async (s) => params({ document_ref: (await prepRow(s)).document_ref, validated: true }),
  },
  {
    entry: "tool:prep_set_note",
    // A Shopify order row (`so:<order id>`): the note is written on the order through the Shopify app.
    input: () => params({ order_key: "so:5123456789", note: "Fragile: double box." }),
  },
  {
    entry: "tool:prep_exclude",
    input: async (s) => params({ document_ref: (await prepRow(s)).document_ref }),
  },
  {
    entry: "tool:prep_restore",
    input: async (s) => params({ document_ref: (await prepRow(s)).document_ref }),
  },
  {
    entry: "tool:prep_select_offer",
    input: async (s) => params({ document_ref: (await prepRow(s)).document_ref }),
  },
  {
    entry: "preflight:prep_set_address_choice",
    input: async (s) => params({ document_ref: (await prepRow(s)).document_ref, choice: "order" }),
  },
  {
    entry: "tool:prep_set_address_choice",
    input: async (s) => params({ document_ref: (await prepRow(s)).document_ref, choice: "order" }),
  },
  {
    entry: "tool:prep_document_pdf",
    input: async (s) => params({ document_ref: (await prepRow(s)).document_ref }),
  },
  {
    entry: "tool:order_print_record_get",
    input: async (s) =>
      params({ document_ref: (await shipmentWhere(s, "delivered")).document_ref }),
  },
  { entry: "tool:prep_order_prefill", input: () => params({ order_number: "#1042" }) },
  {
    entry: "tool:prep_add_shipment",
    input: () =>
      params({
        category: "repair",
        recipient: {
          name: "Alex Exemple",
          street: "3 rue Test",
          city: "Lyon",
          postalCode: "69002",
          countryIsoCode: "FR",
          email: "alex@example.com",
          phone: "+33100000000",
        },
        items: [{ name: "Repaired controller", quantity: 1 }],
        status_note: "Back from repair",
      }),
  },
  // — a real sandbox shipment —
  {
    entry: "tool:shipment_draft_create",
    before: async (s) => {
      const doc =
        await one(sql`SELECT d.id FROM ${I}.documents d WHERE d.org_id = ${s.org.orgId} AND d.type = 'invoice'
        AND d.status IN ('issued', 'paid') AND d.counterparty_country = 'FR'
        AND NOT EXISTS (SELECT 1 FROM ${B}.shipment sh WHERE sh.document_ref::text = d.id::text) ORDER BY d.number LIMIT 1`)
      s.documentRef = String(doc.id)
    },
    input: (s) => params({ document_ref: s.documentRef }),
    after: (a, s) => {
      s.draftId = idOf(a, "draft_id") ?? idOf(a, "draft", "id") ?? idOf(a, "id")
    },
  },
  {
    entry: "tool:shipment_draft_set_package",
    input: (s) => params({ draft_id: s.draftId, override: PARCEL }),
  },
  { entry: "tool:shipment_draft_get", input: (s) => params({ draft_id: s.draftId }) },
  // An export (outside the EU) has customs articles: a draft for one, then its first line's HS code.
  {
    entry: "tool:shipment_draft_create",
    record: false,
    before: async (s) => {
      const doc =
        await one(sql`SELECT d.id FROM ${I}.documents d WHERE d.org_id = ${s.org.orgId} AND d.type = 'invoice'
        AND d.status IN ('issued', 'paid') AND d.counterparty_country = 'US'
        AND NOT EXISTS (SELECT 1 FROM ${B}.shipment sh WHERE sh.document_ref::text = d.id::text) ORDER BY d.number LIMIT 1`)
      s.values.exportDoc = String(doc.id)
    },
    input: (s) => params({ document_ref: s.values.exportDoc }),
    after: (a, s) => {
      s.values.exportDraft = idOf(a, "draft_id")
    },
  },
  {
    entry: "tool:shipment_draft_set_customs",
    input: (s) =>
      params({ draft_id: s.values.exportDraft, index: 0, patch: { tariffNumber: "8543.70" } }),
  },
  {
    entry: "tool:quote",
    input: () =>
      params({
        from: { country: "FR", postalCode: "75002", city: "Paris" },
        to: { country: "FR", postalCode: "69002", city: "Lyon" },
        parcels: [PARCEL],
      }),
    after: (a, s) => {
      const offers = ((a as Rec | null)?.offers ?? []) as Rec[]
      const o = offers[0]
      s.offerCode = idOf(o, "code") ?? idOf(o, "offer_code") ?? idOf(o, "offerCode")
      const p = (o?.price_ttc ?? o?.priceTtc ?? (o?.price as Rec | undefined)?.ttc) as
        | number
        | undefined
      s.priceTtc = typeof p === "number" ? p : Number(p ?? 0)
    },
  },
  {
    entry: "tool:quote_batch",
    input: async (s) => params({ order_refs: [String((await prepRow(s)).order_name)], limit: 3 }),
  },
  {
    entry: "preflight:create_shipment",
    input: (s) => params(createParams(s)),
  },
  {
    entry: "tool:create_shipment",
    input: (s) => params(createParams(s)),
    after: (a, s) => {
      s.boxtalOrderId = idOf(a, "boxtal_order_id")
      s.createdShipmentId = idOf(a, "shipment_id") ?? idOf(a, "id")
    },
  },
  { entry: "tool:get_shipment", input: (s) => params({ id: s.boxtalOrderId }) },
  { entry: "tool:track", input: (s) => params({ id: s.boxtalOrderId }) },
  { entry: "tool:get_documents", input: (s) => params({ id: s.boxtalOrderId }) },
  { entry: "tool:import_label_document", input: (s) => params({ id: s.boxtalOrderId }) },
  { entry: "tool:import_shipments", input: (s) => params({ ids: [s.boxtalOrderId] }) },
  {
    entry: "poll:create_shipment",
    input: async (s) => {
      const row = await one(
        sql`SELECT id FROM ${B}.shipment WHERE org_id = ${s.org.orgId} AND boxtal_order_id = ${s.boxtalOrderId ?? ""} LIMIT 1`,
      )
      return params({
        external_ref: { shipment_row_id: String(row.id), boxtal_order_id: s.boxtalOrderId },
      })
    },
  },
  {
    entry: "tool:print_pack",
    input: async (s) =>
      params({
        shipment_id: String(
          (
            await one(
              sql`SELECT id FROM ${B}.shipment WHERE org_id = ${s.org.orgId} AND boxtal_order_id = ${s.boxtalOrderId ?? ""} LIMIT 1`,
            )
          ).id,
        ),
      }),
  },
  {
    entry: "tool:print_pack_batch",
    input: async (s) =>
      params({
        shipment_ids: [
          String(
            (
              await one(
                sql`SELECT id FROM ${B}.shipment WHERE org_id = ${s.org.orgId} AND boxtal_order_id = ${s.boxtalOrderId ?? ""} LIMIT 1`,
              )
            ).id,
          ),
        ],
      }),
  },
  {
    entry: "tool:print_record_get",
    input: async (s) =>
      params({
        shipment_id: String(
          (
            await one(
              sql`SELECT id FROM ${B}.shipment WHERE org_id = ${s.org.orgId} AND boxtal_order_id = ${s.boxtalOrderId ?? ""} LIMIT 1`,
            )
          ).id,
        ),
      }),
  },
  {
    entry: "tool:ready_set_packed",
    input: async (s) =>
      params({
        shipment_id: String((await shipmentWhere(s, "ready")).id),
        packed: true,
        tracking_number: "1Z999AA10123456784",
      }),
  },
  // — webhooks (signed with the stand-in secret) —
  {
    entry: "webhook-verify:tracking-changed",
    input: (s) => {
      const d = signed(TRACKING_EVENT(s.boxtalOrderId ?? "unknown"))
      return params({ headers: d.headers, body: d.body, method: "POST", query: {} })
    },
  },
  {
    entry: "webhook:tracking-changed",
    input: (s) => {
      const d = signed(TRACKING_EVENT(s.boxtalOrderId ?? "unknown"))
      return { params: JSON.parse(d.body), extraArgs: [d.headers] }
    },
  },
  {
    entry: "webhook-verify:document-created",
    input: (s) => {
      const d = signed(DOCUMENT_EVENT(s.boxtalOrderId ?? "unknown"))
      return params({ headers: d.headers, body: d.body, method: "POST", query: {} })
    },
  },
  {
    entry: "webhook:document-created",
    input: (s) => {
      const d = signed(DOCUMENT_EVENT(s.boxtalOrderId ?? "unknown"))
      return { params: JSON.parse(d.body), extraArgs: [d.headers] }
    },
  },
  // — claims, orphans, cancel —
  {
    entry: "preflight:claim_open",
    input: async (s) =>
      params({
        shipment_id: String((await shipmentWhere(s, "exception")).id),
        type: "damaged",
        amount: 120,
      }),
  },
  {
    entry: "tool:claim_open",
    input: async (s) =>
      params({
        shipment_id: String((await shipmentWhere(s, "exception")).id),
        type: "damaged",
        amount: 120,
      }),
  },
  {
    entry: "preflight:settle_orphan_create",
    // A reservation is an orphan only after 15 minutes: the seeded one predates the run's clock.
    before: async (s) => {
      await sql`UPDATE ${B}.shipment SET created_at = '2025-12-01T00:00:00Z' WHERE org_id = ${s.org.orgId} AND link_state = 'create_in_flight'`
    },
    input: async (s) =>
      params({
        id: String((await shipmentWhere(s, "orphan")).id),
        outcome: "release",
        note: "No order in the Boxtal dashboard for this invoice.",
      }),
  },
  {
    entry: "tool:settle_orphan_create",
    input: async (s) =>
      params({
        id: String((await shipmentWhere(s, "orphan")).id),
        outcome: "release",
        note: "No order in the Boxtal dashboard for this invoice.",
      }),
  },
  { entry: "tool:webhooks_repair", input: () => params({}) },
  // — jobs —
  { entry: "job:probe-webhook-upstream", input: () => params({}) },
  { entry: "job:reconcile-tracking", input: () => params({}) },
  { entry: "job:generate-order-documents", input: () => params({}) },
  { entry: "job:backfill-queue-facts", input: () => params({}) },
  { entry: "job:migrate-shipping-profiles", input: () => params({}) },
  { entry: "job:sync-product-codes", input: () => params({}) },
  // — imports —
  {
    entry: "import:local-product",
    input: () =>
      params({
        runId: "contract-import",
        kind: "local-product",
        sourceLabel: "parts.csv",
        records: [{ record: { sku: "CT-PART-7", label: "Spare knob" }, dedupValue: "CT-PART-7" }],
      }),
  },
  {
    entry: "import:pack",
    input: () =>
      params({
        runId: "contract-import",
        kind: "pack",
        sourceLabel: "packs.csv",
        records: [
          {
            record: {
              externalRef: "PK-7",
              name: "Spare knob box",
              length: 12,
              width: 10,
              height: 6,
              grossWeight: 0.3,
              components: [{ sku: "CT-PART-7", quantity: 4 }],
            },
            dedupValue: "PK-7",
          },
        ],
      }),
  },
  {
    entry: "import:shipping-profile",
    input: () =>
      params({
        runId: "contract-import",
        kind: "shipping-profile",
        sourceLabel: "profiles.csv",
        records: [
          {
            record: {
              productSource: "local",
              productId: "CT-PART-7",
              unitWeight: 0.05,
              shortCode: "KNB",
            },
            dedupValue: "local:CT-PART-7",
          },
        ],
      }),
  },
  // — cancel the sandbox order last —
  { entry: "preflight:cancel_shipment", input: (s) => params({ id: s.boxtalOrderId }) },
  { entry: "tool:cancel_shipment", input: (s) => params({ id: s.boxtalOrderId }) },
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record boxtal contract fixtures", () => {
  let seeded: SeedDemoOrgResult
  let state: PlanState
  let installed: Awaited<ReturnType<typeof installForRecording>>

  beforeAll(async () => {
    for (const [k, v] of Object.entries(KEYS))
      if (!v) throw new Error(`Boxtal sandbox ${k} is not set`)
    seeded = await seedDemoOrg({ orgSlug: "contract-boxtal", variant: "reserved" })
    const org = { orgId: seeded.orgId, userId: seeded.adminUserId }
    for (const app of SEEDED_APPS) {
      const got = await installForRecording(app, app === APP ? CONFIG : {}, org)
      if (app === APP) installed = got
    }
    await seedDemoCommerce({ org: seeded, baseTime: BASE_TIME, pendingApprovals: false } as never)
    await connectCredentials(
      APP,
      "boxtal",
      "contract-sandbox",
      { ...KEYS, environment: "sandbox" },
      org,
    )
    // What an earlier recording run of this plan left in the seeded org.
    const o = org.orgId
    await sql`DELETE FROM ${B}.product_profile_link WHERE org_id = ${o} AND product_id LIKE 'CT-%'`
    await sql`DELETE FROM ${B}.product_profile WHERE org_id = ${o} AND short_code IN ('CTC', 'CTD', 'CTE', 'KNB')`
    await sql`DELETE FROM ${B}.pack_component WHERE org_id = ${o} AND pack_id::text IN (SELECT id::text FROM ${B}.pack WHERE org_id = ${o} AND name IN ('CT-CABLE-BOX', 'Spare knob box'))`
    await sql`DELETE FROM ${B}.pack WHERE org_id = ${o} AND name IN ('CT-CABLE-BOX', 'Spare knob box')`
    await sql`DELETE FROM ${B}.local_product WHERE org_id = ${o} AND sku LIKE 'CT-%'`
    await sql`DELETE FROM ${B}.webhook_delivery WHERE org_id = ${o} AND delivery_id LIKE 'contract-%'`
    state = { values: {}, org }
  }, 900_000)

  afterAll(async () => {
    for (const app of SEEDED_APPS) await uninstallAfterRecording(app, state.org)
  })

  it("records every planned entry", async () => {
    const report = await runRecordingPlan({
      app: APP,
      manifest: installed.manifest,
      bridgeManifest: installed.bridgeManifest,
      plan: STEPS,
      state,
      replacements: Object.values(KEYS).map((k) => ({ from: k, to: "contract-sandbox-key" })),
      secrets: Object.values(KEYS),
      recordedFrom: "the Boxtal sandbox, in a seeded demo org, record-boxtal.recorder.test.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: CONFIG,
      org: state.org,
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => l.startsWith("FAIL") || l.startsWith("WEAK"))).toEqual([])
  }, 1_800_000)
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What record-shopify.recorder.ts runs, in order: each step names a contract
// entry (`<kind>:<name>`), builds its input from what earlier steps found or
// created (`state.values`), and may read its answer for later steps.

import type { RecordInput } from "~/modules/apps/contract/recorder"
import { CONTRACT_USER_ID } from "~/modules/apps/contract/replay-bridge"

export interface PlanState {
  /** The development store's `<shop>.myshopify.com`. */
  shop: string
  values: Record<string, unknown>
  /** A direct Admin GraphQL read for what no tool answers (the recorder's own call, never recorded). */
  admin: (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** A direct Admin REST read (`orders/1.json`): a webhook body is the REST representation. */
  rest: (path: string) => Promise<Record<string, unknown>>
  /** A webhook body as the provider would sign it: scrubbed first, so the signature is over what is stored. */
  signed: (
    topic: string,
    body: unknown,
    webhookId: string,
  ) => { headers: Record<string, string>; body: string }
}

export interface PlanStep {
  entry: string
  input: (s: PlanState) => RecordInput | Promise<RecordInput>
  /** Read the answer (the handler's result, or `{ thrown }`) for later steps. */
  after?: (answer: unknown, s: PlanState) => void | Promise<void>
  /** False: run it (a prerequisite) without writing a fixture. */
  record?: boolean
}

/** The webhook signing secret the recording org is configured with: a stand-in, never a real one. */
export const SYNTHETIC_WEBHOOK_SECRET = "contract-webhook-secret-not-real"

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {})
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : [])
const params = (p: Rec): RecordInput => ({ params: p })
const val = (s: PlanState, k: string): unknown => s.values[k]
/** The id of the n-th result of a search answer kept under `key`. */
const nth = (s: PlanState, key: string, n = 0): string =>
  String(arr(obj(s.values[key]).results)[n]?.id ?? "")
const keep = (key: string) => (a: unknown, s: PlanState) => {
  s.values[key] = a
}

/** Read a dotted path out of an answer kept under `key` (`a.b.0.c`). */
const at = (s: PlanState, key: string, path: string): string => {
  let v: unknown = s.values[key]
  for (const part of path.split(".")) v = Array.isArray(v) ? v[Number(part)] : obj(v)[part]
  return typeof v === "string" || typeof v === "number" ? String(v) : ""
}
const PRODUCT = (s: PlanState) => at(s, "newProduct", "product.id")
const VARIANT = (s: PlanState) => at(s, "newProduct", "product.variants.edges.0.node.id")
const ITEM = (s: PlanState) =>
  String(obj(arr(obj(s.values.variants).results)[0]?.attributes).inventory_item_id ?? "")
const LOCATION = (s: PlanState) => nth(s, "locations")
const ONLINE_STORE = (s: PlanState) =>
  String(
    arr(obj(obj(s.values.newTargets).attributes).salesChannels).find(
      (c) => c.name === "Online Store",
    )?.publicationId ?? "",
  )
const productUpdate = (s: PlanState) =>
  params({
    input: {
      id: PRODUCT(s),
      title: "Contract Fixture Synth II",
      tags: ["contract-fixture", "updated"],
    },
  })
const variantUpdate = (s: PlanState) =>
  params({
    input: {
      id: at(s, "createdVariant", "productVariants.0.id") || VARIANT(s),
      price: "249.00",
      compareAtPrice: "299.00",
    },
  })
const variantDelete = (s: PlanState) =>
  params({ id: at(s, "createdVariant", "productVariants.0.id"), productId: PRODUCT(s) })
const setOnHand = (s: PlanState) =>
  params({
    input: {
      reason: "correction",
      referenceDocumentUri: "logistics://contract/recount",
      // Back to the count it had before the adjustment below: the store's stock is left as found.
      setQuantities: [
        {
          inventoryItemId: ITEM(s),
          locationId: LOCATION(s),
          quantity: Number(at(s, "levels", "results.0.attributes.on_hand")),
        },
      ],
    },
  })
const publish = (s: PlanState) =>
  params({ id: PRODUCT(s), input: [{ publicationId: ONLINE_STORE(s) }] })
const merge = (s: PlanState) =>
  params({
    survivorId: PRODUCT(s),
    duplicateId: at(s, "dupProduct", "product.id"),
    survivorTitle: "Contract Fixture Synth II",
    duplicateTitle: "Contract Fixture Synth (duplicate)",
  })

/** A product made for the recording, changed through every product tool, then deleted. */
const PRODUCT_STEPS: PlanStep[] = [
  {
    entry: "tool:products_create",
    input: () =>
      params({
        input: {
          title: "Contract Fixture Synth",
          descriptionHtml: "<p>Made by the contract recorder.</p>",
          status: "DRAFT",
          productType: "Synthesizer",
          vendor: "Contract Audio",
          tags: ["contract-fixture"],
        },
      }),
    after: keep("newProduct"),
  },
  {
    entry: "tool:variants_get",
    record: false,
    input: (s) => params({ id: VARIANT(s) }),
    after: keep("newVariant"),
  },
  { entry: "preflight:products_update", input: productUpdate },
  { entry: "tool:products_update", input: productUpdate },
  {
    entry: "tool:variants_create",
    input: (s) =>
      params({
        input: {
          productId: PRODUCT(s),
          price: "219.00",
          inventoryPolicy: "DENY",
          inventoryItem: { sku: "CF-SYNTH-B", tracked: true },
          optionValues: [{ optionName: "Title", name: "Model B" }],
        },
      }),
    after: keep("createdVariant"),
  },
  { entry: "preflight:variants_update", input: variantUpdate },
  { entry: "tool:variants_update", input: variantUpdate },
  { entry: "preflight:variants_delete", input: variantDelete },
  { entry: "tool:variants_delete", input: variantDelete },
  {
    entry: "tool:inventory_levels_list",
    input: (s) => params({ inventoryItemId: ITEM(s), limit: 5 }),
    after: keep("levels"),
  },
  {
    entry: "tool:inventory_adjust",
    input: (s) =>
      params({
        input: {
          reason: "correction",
          name: "available",
          referenceDocumentUri: "logistics://contract/adjust",
          changes: [{ inventoryItemId: ITEM(s), locationId: LOCATION(s), delta: 1 }],
        },
      }),
  },
  { entry: "preflight:inventory_set_on_hand", input: setOnHand },
  { entry: "tool:inventory_set_on_hand", input: setOnHand },
  {
    entry: "tool:metafields_set",
    input: (s) =>
      params({
        metafields: [
          {
            ownerId: PRODUCT(s),
            namespace: "contract",
            key: "fixture",
            type: "single_line_text_field",
            value: "recorded",
          },
        ],
      }),
  },
  {
    entry: "tool:metafields_delete",
    input: (s) => params({ ownerId: PRODUCT(s), namespace: "contract", key: "fixture" }),
  },
  {
    entry: "tool:products_publication_targets",
    record: false,
    input: (s) => params({ id: PRODUCT(s) }),
    after: keep("newTargets"),
  },
  { entry: "preflight:products_publish", input: publish },
  { entry: "tool:products_publish", input: publish },
  { entry: "preflight:products_unpublish", input: publish },
  { entry: "tool:products_unpublish", input: publish },
  {
    entry: "tool:products_create",
    record: false,
    input: () =>
      params({
        input: {
          title: "Contract Fixture Synth (duplicate)",
          status: "DRAFT",
          tags: ["contract-fixture"],
        },
      }),
    after: keep("dupProduct"),
  },
  { entry: "preflight:products_merge", input: merge },
  { entry: "tool:products_merge", input: merge },
  { entry: "preflight:products_delete", input: (s) => params({ id: PRODUCT(s) }) },
  { entry: "tool:products_delete", input: (s) => params({ id: PRODUCT(s) }) },
]

const CUSTOMER = (s: PlanState) => nth(s, "customers")
const SNOWBOARD = (s: PlanState) => nth(s, "variants")
const discountUpdate = (s: PlanState) =>
  params({
    id: at(s, "newDiscount", "codeDiscountNode.id"),
    basicCodeDiscount: { endsAt: "2026-12-31T23:59:59Z", usageLimit: 50 },
  })

/** A code discount made, changed and deleted; a bulk one made the same way. */
const DISCOUNT_STEPS: PlanStep[] = [
  {
    entry: "tool:discounts_create",
    input: () =>
      params({
        basicCodeDiscount: {
          title: "Contract Fixture 15 percent",
          code: "CONTRACT15",
          startsAt: "2026-01-01T00:00:00Z",
          percentage: 15,
          appliesOncePerCustomer: true,
        },
      }),
    after: keep("newDiscount"),
  },
  { entry: "preflight:discounts_update", input: discountUpdate },
  { entry: "tool:discounts_update", input: discountUpdate },
  {
    entry: "tool:discounts_bulk_create",
    input: () =>
      params({
        count: 3,
        codePrefix: "CONTRACT-PRESS",
        basicCodeDiscount: { title: "Contract Fixture press codes", percentage: 50 },
      }),
    after: keep("bulkDiscount"),
  },
  {
    entry: "poll:discounts_bulk_create",
    input: (s) =>
      params({
        external_ref: {
          discount_id: at(s, "bulkDiscount", "discountId"),
          bulk_creation_id: at(s, "bulkDiscount", "bulkCreationId"),
          requested_count: 3,
          title: "Contract Fixture press codes",
        },
      }),
  },
  {
    entry: "preflight:discounts_delete",
    input: (s) => params({ id: at(s, "newDiscount", "codeDiscountNode.id") }),
  },
  {
    entry: "tool:discounts_delete",
    input: (s) => params({ id: at(s, "newDiscount", "codeDiscountNode.id") }),
  },
  {
    entry: "tool:discounts_delete",
    record: false,
    input: (s) => params({ id: at(s, "bulkDiscount", "discountId") }),
  },
]

const customerUpdate = (s: PlanState) =>
  params({ input: { id: CUSTOMER(s), note: "Prefers email. Noted by the contract recorder." } })
const customerTag = (s: PlanState) =>
  params({ customerId: CUSTOMER(s), tags: ["contract-fixture"], op: "add" })

/** One existing customer of the store, given a note, a tag and consent changes. */
const CUSTOMER_STEPS: PlanStep[] = [
  { entry: "preflight:customers_update", input: customerUpdate },
  { entry: "tool:customers_update", input: customerUpdate },
  { entry: "preflight:customers_tag", input: customerTag },
  { entry: "tool:customers_tag", input: customerTag },
  {
    entry: "tool:customers_email_marketing_consent_update",
    input: (s) =>
      params({
        customerId: CUSTOMER(s),
        input: {
          emailMarketingConsent: {
            marketingState: "UNSUBSCRIBED",
            marketingOptInLevel: "SINGLE_OPT_IN",
          },
        },
      }),
  },
  {
    entry: "tool:customers_sms_marketing_consent_update",
    input: (s) =>
      params({
        customerId: CUSTOMER(s),
        input: {
          smsMarketingConsent: {
            marketingState: "UNSUBSCRIBED",
            marketingOptInLevel: "SINGLE_OPT_IN",
          },
        },
      }),
  },
]

const draftInput = (s: PlanState, quantity: number) => ({
  purchasingEntity: { customerId: at(s, "order", "attributes.customer.id") },
  lineItems: [{ variantId: SNOWBOARD(s), quantity }],
  shippingAddress: {
    address1: "1 Contract Street",
    city: "Lyon",
    zip: "69002",
    countryCode: "FR",
    firstName: "Marie",
    lastName: "Dupont",
  },
  note: "Contract recorder order",
  tags: ["contract-fixture"],
})
const DRAFT = (s: PlanState) => at(s, "draftA", "draftOrder.id")
const ORDER = (s: PlanState) => at(s, "completedA", "draftOrder.order.id")
const LINE = (s: PlanState) => at(s, "orderA", "lineItems.0.id")
const draftUpdate = (s: PlanState) =>
  params({ id: DRAFT(s), input: { note: "Contract recorder order (updated)" } })
const orderUpdate = (s: PlanState) =>
  params({
    input: { id: ORDER(s), tags: ["contract-fixture", "recorded"], note: "Recorded order" },
  })
const fulfill = (_s: PlanState, order: string, line: string) =>
  params({
    orderId: order,
    lineItems: [{ orderLineItemId: line, quantity: 1 }],
    fulfillment: {
      trackingInfo: { company: "UPS", number: "1Z999AA10123456784" },
      notifyCustomer: false,
    },
  })
const FULFILLMENT = (s: PlanState) => at(s, "fulfillmentA", "fulfillment.id")
const RETURN = (s: PlanState) => at(s, "returnA", "return.id")
const refund = (s: PlanState) =>
  params({ orderId: ORDER(s), amount: "10.00", note: "Goodwill refund", notify: false })
const ORDER_B = (s: PlanState) => at(s, "completedB", "draftOrder.order.id")
const orderCancel = (s: PlanState) =>
  params({
    orderId: ORDER_B(s),
    reason: "OTHER",
    refund: false,
    restock: true,
    notifyCustomer: false,
  })

/** Draft orders to an order, then its whole life: note, tags, fulfillment, returns, refund; a second order cancelled. */
const ORDER_STEPS: PlanStep[] = [
  { entry: "preflight:draft_orders_create", input: (s) => params({ input: draftInput(s, 2) }) },
  {
    entry: "tool:draft_orders_create",
    input: (s) => params({ input: draftInput(s, 2) }),
    after: keep("draftA"),
  },
  { entry: "preflight:draft_orders_update", input: draftUpdate },
  { entry: "tool:draft_orders_update", input: draftUpdate },
  {
    entry: "tool:draft_orders_send",
    input: (s) =>
      params({
        id: DRAFT(s),
        email: { subject: "Your quote", customMessage: "Here is the quote we discussed." },
      }),
  },
  {
    entry: "preflight:draft_orders_complete",
    input: (s) => params({ id: DRAFT(s), paymentPending: false }),
  },
  {
    entry: "tool:draft_orders_complete",
    input: (s) => params({ id: DRAFT(s), paymentPending: false }),
    after: keep("completedA"),
  },
  {
    entry: "tool:draft_orders_create",
    record: false,
    input: (s) => params({ input: draftInput(s, 1) }),
    after: keep("draftC"),
  },
  {
    entry: "preflight:draft_orders_delete",
    input: (s) => params({ id: at(s, "draftC", "draftOrder.id") }),
  },
  {
    entry: "tool:draft_orders_delete",
    input: (s) => params({ id: at(s, "draftC", "draftOrder.id") }),
  },
  {
    entry: "tool:orders_get",
    record: false,
    input: (s) => params({ id: ORDER(s) }),
    after: keep("orderA"),
  },
  {
    entry: "tool:order_note_set",
    input: (s) =>
      params({
        order_id: ORDER(s),
        note: "Gift wrap, please.",
        expected_note: "Contract recorder order (updated)",
      }),
  },
  { entry: "preflight:order_update", input: orderUpdate },
  { entry: "tool:order_update", input: orderUpdate },
  { entry: "preflight:fulfillments_create", input: (s) => fulfill(s, ORDER(s), LINE(s)) },
  {
    entry: "tool:fulfillments_create",
    input: (s) => fulfill(s, ORDER(s), LINE(s)),
    after: keep("fulfillmentA"),
  },
  {
    entry: "tool:fulfillments_get",
    input: (s) => params({ id: FULFILLMENT(s) }),
    after: keep("fulfillmentAGet"),
  },
  {
    entry: "tool:fulfillments_update_tracking",
    input: (s) =>
      params({
        fulfillmentId: FULFILLMENT(s),
        trackingInfoInput: { company: "UPS", number: "1Z999AA10123456785" },
        notifyCustomer: false,
      }),
  },
  {
    entry: "tool:returns_request",
    input: (s) =>
      params({
        input: {
          orderId: ORDER(s),
          returnLineItems: [
            {
              fulfillmentLineItemId: at(s, "fulfillmentAGet", "attributes.lineItems.0.id"),
              quantity: 1,
              returnReason: "DEFECTIVE",
            },
          ],
        },
      }),
    after: keep("returnA"),
  },
  { entry: "preflight:returns_approve", input: (s) => params({ id: RETURN(s) }) },
  {
    entry: "tool:returns_approve",
    input: (s) => params({ id: RETURN(s) }),
    after: keep("returnApproved"),
  },
  {
    entry: "tool:returns_search",
    record: false,
    input: (s) => params({ orderId: ORDER(s), limit: 5 }),
    after: async (_a, s) => {
      const data = await s.admin(
        "query ($id: ID!) { return(id: $id) { returnLineItems(first: 5) { nodes { id } } } }",
        { id: RETURN(s) },
      )
      s.values.returnLineItem = String(
        arr(obj(obj(obj(data.return).returnLineItems)).nodes)[0]?.id ?? "",
      )
    },
  },
  {
    entry: "preflight:returns_refund",
    input: (s) =>
      params({
        returnRefundInput: {
          returnId: RETURN(s),
          returnRefundLineItems: [
            { returnLineItemId: String(val(s, "returnLineItem")), quantity: 1 },
          ],
          notifyCustomer: false,
        },
      }),
  },
  {
    entry: "tool:returns_refund",
    input: (s) =>
      params({
        returnRefundInput: {
          returnId: RETURN(s),
          returnRefundLineItems: [
            { returnLineItemId: String(val(s, "returnLineItem")), quantity: 1 },
          ],
          notifyCustomer: false,
        },
      }),
  },
  { entry: "preflight:returns_close", input: (s) => params({ id: RETURN(s) }) },
  { entry: "tool:returns_close", input: (s) => params({ id: RETURN(s) }) },
  { entry: "preflight:refunds_create", input: refund },
  { entry: "tool:refunds_create", input: refund, after: keep("refundA") },
  { entry: "tool:refunds_get", input: (s) => params({ id: at(s, "refundA", "refund.id") }) },
  // A second order: fulfilled, its fulfillment cancelled, a return declined, then the order cancelled.
  {
    entry: "tool:draft_orders_create",
    record: false,
    input: (s) => params({ input: draftInput(s, 1) }),
    after: keep("draftB"),
  },
  {
    entry: "tool:draft_orders_complete",
    record: false,
    input: (s) => params({ id: at(s, "draftB", "draftOrder.id"), paymentPending: false }),
    after: keep("completedB"),
  },
  {
    entry: "tool:orders_get",
    record: false,
    input: (s) => params({ id: ORDER_B(s) }),
    after: keep("orderB"),
  },
  {
    entry: "tool:fulfillments_create",
    record: false,
    input: (s) => fulfill(s, ORDER_B(s), at(s, "orderB", "lineItems.0.id")),
    after: keep("fulfillmentB"),
  },
  {
    entry: "tool:fulfillments_get",
    record: false,
    input: (s) => params({ id: at(s, "fulfillmentB", "fulfillment.id") }),
    after: keep("fulfillmentBGet"),
  },
  {
    entry: "tool:returns_request",
    record: false,
    input: (s) =>
      params({
        input: {
          orderId: ORDER_B(s),
          returnLineItems: [
            {
              fulfillmentLineItemId: at(s, "fulfillmentBGet", "attributes.lineItems.0.id"),
              quantity: 1,
              returnReason: "UNWANTED",
            },
          ],
        },
      }),
    after: keep("returnB"),
  },
  {
    entry: "preflight:returns_decline",
    input: (s) =>
      params({ id: at(s, "returnB", "return.id"), declineReason: "RETURN_PERIOD_ENDED" }),
  },
  {
    entry: "tool:returns_decline",
    input: (s) =>
      params({ id: at(s, "returnB", "return.id"), declineReason: "RETURN_PERIOD_ENDED" }),
  },
  {
    entry: "preflight:fulfillments_cancel",
    input: (s) => params({ id: at(s, "fulfillmentB", "fulfillment.id") }),
  },
  {
    entry: "tool:fulfillments_cancel",
    input: (s) => params({ id: at(s, "fulfillmentB", "fulfillment.id") }),
  },
  { entry: "preflight:order_cancel", input: orderCancel },
  { entry: "tool:order_cancel", input: orderCancel },
]

/** The app's own settings: staff overrides, a scope seed. */
const SETTINGS_STEPS: PlanStep[] = [
  {
    entry: "preflight:staff_overrides_upsert",
    input: () =>
      params({
        liaisonUserId: CONTRACT_USER_ID,
        shopifyStaffId: "gid://shopify/StaffMember/1001",
        reason: "Same person, two accounts",
      }),
  },
  {
    entry: "tool:staff_overrides_upsert",
    input: () =>
      params({
        liaisonUserId: CONTRACT_USER_ID,
        shopifyStaffId: "gid://shopify/StaffMember/1001",
        reason: "Same person, two accounts",
      }),
    after: keep("override"),
  },
  { entry: "tool:staff_overrides_delete", input: (s) => params({ id: at(s, "override", "id") }) },
  {
    entry: "tool:apply_seed_suggestion",
    input: () => params({ liaisonUserId: CONTRACT_USER_ID, scopes: ["shopify:orders:read"] }),
  },
]

const numericId = (gid: string) => gid.split("/").pop() ?? ""

/** The background jobs (one run each: the backfill's first run starts its bulk operation) and the invoicing events. */
const JOB_AND_EVENT_STEPS: PlanStep[] = [
  { entry: "job:backfill-customers", input: () => params({}) },
  { entry: "job:scope-seed", input: () => params({}) },
  { entry: "job:reconcile-customers", input: () => params({}) },
  { entry: "job:scan-unfulfilled-orders", input: () => params({}) },
  { entry: "job:prune-webhook-deliveries", input: () => params({}) },
  { entry: "job:probe-webhook-upstream", input: () => params({}) },
  ...(["created", "issued", "updated", "paid", "cancelled", "credited"] as const).map(
    (action, i): PlanStep => ({
      entry: `event:invoicing/document:${action}`,
      input: (s) =>
        params({
          app: "invoicing",
          entity: "document",
          action,
          entityId: `00000000-0000-4000-8000-0000000d0c0${i}`,
          orgId: "00000000-0000-4000-8000-00000000c0de",
          data: {
            document_id: `00000000-0000-4000-8000-0000000d0c0${i}`,
            number: `INV-2026-00${40 + i}`,
            shopify_order_id: ORDER(s),
          },
        }),
    }),
  ),
]

interface Hook {
  key: string
  topic: string
  body: (s: PlanState) => Promise<unknown>
}

const restObject = async (s: PlanState, path: string, field: string) =>
  obj((await s.rest(path))[field])

/** Every webhook topic the app subscribes to, with a body read from the store's own REST representation. */
const HOOKS: Hook[] = [
  {
    key: "orders-create",
    topic: "orders/create",
    body: (s) => restObject(s, `orders/${numericId(ORDER(s))}.json`, "order"),
  },
  {
    key: "orders-updated",
    topic: "orders/updated",
    body: (s) => restObject(s, `orders/${numericId(ORDER(s))}.json`, "order"),
  },
  {
    key: "orders-fulfilled",
    topic: "orders/fulfilled",
    body: (s) => restObject(s, `orders/${numericId(ORDER(s))}.json`, "order"),
  },
  {
    key: "orders-cancelled",
    topic: "orders/cancelled",
    body: (s) => restObject(s, `orders/${numericId(ORDER_B(s))}.json`, "order"),
  },
  {
    key: "customers-create",
    topic: "customers/create",
    body: (s) =>
      restObject(
        s,
        `customers/${numericId(at(s, "order", "attributes.customer.id"))}.json`,
        "customer",
      ),
  },
  {
    key: "customers-update",
    topic: "customers/update",
    body: (s) =>
      restObject(
        s,
        `customers/${numericId(at(s, "order", "attributes.customer.id"))}.json`,
        "customer",
      ),
  },
  {
    key: "customers-delete",
    topic: "customers/delete",
    body: async (s) => ({
      id: Number(numericId(CUSTOMER(s))),
      phone: null,
      addresses: [],
      tax_exemptions: [],
      email_marketing_consent: null,
      sms_marketing_consent: null,
      admin_graphql_api_id: CUSTOMER(s),
    }),
  },
  {
    key: "refunds-create",
    topic: "refunds/create",
    body: (s) =>
      restObject(
        s,
        `orders/${numericId(ORDER(s))}/refunds/${numericId(at(s, "refundA", "refund.id"))}.json`,
        "refund",
      ),
  },
  {
    key: "returns-request-created",
    topic: "returns/request",
    body: async (s) => ({
      id: Number(numericId(RETURN(s))),
      admin_graphql_api_id: RETURN(s),
      status: "requested",
      order: { id: Number(numericId(ORDER(s))), admin_graphql_api_id: ORDER(s) },
      total_return_line_items: 1,
      name: "#R1",
      return_line_items: [
        {
          id: Number(numericId(String(val(s, "returnLineItem")))),
          admin_graphql_api_id: String(val(s, "returnLineItem")),
          fulfillment_line_item: {
            id: Number(numericId(at(s, "fulfillmentAGet", "attributes.lineItems.0.id"))),
          },
          quantity: 1,
          return_reason: "defective",
        },
      ],
    }),
  },
  {
    key: "fulfillments-create",
    topic: "fulfillments/create",
    body: (s) =>
      restObject(
        s,
        `orders/${numericId(ORDER(s))}/fulfillments/${numericId(FULFILLMENT(s))}.json`,
        "fulfillment",
      ),
  },
  {
    key: "inventory-levels-update",
    topic: "inventory_levels/update",
    body: async (s) => ({
      inventory_item_id: Number(numericId(ITEM(s))),
      location_id: Number(numericId(LOCATION(s))),
      available: Number(at(s, "levels", "results.0.attributes.available")),
      updated_at: "2026-11-12T02:00:00+00:00",
      admin_graphql_api_id: `gid://shopify/InventoryLevel/${numericId(LOCATION(s))}?inventory_item_id=${numericId(ITEM(s))}`,
    }),
  },
  {
    key: "products-create",
    topic: "products/create",
    body: (s) => restObject(s, `products/${numericId(nth(s, "products", 1))}.json`, "product"),
  },
  {
    key: "products-update",
    topic: "products/update",
    body: (s) => restObject(s, `products/${numericId(nth(s, "products", 1))}.json`, "product"),
  },
  {
    key: "draft-orders-create",
    topic: "draft_orders/create",
    body: (s) => restObject(s, `draft_orders/${numericId(DRAFT(s))}.json`, "draft_order"),
  },
  {
    key: "draft-orders-update",
    topic: "draft_orders/update",
    body: (s) => restObject(s, `draft_orders/${numericId(DRAFT(s))}.json`, "draft_order"),
  },
  {
    key: "draft-orders-delete",
    topic: "draft_orders/delete",
    body: async (s) => ({ id: Number(numericId(at(s, "draftC", "draftOrder.id"))) }),
  },
]

const hookInput = async (s: PlanState, hook: Hook, n: number) => {
  const key = `hook:${hook.key}`
  if (!s.values[key])
    s.values[key] = s.signed(hook.topic, await hook.body(s), `contract-${hook.key}-${n}`)
  return s.values[key] as { headers: Record<string, string>; body: string }
}

const hookSteps = (hook: Hook, n: number): PlanStep[] => [
  {
    entry: `webhook-verify:${hook.key}`,
    input: async (s) => {
      const d = await hookInput(s, hook, n)
      return params({ headers: d.headers, body: d.body, method: "POST", query: {} })
    },
  },
  {
    entry: `webhook:${hook.key}`,
    input: async (s) => {
      const d = await hookInput(s, hook, n)
      return { params: JSON.parse(d.body), extraArgs: [d.headers] }
    },
  },
]

const WEBHOOK_STEPS: PlanStep[] = HOOKS.flatMap((h, i) => hookSteps(h, i + 1))

const UNINSTALLED: Hook = {
  key: "app-uninstalled",
  topic: "app/uninstalled",
  body: async (s) => restObject(s, "shop.json", "shop"),
}

const CALLBACK_BASE = "https://liaison.example.com"

/**
 * Last, because they change the connection: the webhook repair (subscriptions pointing at a
 * stand-in host, then removed by the disconnect hook), the uninstall webhook, the disconnect tool.
 */
const LAST_STEPS: PlanStep[] = [
  { entry: "tool:webhooks_repair", input: () => params({ callback_base_url: CALLBACK_BASE }) },
  {
    entry: "disconnect:shop",
    input: (s) =>
      params({
        appName: "shopify",
        connectionName: "shop",
        identifier: s.shop,
        orgId: "00000000-0000-4000-8000-00000000c0de",
        kernelPublicBaseUrl: CALLBACK_BASE,
      }),
  },
  ...hookSteps(UNINSTALLED, HOOKS.length + 1),
  { entry: "tool:connection_disconnect", input: () => params({}) },
]

export const SHOPIFY_RECORDING_PLAN: PlanStep[] = [
  { entry: "tool:home_load", input: () => params({ recentLimit: 5 }) },
  { entry: "tool:settings_load", input: () => params({}) },
  {
    entry: "tool:locations_list",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.locations = a
    },
  },
  {
    entry: "tool:markets_list",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.markets = a
    },
  },
  {
    entry: "tool:products_search",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.products = a
    },
  },
  {
    entry: "tool:variants_search",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.variants = a
    },
  },
  {
    entry: "tool:orders_search",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.orders = a
    },
  },
  {
    entry: "tool:customers_search",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.customers = a
    },
  },
  {
    entry: "tool:draft_orders_list",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.drafts = a
    },
  },
  {
    entry: "tool:discounts_search",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.discounts = a
    },
  },
  {
    entry: "tool:companies_search",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.companies = a
    },
  },
  {
    entry: "tool:returns_search",
    input: () => params({ limit: 5 }),
    after: (a, s) => {
      s.values.returns = a
    },
  },
  {
    entry: "tool:orders_get",
    input: (s) => params({ id: nth(s, "orders") }),
    after: keep("order"),
  },
  {
    entry: "tool:customers_get",
    input: (s) => params({ id: nth(s, "customers") }),
    after: keep("customer"),
  },
  {
    entry: "tool:customers_get_by_external_id",
    input: (s) => params({ externalId: nth(s, "customers").split("/").pop() }),
  },
  { entry: "tool:companies_get", input: (s) => params({ id: nth(s, "companies") }) },
  { entry: "tool:draft_orders_get", input: (s) => params({ id: nth(s, "drafts") }) },
  {
    entry: "tool:products_get",
    input: (s) => params({ id: nth(s, "products", 1) }),
    after: keep("product"),
  },
  {
    entry: "tool:products_publication_targets",
    input: (s) => params({ id: nth(s, "products", 1) }),
  },
  { entry: "tool:markets_get", input: (s) => params({ id: nth(s, "markets") }) },
  {
    entry: "tool:variants_get",
    input: (s) => params({ id: nth(s, "variants") }),
    after: keep("variant"),
  },
  {
    entry: "tool:variants_market_price",
    input: (s) => params({ id: nth(s, "variants"), country: "CA" }),
  },
  { entry: "tool:customers_segment_search", input: () => params({ minSpend: 100, limit: 5 }) },
  {
    entry: "tool:analytics_query",
    input: () =>
      params({
        metric: "revenue",
        period: { since: "2026-06-01", until: "2026-09-30" },
        groupBy: "sku",
      }),
  },
  { entry: "tool:inventory_value", input: () => params({}) },
  { entry: "tool:repeat_rate", input: () => params({}) },
  { entry: "tool:abandoned_checkouts_list", input: () => params({ sinceDays: 30 }) },
  { entry: "tool:fulfillment_orders_get", input: (s) => params({ orderId: nth(s, "orders") }) },
  {
    entry: "tool:metafields_list",
    input: (s) => params({ ownerType: "Product", ownerId: nth(s, "products", 1), limit: 10 }),
  },
  ...PRODUCT_STEPS,
  ...DISCOUNT_STEPS,
  ...CUSTOMER_STEPS,
  ...ORDER_STEPS,
  ...SETTINGS_STEPS,
  ...JOB_AND_EVENT_STEPS,
  ...WEBHOOK_STEPS,
  ...LAST_STEPS,
]

export { arr, obj, val }

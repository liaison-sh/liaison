// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: draft orders (create, complete, update, delete, send invoice).

import type { AppContext } from "@liaison/app-sdk"
import { resolveOrderPoNumber } from "../lib/draft-order"
import { getShopifyClient } from "../lib/get-client"
import { isUsableEmail, normalizeDraftOrderInput, normalizeEmailInput } from "./draft-order-input"
import {
  assertDraftOrderInvoiceable,
  invoiceabilityFactsForCreate,
  invoiceabilityFactsForDraft,
} from "./invoiceability"
import {
  makeMutationError,
  type PreflightResult,
  preflightRefusal,
  readGatedTarget,
  requireTargetId,
  resolveMutationInput,
  runMutation,
  type ShopClient,
} from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Draft orders
// ─────────────────────────────────────────────────────────────────────────

const DRAFT_ORDER_CREATE = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name poNumber totalPriceSet { presentmentMoney { amount currencyCode } } }
      userErrors { field message }
    }
  }
`

// True when a draftOrder mutation failure is Shopify rejecting the buyer email's DOMAIN ("Email
// contains an invalid domain name" / "email is not accepted"). Both failure shapes arrive here as a
// thrown Error: a transport/GraphQL throw from the client, and a `userErrors[]` rejection, which
// `runMutation` turns into a SHOPIFY_USER_ERROR throw carrying Shopify's own message. Deliberately
// narrow: the message must mention the email AND a domain/invalid/not-accepted verdict.
function isEmailDomainRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : ""
  return /email/i.test(message) && /domain|invalid|not accepted/i.test(message)
}

// normalizeDraftOrderInput keeps a USABLE buyer email (a digital-goods order issues its license to it,
// and invoicing needs it as the document recipient when no customer is linked) and drops only an
// unusable one before the gated mutation is built. `enforceBuyerIdentity` additionally REFUSES to
// create a draft that lacks the identity its goods need (email+name for digital, a shipping address
// for physical).
//
// A fabricated-but-plausible domain no domain heuristic can pre-screen can still make Shopify reject
// the create. That is recovered here rather than by pre-emptively stripping every buyer email: on a
// domain rejection, retry ONCE without the email so the draft still lands. Any other failure
// propagates untouched, and a retry that also fails surfaces the ORIGINAL error.
/**
 * STAGE-TIME preflight for the gated `draft_orders_create` (manifest `preflight`). A gated call must
 * not be parked for a human when the data it needs is missing: a digital-goods draft with no usable
 * buyer email or name issues no license, a physical draft with no address has nowhere to ship, and an
 * unresolvable catalog gid would silently become a variant-less custom line. Runs the EXACT
 * normalisation + buyer-identity guard the handler runs (read-only: variant, price and shop-currency
 * lookups, no mutation) and refuses here instead of after the approve.
 */
export async function draft_orders_create_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const input = await normalizeDraftOrderInput(resolveMutationInput(params), ctx, {
      promoteWholeOrderDiscount: true,
      enforceBuyerIdentity: true,
    })
    await assertDraftOrderInvoiceable(ctx, () => invoiceabilityFactsForCreate(input, ctx))
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function draft_orders_create(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const input = await normalizeDraftOrderInput(resolveMutationInput(params), ctx, {
    promoteWholeOrderDiscount: true,
    enforceBuyerIdentity: true,
  })
  // Same Invoicing check as the preflight: the customer record can change before the approve.
  await assertDraftOrderInvoiceable(ctx, () => invoiceabilityFactsForCreate(input, ctx))
  // The raw draftOrderCreate response already carries `draftOrder.poNumber` (camelCase, once
  // selected in DRAFT_ORDER_CREATE below) exactly as invoicing's draft-order sync expects on
  // this event -- no transform needed, unlike the tool-result shapes in reads.ts which use the
  // snake_case `po_number` convention instead. See the note at NormalizedDraftOrder.poNumber
  // (lib/draft-order.ts) for why the two shapes intentionally disagree.
  const send = (variables: Record<string, unknown>): Promise<unknown> =>
    runMutation(ctx, {
      query: DRAFT_ORDER_CREATE,
      variables,
      dataKey: "draftOrderCreate",
      eventEntity: "draft_order",
      eventAction: "created",
      entityIdPath: "draftOrder.id",
    })
  try {
    return await send({ input })
  } catch (err) {
    if (input.email == null || !isEmailDomainRejection(err)) throw err
    const { email: _rejected, ...withoutEmail } = input
    try {
      return await send({ input: withoutEmail })
    } catch {
      // The retry is a recovery attempt, not a new outcome: surface Shopify's ORIGINAL verdict so
      // the real status/code/body reaches the caller instead of a rewritten one.
      throw err
    }
  }
}

// `order { id name poNumber }` is nested on the completed draftOrder so this ONE mutation
// response carries both sides of the order-then-draft PO fallback (see `draft_orders_complete`)
// without a second round trip.
const DRAFT_ORDER_COMPLETE = `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder { id name status poNumber order { id name poNumber } }
      userErrors { field message }
    }
  }
`

/**
 * STAGE-TIME preflight for the gated `draft_orders_complete` (manifest `preflight`). With Invoicing
 * mapped to this shop, the completed order is invoiced by its order-created auto-flow; a draft that
 * flow would park (no customer email, no address, an intra-EU business sale without the buyer's
 * VAT number, VAT charged on an exempt sale) is refused here, whoever made the draft (an agent, or
 * staff in the Shopify admin), instead of becoming an order nobody invoices.
 */
export async function draft_orders_complete_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
    await assertDraftOrderInvoiceable(ctx, () =>
      invoiceabilityFactsForDraft(String(params.id), ctx),
    )
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function draft_orders_complete(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
  // Re-checked at execution: the draft or its customer can change between staging and the approve.
  await assertDraftOrderInvoiceable(ctx, () => invoiceabilityFactsForDraft(String(params.id), ctx))
  return runMutation(ctx, {
    query: DRAFT_ORDER_COMPLETE,
    variables: { id: params.id, paymentPending: params.paymentPending ?? false },
    dataKey: "draftOrderComplete",
    eventEntity: "draft_order",
    eventAction: "completed",
    entityIdPath: "draftOrder.id",
    // Order-then-draft PO fallback: the completed ORDER's own poNumber wins; the
    // draft's poNumber (the quote's own PO, what we just completed) is the fallback,
    // used only when the order's own field comes back empty. Correct whether or not
    // Shopify's draftOrderComplete actually carries poNumber through to the order --
    // unconfirmed either way against production dogfood data (see resolveOrderPoNumber's
    // doc comment): every completed draft with a still-linked order had no PO to check,
    // and the only drafts seen WITH a PO had already lost their order link.
    // `draftOrder.poNumber` is overwritten in place with the resolved value (camelCase,
    // always present, `null` when neither side carries one) -- this raw GraphQL node's
    // siblings (id, name, status, order) are already Shopify's own camelCase, so the
    // resolved field matches them rather than the snake_case tool-result convention.
    transformNode: (node) => {
      const draftOrder = node.draftOrder as Record<string, unknown> | undefined
      if (!draftOrder) return node
      const order = draftOrder.order as { poNumber?: string | null } | undefined
      const poNumber =
        resolveOrderPoNumber(order?.poNumber, draftOrder.poNumber as string | null | undefined) ??
        null
      return {
        ...node,
        draftOrder: { ...draftOrder, poNumber },
      }
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────
//  Draft orders — update, delete, send-to-customer  (C6)
// ─────────────────────────────────────────────────────────────────────────

const DRAFT_ORDER_UPDATE = `
  mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { id name status }
      userErrors { field message }
    }
  }
`
/**
 * STAGE-TIME preflight for the gated `draft_orders_update`: the same normalisation and B2B pricing
 * guard the handler runs (read only), so a B2B draft edit with an unexcepted discount or custom
 * price is refused before an approval is staged, not after the approve.
 */
export async function draft_orders_update_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
    await normalizeDraftOrderInput(resolveMutationInput({ input: params.input ?? {} }), ctx, {
      draftId: String(params.id),
    })
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function draft_orders_update(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
  const input = await normalizeDraftOrderInput(
    resolveMutationInput({ input: params.input ?? {} }),
    ctx,
    {
      draftId: String(params.id),
    },
  )
  // Same normalize-then-mutate shape as the create, so it carries the same exposure: a usable-looking
  // email whose domain Shopify rejects would 422 the whole gated update. Same single retry without it.
  const send = (variables: Record<string, unknown>): Promise<unknown> =>
    runMutation(ctx, {
      query: DRAFT_ORDER_UPDATE,
      variables,
      dataKey: "draftOrderUpdate",
      eventEntity: "draft_order",
      eventAction: "updated",
      entityIdPath: "draftOrder.id",
    })
  try {
    return await send({ id: params.id, input })
  } catch (err) {
    if (input.email == null || !isEmailDomainRejection(err)) throw err
    const { email: _rejected, ...withoutEmail } = input
    try {
      return await send({ id: params.id, input: withoutEmail })
    } catch {
      throw err
    }
  }
}

const DRAFT_ORDER_DELETE = `
  mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`
/**
 * STAGE-TIME preflight for the gated `draft_orders_delete` (manifest `preflight`). A draft gid that
 * resolves to nothing (or to some other record) can only fail, and a DELETE approval on a phantom
 * draft is pure noise for the human. A draft someone else completes between staging and the approve
 * is a genuine race and stays with the handler's Shopify userErrors.
 */
export async function draft_orders_delete_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = requireTargetId(params, "id")
    await readGatedTarget(ctx, id, "DraftOrder", "draft_orders_delete")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function draft_orders_delete(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  requireTargetId(params, "id")
  return runMutation(ctx, {
    query: DRAFT_ORDER_DELETE,
    variables: { input: { id: params.id } },
    dataKey: "draftOrderDelete",
    eventEntity: "draft_order",
    eventAction: "deleted",
    entityIdPath: "deletedId",
  })
}

const DRAFT_ORDER_INVOICE_SEND = `
  mutation DraftOrderInvoiceSend($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`
/** BL-137 — resolve a draft's invoice recipient. `purchasingEntity:{customerId}` on draftOrderCreate
 *  sets the draft's CUSTOMER but does NOT populate the draft's `email`, and draftOrderInvoiceSend does
 *  NOT auto-fall-back to the customer's email — so with no recipient it fails "To can't be blank".
 *  Prefer the draft's own email, else the customer's. Returns undefined if neither is usable. */
async function resolveDraftRecipientEmail(
  client: ShopClient,
  draftId: string,
): Promise<string | undefined> {
  try {
    const data = await client.query<{
      draftOrder?: { email?: string | null; customer?: { email?: string | null } }
    }>(`query($id: ID!){ draftOrder(id:$id){ email customer{ email } } }`, { id: draftId })
    const e = data.draftOrder?.email ?? data.draftOrder?.customer?.email ?? undefined
    return typeof e === "string" && isUsableEmail(e) ? e : undefined
  } catch {
    return undefined
  }
}

export async function draft_orders_send(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
  let email = normalizeEmailInput(params.email)
  if (email?.to == null) {
    // No usable recipient supplied — resolve the draft's (customer) email and pass it explicitly,
    // else draftOrderInvoiceSend fails "To can't be blank" (Shopify has no customer fallback here).
    const client = await getShopifyClient(ctx)
    const to = await resolveDraftRecipientEmail(client, String(params.id))
    if (to) email = { ...(email ?? {}), to }
  }
  return runMutation(ctx, {
    query: DRAFT_ORDER_INVOICE_SEND,
    variables: { id: params.id, email },
    dataKey: "draftOrderInvoiceSend",
    eventEntity: "draft_order",
    eventAction: "sent",
    entityIdPath: "draftOrder.id",
  })
}

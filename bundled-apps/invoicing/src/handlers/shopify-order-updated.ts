// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E4 — `onShopifyOrderUpdated` handler.
//
// Spec §6 "Order-edit flow": Append to invoice's lifecycle_log as
// `downstream_change_observed`; surface attention "Order X edited after
// invoice issued -- needs credit note".
//
// A credit note is not a billing document for the live order: it must not
// participate in downstream-change detection (see findBillingDocumentsForOrder
// in billing-documents.ts, the centralised exclusion this handler routes
// through).
//
// Shopify's `orders/updated` webhook fires for ANY order mutation, the vast
// majority of which change nothing a customer was billed for -- payment
// capture (pending -> paid), fulfillment, tracking numbers, tag/note edits,
// risk analysis, marketing-consent flags. Most of those are triggered by
// Liaison itself (marking fulfilled, adding tracking, tagging the customer)
// or automatically by Shopify. Raising a "review for credit note" attention
// item on every such webhook buried operators in noise on essentially every
// invoiced order.
//
// So we alert only on a genuine BILLABLE divergence. Each document remembers
// the source order's billing signature (grand total + per-line qty/price +
// shipping) in `external_refs.downstream_order_sig`. On the FIRST observation
// we establish that baseline silently (we cannot yet know whether the order
// diverged from what was invoiced). On a LATER observation whose signature
// differs, we alert once and advance the baseline, so routine follow-up
// webhooks that don't touch billing never re-alert. A credit note matters
// only when the billed amount changes; fulfillment/tag/payment-status churn
// leaves the signature untouched and is silently ignored.

import { majorDecimalToMinor } from "../money"
import { findBillingDocumentsForOrder } from "./billing-documents"

export interface OrderUpdatedPayload {
  id: string
  shop_id: string
  updated_at?: string
  changed_fields?: string[]
}

export interface OrderUpdatedDoc {
  id: string
  type: string
  number: string | null
  lifecycle_log: Array<Record<string, unknown>>
  external_refs: Record<string, unknown>
  shopify_order_number: string | null
}

/** Billing-relevant slice of a normalized Shopify order. Read defensively --
 *  the kernel may hand us a partial payload on some webhooks. */
interface OrderMoneyLike {
  amount?: string | number | null
  currencyCode?: string | null
}
interface OrderLineLike {
  quantity?: number | null
  priceSet?: OrderMoneyLike | null
  variant?: { id?: string | null; sku?: string | null } | null
  title?: string | null
}
interface OrderBillingLike {
  totalPrice?: OrderMoneyLike | null
  lineItems?: OrderLineLike[] | null
  shippingLines?: Array<{ priceSet?: OrderMoneyLike | null }> | null
}

function moneyToken(m: OrderMoneyLike | null | undefined): string {
  if (!m) return ""
  const amount = m.amount == null ? "" : String(m.amount)
  return `${m.currencyCode ?? ""}:${amount}`
}

/**
 * Stable signature of everything a customer is billed for. Two orders with the
 * same signature owe the same money; a change to it is exactly the class of
 * edit that can require a credit note. Deliberately ignores fulfillment status,
 * tags, notes, tracking, risk and payment status -- none of which appear here.
 *
 * Returns `null` when the payload carries no financial content at all (no total
 * and no lines), so a contentless webhook is treated as "no signal" rather than
 * a spurious change.
 */
function billingSignature(order: OrderBillingLike): string | null {
  const hasTotal = order.totalPrice != null && order.totalPrice.amount != null
  const hasLines = Array.isArray(order.lineItems) && order.lineItems.length > 0
  if (!hasTotal && !hasLines) return null
  const total = hasTotal ? moneyToken(order.totalPrice) : ""
  const lines = (order.lineItems ?? [])
    .map((li) => {
      const key = li.variant?.sku ?? li.variant?.id ?? li.title ?? ""
      return `${key}#${li.quantity ?? 0}@${moneyToken(li.priceSet)}`
    })
    .sort()
    .join("|")
  const shipping = (order.shippingLines ?? [])
    .map((s) => moneyToken(s.priceSet))
    .sort()
    .join("|")
  return `${total}||${lines}||${shipping}`
}

function storedSignature(refs: Record<string, unknown> | undefined): string | null {
  const v = refs?.downstream_order_sig
  return typeof v === "string" ? v : null
}

export interface OrderUpdatedDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
    },
  ): Promise<unknown[]>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

/** `ctx.executeTool` envelope — mirrors `CrossAppEnvelope` in cross-app.ts
 *  (kept local so this handler stays a thin, dependency-light module). */
export type OrderUpdatedExecuteToolEnvelope =
  | { status: "completed"; result: unknown }
  | { status: "pending_approval"; approval_id: string }
  | { status: "error"; error: { code: string; message: string; retryable?: boolean } }

export interface OrderUpdatedCtx {
  getUserId(): Promise<string>
  db: OrderUpdatedDb
  // The real SDK channel for surfacing operator attention: emit a declared
  // event that the manifest's attention `translations` rule maps to an
  // attention item (event `detail:order_edited`).
  emit(event: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  }): Promise<void>
  /**
   * Cross-app / self dispatch — present on the kernel-injected ctx (the
   * bridge built for event handlers always exposes it, see
   * `apps/api/src/modules/apps/sandbox/rpc-bridge.ts` `executeTool`).
   * Optional so pure unit tests that never exercise the reissue path can
   * omit it (mirrors `IssueCtx.executeTool` in issue.ts). Used to stage the
   * `order_reissue_apply` gated approval on a genuine billable edit — a
   * webhook handler cannot call `ctx.requestApproval` directly (that bridge
   * method is only wired for a tool's OWN handler-conditional gating), so
   * raising the gated approval goes through `executeTool` instead, which the
   * kernel's declarative `"gated": true` intercepts before this app's
   * handler ever runs (see execute-tool.ts `isDirectHumanCall` — this call's
   * origin is never "human-ui", so the gate is never bypassed).
   */
  executeTool?(
    target: string,
    args: Record<string, unknown>,
  ): Promise<OrderUpdatedExecuteToolEnvelope>
}

export type OrderUpdatedResult =
  | { status: "ok"; document_id: string }
  | { status: "noop"; reason: "no_invoice_yet" }

async function findDocumentsByShopifyOrderId(
  db: OrderUpdatedDb,
  shopifyOrderId: string,
): Promise<OrderUpdatedDoc[]> {
  // Indexed equality on the top-level shopify_order_id column. A split order
  // (goods + software scopes) carries several documents — all of them must
  // observe the downstream change. A credit note carrying this order's id is
  // NOT one of them: it is a reversal document, not a billing document for
  // the live order, so it must never be compared against the order's billing
  // signature or get a downstream_change_observed entry / attention card.
  const rows = await findBillingDocumentsForOrder(db, shopifyOrderId, 10)
  return rows.map((r) => ({
    id: String(r.id),
    type: String(r.type ?? "invoice"),
    number: (r.number as string | null) ?? null,
    lifecycle_log: (r.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
    external_refs: (r.external_refs as Record<string, unknown> | undefined) ?? {},
    shopify_order_number:
      typeof r.shopify_order_number === "string" && r.shopify_order_number.length > 0
        ? r.shopify_order_number
        : null,
  }))
}

/** Convert the webhook's normalized order lines into the shape `order_reissue_apply`'s `items`
 *  param expects. A store's money is always in major units ("155.00" is 155 EUR, never 155 cents),
 *  whatever its fraction reads like. */
function orderLinesToReissueItems(
  lines: OrderLineLike[] | null | undefined,
  currency: string,
): Array<{
  description: string
  quantity: number
  unit_price_minor: number
  product_source: "shopify"
  external_id: string | null
}> {
  return (lines ?? []).map((li) => ({
    description: li.title ?? li.variant?.sku ?? li.variant?.id ?? "Item",
    quantity: li.quantity ?? 1,
    unit_price_minor: Number(
      majorDecimalToMinor(li.priceSet?.amount, li.priceSet?.currencyCode ?? currency),
    ),
    product_source: "shopify",
    external_id: li.variant?.id ?? null,
  }))
}

// Named observeShopifyOrderUpdated, NOT onShopifyOrderUpdated: the subscribed export of that
// name is the wrapper in src/handlers.ts. In the frozen bundle every top-level declaration is a
// script-mode global, and the kernel exposes exports with `globalThis.<export> = <local>`; a
// second top-level function called onShopifyOrderUpdated would be overwritten by that
// assignment and the wrapper would call itself forever (a sandbox stack overflow in prod).
export async function observeShopifyOrderUpdated(
  event: Partial<OrderUpdatedPayload> & {
    entityId?: string
    orderId?: string
    data?: { orderId?: string; id?: string; changed_fields?: string[] }
  },
  ctx: OrderUpdatedCtx,
): Promise<OrderUpdatedResult> {
  // The shopify app emits `order:updated` with entityId = order id and a
  // normalizeOrder payload whose id field is `orderId`. The kernel may deliver
  // that payload wrapped (`{ entityId, data }`) or as the bare normalized object
  // — mirror `onShopifyOrderCreated`'s `event.data ?? event` unwrap so both
  // shapes (and bare unit calls) resolve. (Previously read only `event.id`,
  // which the normalized order never carries → every real edit no-op'd.)
  const src = (event.data ?? event) as {
    orderId?: string
    id?: string
    changed_fields?: string[]
  } & OrderBillingLike
  const orderId = String(event.entityId ?? src.orderId ?? src.id ?? "")
  const changedFields = src.changed_fields ?? event.changed_fields ?? []

  const docs = await findDocumentsByShopifyOrderId(ctx.db, orderId)
  if (docs.length === 0) {
    return { status: "noop", reason: "no_invoice_yet" }
  }
  const actor = await ctx.getUserId()
  const currentSig = billingSignature(src)
  // Record the lifecycle event on EVERY document of the (possibly split)
  // order for the audit trail, but raise an attention item only when the
  // order's billing signature actually diverged from what this document last
  // observed (see file header). All run in the handler's transaction:
  // `ctx.emit` queues the event (transactional outbox) and the kernel's
  // attention translator turns it into an attention item for holders of
  // `invoicing:documents:write` (manifest rule `detail:order_edited`).
  for (const doc of docs) {
    const log = [
      ...doc.lifecycle_log,
      {
        event: "downstream_change_observed",
        actor,
        ts: new Date().toISOString(),
        shopify_order_id: orderId,
        changed_fields: changedFields,
      },
    ]

    // Decide whether this observation is a billable change worth surfacing.
    const priorSig = storedSignature(doc.external_refs)
    let nextRefs = doc.external_refs
    let raiseAttention = false
    if (currentSig !== null) {
      if (priorSig === null) {
        // First time we can assess this order: record the baseline silently.
        nextRefs = { ...doc.external_refs, downstream_order_sig: currentSig }
      } else if (priorSig !== currentSig) {
        // Genuine billable change -> alert once and advance the baseline so
        // subsequent identical webhooks don't re-raise the same item.
        nextRefs = { ...doc.external_refs, downstream_order_sig: currentSig }
        raiseAttention = true
      }
      // priorSig === currentSig -> routine update, nothing to persist or alert.
    }

    const patch: Record<string, unknown> = { lifecycle_log: log }
    if (nextRefs !== doc.external_refs) patch.external_refs = nextRefs
    await ctx.db.update("documents", doc.id, patch)

    if (raiseAttention) {
      // `entity: "detail"` (not "invoicing") anchors the attention item to the
      // document's detail tab: the frontend deep-links an attention item by
      // opening tab type `<app>:<entity>`, and `invoicing:detail` is this app's
      // document-detail surface (`/invoicing/document/:documentId`). Emitting
      // `entity: "invoicing"` produced the dead tab type `invoicing:invoicing`.
      await ctx.emit({
        entity: "detail",
        action: "order_edited",
        entityId: doc.id,
        data: {
          document_id: doc.id,
          document_number: doc.number,
          shopify_order_id: orderId,
          changed_fields: changedFields,
        },
      })

      // Stage the operator-approved reissue (credit note + replacement
      // invoice, one approval) alongside the attention card — the two are
      // complementary, not duplicate asks: the attention item is a
      // lightweight "this needs a look" pointer at the document, the
      // approval is the actual gate before either document is issued. Only
      // an invoice can be reissued (a quote/proforma/PO has no credit-note
      // reversal). `ctx.executeTool` targets this app's OWN declaratively
      // gated tool (`"gated": true` in the manifest) — the kernel intercepts
      // the call before `orderReissueApplyHandler` ever runs and parks a
      // pending approval instead, because this dispatch's origin is never
      // "human-ui" (see execute-tool.ts `isDirectHumanCall` / rpc-bridge.ts
      // `executeTool`, which attributes an origin-less event-handler
      // dispatch as "system"). `dedupe_key` collapses a redelivered webhook
      // for the SAME edit into the same pending approval instead of
      // stacking a duplicate. It is keyed by DOCUMENT as well as order and
      // signature: a split order (goods + software) raises one call per
      // billing document, and a dedupe hit restages the pending approval's
      // params IN PLACE (apps/api/src/modules/apps/execute-tool.ts) rather
      // than raising a second one -- without the document id, both halves of
      // a split order collapse onto the same key and whichever call lands
      // last silently clobbers the other's reissue.
      if (doc.type === "invoice" && ctx.executeTool) {
        const dedupeKey = `${orderId}:${doc.id}:${currentSig}`
        await ctx.executeTool("invoicing:order_reissue_apply", {
          original_document_id: doc.id,
          shopify_order_id: orderId,
          shopify_order_number: doc.shopify_order_number,
          billing_signature: currentSig,
          dedupe_key: dedupeKey,
          currency: src.totalPrice?.currencyCode ?? undefined,
          items: orderLinesToReissueItems(src.lineItems, src.totalPrice?.currencyCode ?? "EUR"),
        })
      }
    }
  }
  return { status: "ok", document_id: docs[0]!.id }
}

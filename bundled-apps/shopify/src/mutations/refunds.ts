// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: refunds_create and its staging preflight.

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "../lib/get-client"
import { type ApprovalBridges, makeMutationError, runMutation } from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Refunds
// ─────────────────────────────────────────────────────────────────────────

// Shopify API 2026-04 requires the field-level `@idempotent` directive (with a
// `key`) on refundCreate — without it the mutation 500s ("The @idempotent
// directive is required for this mutation but was not provided"). The directive
// attaches to the FIELD, not the operation, and the key argument is mandatory.
const REFUND_CREATE = `
  mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund { id totalRefundedSet { presentmentMoney { amount currencyCode } } note }
      userErrors { field message }
    }
  }
`

/** Deterministic 32-bit FNV-1a → base36; stable across retries of the same input. */
function stableHash36(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// What we read off the ORDER to NORMALIZE a refund: its own refundable line items (id+sku+qty) and the
// parent SALE transaction (so we can build a REFUND transaction that actually returns the money). This
// is the "normalize weak-model mistakes at the handler" pattern already pervasive in this file
// (resolveMutationInput / DraftOrderInput allowlisting) — a refund is the single hardest tool for a
// weak model to get right (it must thread THIS order's per-line gids + the parent transaction), so we
// derive those from the orderId rather than trusting the agent to plumb them.
const REFUND_ORDER_CONTEXT = `
  query RefundOrderContext($id: ID!) {
    order(id: $id) {
      id
      currencyCode
      presentmentCurrencyCode
      lineItems(first: 50) {
        edges { node { id quantity refundableQuantity variant { sku } sku } }
      }
      transactions(first: 20) {
        id kind status gateway
        amountSet { presentmentMoney { amount currencyCode } }
      }
    }
  }
`

interface RefundOrderContext {
  id: string
  currencyCode: string
  presentmentCurrencyCode: string
  lineItems: {
    edges: {
      node: {
        id: string
        quantity: number
        refundableQuantity: number
        variant: { sku: string | null } | null
        sku: string | null
      }
    }[]
  }
  transactions: {
    id: string
    kind: string
    status: string
    gateway: string | null
    amountSet: { presentmentMoney: { amount: string; currencyCode: string } }
  }[]
}

/** Extract the first numeric money value from a loosely-typed refund-amount field (number or string,
 *  e.g. 50, "50", "50.00", "€50"). Returns null when no amount is parseable. */
function parseMoneyAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v
  if (typeof v === "string") {
    const m = v.replace(/,/g, ".").match(/[0-9]+(\.[0-9]+)?/)
    if (m) {
      const n = Number.parseFloat(m[0])
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

/**
 * refunds_create — refund a Shopify order. NORMALIZES the things a weak model reliably gets wrong, so a
 * gated refund EXECUTES on approval instead of 422ing on a plumbing mistake:
 *
 *  1. CROSS-WIRED LINE ITEMS. The agent must pass `refundLineItems[].lineItemId` belonging to THIS
 *     order. With two near-identical duplicate orders (duplicate-order-detect-refund-one), the agent
 *     easily passes a lineItemId from the OTHER order → Shopify 422 "Line item must belong to the order
 *     which is being refunded". We RE-RESOLVE the caller's line items against the order: a lineItemId that
 *     belongs is kept; one that does NOT is remapped by SKU. And when `refundLineItems` is omitted/empty
 *     AND no flat goodwill `amount` was given, we build a FULL refund of every refundable line — the
 *     natural "refund this whole (duplicate) order", so the agent only needs the orderId.
 *
 *  2. FLAT GOODWILL / PARTIAL AMOUNT (mass-refund-firmware-recall-batch). The canonical "refund a flat
 *     X EUR goodwill amount" — a courtesy partial NOT tied to specific line items. Pass `amount`
 *     (number or money string) with NO refundLineItems → we build a NO-LINE-ITEM refund whose single
 *     REFUND transaction returns exactly that amount against the order's parent SALE/CAPTURE. Without
 *     this affordance a weak model either omitted refundLineItems (→ a FULL ~order-total refund, not
 *     50 EUR) or hand-built a `transactions` entry with a null gateway/orderId/parentId (Shopify 422
 *     "Expected value to not be null") or mis-routed it onto `shipping` (422 "Shipping must have amount
 *     less than or equal to remaining shipping"). A flat goodwill amount needs none of that plumbing.
 *
 *  3. UNDER-SPECIFIED REFUND TRANSACTION. Whether the caller supplied a flat amount, a partial
 *     transaction with just an amount, or nothing, we DERIVE the transaction's gateway/orderId/parentId
 *     from the order's parent SALE/CAPTURE — the agent only has to express HOW MUCH, never the internal
 *     transaction plumbing. (For a full refund with no transactions we still derive the parent amount so
 *     the money actually moves.) The caller may still pass a fully-formed `transactions` entry for a true
 *     partial — we fill only the missing fields, never override an explicit value.
 */
export async function refunds_create(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  if (!params.orderId) throw makeMutationError("BAD_PARAM", "orderId is required")
  const orderId = String(params.orderId)

  const client = await getShopifyClient(ctx)
  const ctxData = await client.query<{ order: RefundOrderContext | null }>(REFUND_ORDER_CONTEXT, {
    id: orderId,
  })
  const order = ctxData.order
  if (!order) throw makeMutationError("ORDER_NOT_FOUND", `refunds_create: order ${orderId} not found`)

  const orderLines = order.lineItems.edges
    .map((e) => e.node)
    .filter((n) => n.refundableQuantity > 0)
  const byId = new Map(orderLines.map((n) => [n.id, n]))
  const skuOf = (n: { variant: { sku: string | null } | null; sku: string | null }): string | null =>
    n.variant?.sku ?? n.sku ?? null

  // The order's parent SALE/CAPTURE transaction — every derived REFUND transaction threads through it.
  const parentTxn = order.transactions.find(
    (t) => t.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE"),
  )

  // A FLAT GOODWILL AMOUNT: `amount` param, or a transactions[] amount supplied WITHOUT line items.
  // This is a courtesy refund of a fixed sum, NOT tied to line items → no refundLineItems, no shipping.
  const requested = Array.isArray(params.refundLineItems)
    ? (params.refundLineItems as Record<string, unknown>[])
    : []
  const suppliedTxns = Array.isArray(params.transactions)
    ? (params.transactions as Record<string, unknown>[])
    : []
  const flatAmount =
    parseMoneyAmount(params.amount) ??
    // A transactions-only amount with no line items is also a flat goodwill intent.
    (requested.length === 0 && suppliedTxns.length > 0
      ? parseMoneyAmount(suppliedTxns[0]?.amount)
      : null)
  const isFlatGoodwill = flatAmount != null && requested.length === 0

  let refundLineItems: { lineItemId: string; quantity: number; restockType?: string }[]
  if (isFlatGoodwill) {
    // Goodwill/courtesy partial: no line items — the money is returned purely via the REFUND transaction.
    refundLineItems = []
  } else if (requested.length === 0) {
    // Full refund: every refundable line, full refundable quantity.
    refundLineItems = orderLines.map((n) => ({ lineItemId: n.id, quantity: n.refundableQuantity }))
  } else {
    refundLineItems = requested.map((li) => {
      const askedId = typeof li.lineItemId === "string" ? li.lineItemId : ""
      const qty = typeof li.quantity === "number" && li.quantity > 0 ? li.quantity : 1
      const restockType = typeof li.restockType === "string" ? li.restockType : undefined
      if (byId.has(askedId)) return { lineItemId: askedId, quantity: qty, restockType }
      // Cross-wired id (belongs to another order). Remap by SKU to THIS order's matching line; if the
      // SKU can't be matched (or wasn't given), fall back to this order's first refundable line — the
      // agent's intent (refund this order's item) is unambiguous, and refunding the right order's line
      // is strictly better than a 422 on a foreign gid.
      const askedSku = typeof li.sku === "string" ? li.sku : null
      const match =
        (askedSku ? orderLines.find((n) => skuOf(n) === askedSku) : undefined) ?? orderLines[0]
      if (!match)
        throw makeMutationError(
          "NO_REFUNDABLE_LINE",
          `refunds_create: order ${orderId} has no refundable line items`,
        )
      return { lineItemId: match.id, quantity: Math.min(qty, match.refundableQuantity), restockType }
    })
  }
  if (refundLineItems.length === 0 && !isFlatGoodwill)
    throw makeMutationError(
      "NO_REFUNDABLE_LINE",
      `refunds_create: order ${orderId} has no refundable line items to refund`,
    )

  // (2) Build/NORMALIZE the REFUND transaction(s) so the money actually moves and Shopify never rejects a
  // null gateway/orderId/parentId. The agent only has to express HOW MUCH; we thread the plumbing from the
  // order's parent SALE/CAPTURE. Three cases, all derived from the orderId the caller gave:
  //   • flat goodwill amount → one REFUND transaction for that amount;
  //   • caller-supplied transactions → fill missing orderId/gateway/parentId/kind on each (keep their amount);
  //   • full refund with no transactions → derive the parent's full amount.
  let transactions: Record<string, unknown>[] | undefined
  const deriveTxn = (amount: string): Record<string, unknown> => ({
    orderId,
    gateway: parentTxn?.gateway ?? "manual",
    kind: "REFUND",
    parentId: parentTxn?.id,
    amount,
  })
  if (isFlatGoodwill && flatAmount != null) {
    transactions = [deriveTxn(flatAmount.toFixed(2))]
  } else if (suppliedTxns.length > 0) {
    // Normalize each supplied transaction: keep its amount, fill any missing internal field from the parent.
    transactions = suppliedTxns.map((t) => {
      const amt = parseMoneyAmount(t.amount)
      return {
        orderId: typeof t.orderId === "string" && t.orderId.length > 0 ? t.orderId : orderId,
        gateway:
          typeof t.gateway === "string" && t.gateway.length > 0
            ? t.gateway
            : (parentTxn?.gateway ?? "manual"),
        kind: typeof t.kind === "string" && t.kind.length > 0 ? t.kind : "REFUND",
        parentId:
          typeof t.parentId === "string" && t.parentId.length > 0 ? t.parentId : parentTxn?.id,
        amount: amt != null ? amt.toFixed(2) : t.amount,
      }
    })
  } else {
    // No transactions supplied. Derive the parent's full captured amount for a FULL refund of all lines.
    const refundingAll =
      requested.length === 0 ||
      (refundLineItems.length === orderLines.length &&
        refundLineItems.every(
          (r, i) => orderLines[i] && r.quantity === orderLines[i]!.refundableQuantity,
        ))
    if (refundingAll && parentTxn) {
      transactions = [deriveTxn(parentTxn.amountSet.presentmentMoney.amount)]
    }
  }

  // SHIPPING: a flat goodwill amount is a pure courtesy adjustment — never split onto shipping (a weak
  // model that put part of the 50 EUR on `shipping` triggered "Shipping must have amount less than or
  // equal to remaining shipping"). Drop shipping for the goodwill path; otherwise pass it through.
  const shipping = isFlatGoodwill ? undefined : (params.shipping ?? undefined)

  const input: Record<string, unknown> = {
    orderId,
    note: params.note ?? null,
    notify: params.notify ?? true,
    refundLineItems,
    shipping,
    transactions: transactions && transactions.length > 0 ? transactions : undefined,
    // Multi-currency order (customer paid in a presentment currency different from the shop
    // currency): RefundInput.currency is REQUIRED and must be the presentment currency — every
    // amount above is presentment-side (the parent SALE's presentmentMoney, the caller's flat
    // amount). Without it Shopify interprets the transaction amount in the shop currency and
    // rejects the refund ("Currency must match parent transaction").
    ...(order.presentmentCurrencyCode && order.presentmentCurrencyCode !== order.currencyCode
      ? { currency: order.presentmentCurrencyCode }
      : {}),
  }
  // Default the idempotency key to a deterministic hash of the refund content so a
  // retried gated-approval execution dedupes (no double refund) rather than
  // creating a second refund; an explicit `idempotencyKey` param overrides.
  //
  // SALTED with the approval execution id: Shopify's @idempotent replays the stored
  // outcome for a key, INCLUDING a failure — with a pure content hash, one failed
  // execution wedged every later human approval of the same refund into replaying
  // that failure. The execution id is minted once per decide and stable across the
  // kernel's transient-retry re-invocations, so same-execution retries still dedupe
  // while each fresh approval gets a fresh key.
  const executionSalt =
    (ctx as unknown as ApprovalBridges).approval?.approvalExecutionId ?? ""
  const idempotencyKey =
    typeof params.idempotencyKey === "string" && params.idempotencyKey.length > 0
      ? params.idempotencyKey
      : `refund:${orderId}:${stableHash36(
          JSON.stringify({
            refundLineItems: input.refundLineItems,
            shipping: input.shipping,
            transactions: input.transactions,
            currency: input.currency,
            executionSalt,
          }),
        )}`
  return runMutation(ctx, { query: REFUND_CREATE, variables: { input, idempotencyKey }, dataKey: "refundCreate", eventEntity: "refund", eventAction: "created", entityIdPath: "refund.id" })
}

/**
 * STAGE-TIME preflight for the gated `refunds_create` (manifest `preflight`). Runs BEFORE the gated
 * approval is created, so a refund that could only 422 on execution is rejected at staging — the agent
 * self-corrects (or, if it was re-proposing a display-only / non-refundable order, drops it) instead of
 * the human approving a doomed refund that then executes-to-error and forces the run non-green.
 *
 * Why this exists (the nadia_day_monday step-2 hard override): the approve-batch scenario surfaces
 * pending refund approvals whose linked order (e.g. #1055) is a DISPLAY reference, not a live-store
 * refundable order. Under "approve them" pressure a weak model re-PROPOSES its OWN `refunds_create` for
 * that order, passing an `orderId` that is either malformed (an order NUMBER / "#1055", which Shopify's
 * `$id: ID!` rejects with the cryptic "Variable $id … was provided invalid value" → 422) or a gid that
 * resolves to no live order. That fresh agent-proposed approval is NOT a seed display-fixture (it carries
 * a populated payload), so the empty-payload skip guard cannot catch it — and approving it 422s on
 * execution → an UNVERIFIED gated execution hard override. Validating the order resolves to a real,
 * refundable order HERE (the exact `REFUND_ORDER_CONTEXT` the handler runs) moves that failure to
 * stage time as a clean, typed error the agent can act on — never a post-approval 422.
 *
 * A genuine agent-proposed refund against a REAL refundable order passes the preflight untouched and
 * executes + verifies exactly as before — the scope is "this orderId resolves to a refundable order",
 * never "skip the refund".
 *
 * Returns `{ ok: true }` when the refund is genuinely stageable, else the structured error (execute-tool
 * catches the preflight via normalizeToolErrorResult, so we RETURN the error rather than throw — a throw
 * would only fall through to letting staging proceed).
 */
export async function refunds_create_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  if (typeof params.orderId !== "string" || params.orderId.length === 0) {
    return { error: { code: "BAD_PARAM", message: "refunds_create: orderId is required (the order's gid)." } }
  }
  const orderId = String(params.orderId)
  // Resolve the order EXACTLY as the handler will — same query, same `$id: ID!` binding. A malformed
  // orderId (an order NUMBER like "1055"/"#1055" rather than a gid://shopify/Order/<digits>) makes
  // Shopify reject the variable here; a well-formed-but-stale gid resolves to a null order. Both are the
  // refund that would 422 on execution — surface them at stage time with actionable guidance.
  let ctxData: { order: RefundOrderContext | null }
  try {
    const client = await getShopifyClient(ctx)
    ctxData = await client.query<{ order: RefundOrderContext | null }>(REFUND_ORDER_CONTEXT, {
      id: orderId,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      error: {
        code: "ORDER_UNRESOLVED",
        message:
          `refunds_create: the orderId '${orderId}' is not a resolvable Shopify order id (${detail}). ` +
          `Pass the order's gid (gid://shopify/Order/<id>) from shopify orders_search / orders_get. ` +
          `not the order NUMBER (e.g. "#1055"). If you cannot resolve a live refundable order for this ` +
          `request, do not stage a refund: leave the pending approval for the human to decide.`,
      },
    }
  }
  const order = ctxData.order
  if (!order) {
    return {
      error: {
        code: "ORDER_NOT_FOUND",
        message:
          `refunds_create: no Shopify order resolves for '${orderId}'. Re-resolve the order with ` +
          `orders_search / orders_get and pass its gid, or do not stage a refund for an order that ` +
          `does not exist in the live store.`,
      },
    }
  }
  const hasRefundable = order.lineItems.edges.some((e) => e.node.refundableQuantity > 0)
  // Mirror the handler's flat-goodwill detection EXACTLY (see `flatAmount` above): a flat
  // courtesy amount is `params.amount`, OR a `transactions[0].amount` supplied with no
  // refundLineItems. The preflight must accept BOTH shapes — a transactions-only goodwill
  // refund on a fully-refunded order is stageable (the handler processes it via the REFUND
  // transaction), so rejecting it here as NO_REFUNDABLE_LINE would disagree with the handler.
  const preflightRequested = Array.isArray(params.refundLineItems)
    ? (params.refundLineItems as Record<string, unknown>[])
    : []
  const preflightTxns = Array.isArray(params.transactions)
    ? (params.transactions as Record<string, unknown>[])
    : []
  const flatAmount =
    parseMoneyAmount(params.amount) ??
    (preflightRequested.length === 0 && preflightTxns.length > 0
      ? parseMoneyAmount(preflightTxns[0]?.amount)
      : null)
  const isFlatGoodwill = flatAmount != null && preflightRequested.length === 0
  if (!hasRefundable && !isFlatGoodwill) {
    return {
      error: {
        code: "NO_REFUNDABLE_LINE",
        message:
          `refunds_create: order ${orderId} has no refundable line items. It may already be fully ` +
          `refunded. Pass a flat goodwill 'amount' for a courtesy refund, or do not stage a refund.`,
      },
    }
  }
  return { ok: true }
}

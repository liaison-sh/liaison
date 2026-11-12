// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: orders (update, note set, cancel).

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "../lib/get-client"
import {
  makeMutationError,
  type PreflightResult,
  preflightRefusal,
  readGatedTarget,
  requireTargetId,
  resolveMutationInput,
  runMutation,
} from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Orders — update (tags/notes), cancel  (C6: spec §3.2 mandated)
// ─────────────────────────────────────────────────────────────────────────

const ORDER_UPDATE = `
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id name tags note }
      userErrors { field message }
    }
  }
`
// Shopify OrderInput edits ONLY these. A weak model trying to "fix the shipping address" passes
// shippingAddress / lineItems — Shopify SILENTLY IGNORES unknown fields, so the gated approval looked
// legit + the agent falsely told the customer the address would change (BL-112). REJECT unsupported
// fields with a clear capability boundary so the agent reports honestly + proposes the real workaround.
const ORDER_UPDATE_SUPPORTED_FIELDS = new Set([
  "id",
  "tags",
  "note",
  "email",
  "customAttributes",
  "metafields",
])
/** Build + validate the OrderInput an order_update call resolves to. PURE (no network). Shared by the
 *  handler and its stage-time preflight so the capability-boundary refusal cannot drift. */
function buildOrderUpdateInput(params: Record<string, unknown>): Record<string, unknown> {
  const input = resolveMutationInput(params)
  if (!input.id && params.id) input.id = params.id
  if (!input.id) throw makeMutationError("BAD_PARAM", "id is required")
  const unsupported = Object.keys(input).filter((k) => !ORDER_UPDATE_SUPPORTED_FIELDS.has(k))
  if (unsupported.length > 0) {
    throw makeMutationError(
      "ORDER_UPDATE_UNSUPPORTED_FIELD",
      `order_update can only change an order's tags, note, email, or custom attributes: it CANNOT change ${unsupported.join(", ")} (e.g. the shipping address or line items). To correct a shipping address on an unshipped order, cancel + recreate it via a draft order, or hold fulfillment and correct it at the label/Boxtal stage. Do NOT tell the customer the address was changed.`,
    )
  }
  return input
}

/**
 * STAGE-TIME preflight for the gated `order_update` (manifest `preflight`). A gated call must not be
 * parked for a human when the change it asks for is impossible: orderUpdate silently ignores anything
 * outside tags, note, email and custom attributes, so a shipping-address edit would look approved and
 * change nothing. Refuse at staging, while the agent can still tell the customer the truth.
 */
export async function order_update_preflight(
  params: Record<string, unknown>,
  _ctx: AppContext,
): Promise<PreflightResult> {
  try {
    buildOrderUpdateInput(params)
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function order_update(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const input = buildOrderUpdateInput(params)
  return runMutation(ctx, {
    query: ORDER_UPDATE,
    variables: { input },
    dataKey: "orderUpdate",
    eventEntity: "order",
    eventAction: "edited",
    entityIdPath: "order.id",
  })
}

// ─────────────────────────────────────────────────────────────────────────
//  Orders — internal note set (Boxtal "To prepare" sync, UNGATED)
// ─────────────────────────────────────────────────────────────────────────
//
// Staff pass instructions through the Shopify order note. Boxtal's
// "To prepare" page reads it via orders_search/orders_get (reads.ts) and lets
// staff edit and save it back here.
//
// This is the only ungated write tool in this app, and that is deliberate
// (an owner decision). Every other write tool here is gated: true. A
// cross app call into a gated tool always parks a pending approval, because
// apps/api/src/modules/apps/sandbox/rpc-bridge.ts downgrades a human-ui
// origin to in-app-agent on the cross app hop, so the human self approve
// bypass never applies. That would put an approval card on every note save
// and make inline editing unusable. So order_note_set stays ungated and is
// contained instead by trustBoundary: "internal": apps/api/src/modules/apps/execute-tool.ts
// enforces that boundary against the caller's declared cross_app_calls
// targets, so only an app that declared this tool as a cross app target can
// reach it. The blast radius is one internal staff text field on one order:
// no email, no money, no fulfillment. Conflict policy is LAST WRITE WINS
// (owner decision), guarded by an OPTIONAL compare-and-set so a write never clobbers
// a note the editor never saw.

/** Normalize a bare numeric order id or an already-qualified gid to gid://shopify/Order/<n>. */
function normalizeOrderGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Order/${id}`
}

const ORDER_NOTE_GET = `
  query OrderNoteGet($id: ID!) {
    order(id: $id) { id note }
  }
`

const ORDER_NOTE_SET = `
  mutation OrderNoteSet($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id note }
      userErrors { field message }
    }
  }
`

export interface OrderNoteSetOk {
  ok: true
  order_id: string
  note: string | null
  previous_note: string | null
}
export interface OrderNoteSetConflict {
  ok: false
  reason: "conflict"
  order_id: string
  current_note: string | null
}

export async function order_note_set(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<OrderNoteSetOk | OrderNoteSetConflict> {
  const rawId = params.order_id
  if (typeof rawId !== "string" || rawId.length === 0) {
    throw makeMutationError("BAD_PARAM", "order_id is required")
  }
  const note = params.note
  if (note !== null && typeof note !== "string") {
    throw makeMutationError("BAD_PARAM", "note must be a string or null")
  }
  const orderId = normalizeOrderGid(rawId)
  const hasExpectedNote = Object.hasOwn(params, "expected_note")
  const expectedNote = params.expected_note

  let previousNote: string | null = null
  if (hasExpectedNote) {
    if (expectedNote !== null && typeof expectedNote !== "string") {
      throw makeMutationError("BAD_PARAM", "expected_note must be a string or null")
    }
    const client = await getShopifyClient(ctx)
    const data = await client.query<{ order?: { id: string; note?: string | null } | null }>(
      ORDER_NOTE_GET,
      { id: orderId },
    )
    const currentNote = data.order?.note ?? null
    if ((currentNote ?? "") !== ((expectedNote as string | null | undefined) ?? "")) {
      return { ok: false, reason: "conflict", order_id: orderId, current_note: currentNote }
    }
    previousNote = currentNote
  }

  const result = await runMutation<{ order?: { id: string; note?: string | null } }>(ctx, {
    query: ORDER_NOTE_SET,
    variables: { input: { id: orderId, note } },
    dataKey: "orderUpdate",
    eventEntity: "order",
    eventAction: "edited",
    entityIdPath: "order.id",
  })
  return {
    ok: true,
    order_id: orderId,
    note: result.order?.note ?? null,
    previous_note: previousNote,
  }
}

const ORDER_CANCEL = `
  mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean) {
    orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer) {
      job { id }
      userErrors { field message }
    }
  }
`
/**
 * STAGE-TIME preflight for the gated `order_cancel` (manifest `preflight`). Cancelling is the most
 * consequential thing this app does to an order, and the only check was that an orderId was present:
 * a mistyped gid, or a PRODUCT gid handed to an ORDER tool, parked an approval that could only fail
 * in the human's hands. Runs the SAME required-id guard the handler runs, plus a read-only probe.
 */
export async function order_cancel_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const orderId = requireTargetId(params, "orderId")
    await readGatedTarget(ctx, orderId, "Order", "order_cancel")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function order_cancel(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  requireTargetId(params, "orderId")
  return runMutation(ctx, {
    query: ORDER_CANCEL,
    variables: {
      orderId: params.orderId,
      reason: params.reason ?? "OTHER",
      refund: params.refund ?? false,
      restock: params.restock ?? false,
      notifyCustomer: params.notifyCustomer ?? true,
    },
    dataKey: "orderCancel",
    eventEntity: "order",
    eventAction: "cancel_requested",
    // entityIdPath would resolve to the async job GID, not the order id.
    // Supply the order id directly so attention-template interpolation works.
    entityIdOverride: String(params.orderId),
  })
}

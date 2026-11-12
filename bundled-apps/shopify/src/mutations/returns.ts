// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: returns (request, approve, decline, refund, close).

import type { AppContext } from "@liaison/app-sdk"
import {
  assertTargetState,
  isRec,
  makeMutationError,
  type PreflightResult,
  preflightRefusal,
  readGatedTarget,
  requireTargetId,
  resolveMutationInput,
  runMutation,
} from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Returns
// ─────────────────────────────────────────────────────────────────────────

const RETURN_REQUEST = `
  mutation ReturnRequest($input: ReturnRequestInput!) {
    returnRequest(input: $input) { return { id name status } userErrors { field message } }
  }
`
export async function returns_request(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  return runMutation(ctx, {
    query: RETURN_REQUEST,
    variables: { input: resolveMutationInput(params) },
    dataKey: "returnRequest",
    eventEntity: "return",
    eventAction: "requested",
    entityIdPath: "return.id",
  })
}

const RETURN_APPROVE = `
  mutation ReturnApproveRequest($input: ReturnApproveRequestInput!) {
    returnApproveRequest(input: $input) { return { id status } userErrors { field message } }
  }
`
// A return is a STATE MACHINE (REQUESTED -> OPEN/DECLINED -> CLOSED, or CANCELED), and each of the
// four gated return tools drives exactly one edge of it. Shopify rejects a transition the return
// cannot admit, but that rejection used to land only AFTER the human approved: the approver, not the
// agent, met "return is not in a requested state". The status is knowable at STAGE time, so refuse
// there instead. A return that legitimately moves between staging and the approve is a genuine race
// and stays with each handler's own userErrors, which are untouched.
const RETURN_STATES_APPROVABLE = ["REQUESTED"] as const
const RETURN_STATES_DECLINABLE = ["REQUESTED"] as const
const RETURN_STATES_CLOSABLE = ["OPEN"] as const
const RETURN_STATES_REFUNDABLE = ["OPEN", "CLOSED"] as const

/** Read the return a gated return tool targets, read only: it must exist, be a Return, and be in a
 *  state that admits this transition. Shared by all four return preflights. */
async function readReturnForTransition(
  ctx: AppContext,
  id: string,
  allowed: readonly string[],
  tool: string,
  action: string,
): Promise<void> {
  const node = await readGatedTarget(ctx, id, "Return", tool)
  assertTargetState(node, allowed, tool, "return", action)
}

/** The return id a `returns_refund` call targets. Accepts it on the ReturnRefundInput (where Shopify
 *  puts it) or at the top level. Shared by the handler and its preflight. */
function resolveReturnRefundId(params: Record<string, unknown>): string {
  const input = isRec(params.returnRefundInput) ? params.returnRefundInput : params
  const id = input.returnId ?? params.returnId
  if (typeof id === "string" && id.trim() !== "") return id
  throw makeMutationError("BAD_PARAM", "returnId is required")
}

/** STAGE-TIME preflight for the gated `returns_approve` (manifest `preflight`). */
export async function returns_approve_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = requireTargetId(params, "id")
    await readReturnForTransition(ctx, id, RETURN_STATES_APPROVABLE, "returns_approve", "approved")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function returns_approve(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
  return runMutation(ctx, {
    query: RETURN_APPROVE,
    variables: { input: { id: params.id } },
    dataKey: "returnApproveRequest",
    eventEntity: "return",
    eventAction: "approved",
    entityIdPath: "return.id",
  })
}

const RETURN_DECLINE = `
  mutation ReturnDeclineRequest($input: ReturnDeclineRequestInput!) {
    returnDeclineRequest(input: $input) { return { id status } userErrors { field message } }
  }
`
// Shopify ReturnDeclineRequestInput.declineReason is an ENUM (not free text). An agent naturally
// passes a human-readable sentence (e.g. "Warranty period of 2 years has expired…") which Shopify
// REJECTS ("Expected … to be one of: RETURN_PERIOD_ENDED, FINAL_SALE, OTHER"), failing the gated
// decline. Coerce any non-enum value to OTHER — the human-readable explanation belongs in the
// customer reply, not this structured enum.
const RETURN_DECLINE_REASONS = new Set(["RETURN_PERIOD_ENDED", "FINAL_SALE", "OTHER"])

/** STAGE-TIME preflight for the gated `returns_decline` (manifest `preflight`). */
export async function returns_decline_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = requireTargetId(params, "id")
    await readReturnForTransition(ctx, id, RETURN_STATES_DECLINABLE, "returns_decline", "declined")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function returns_decline(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
  const rawReason = typeof params.declineReason === "string" ? params.declineReason.trim() : ""
  const declineReason = RETURN_DECLINE_REASONS.has(rawReason) ? rawReason : "OTHER"
  return runMutation(ctx, {
    query: RETURN_DECLINE,
    variables: { input: { id: params.id, declineReason } },
    dataKey: "returnDeclineRequest",
    eventEntity: "return",
    eventAction: "declined",
    entityIdPath: "return.id",
  })
}

const RETURN_REFUND = `
  mutation ReturnRefund($returnRefundInput: ReturnRefundInput!) {
    returnRefund(returnRefundInput: $returnRefundInput) { refund { id } userErrors { field message } }
  }
`
/** STAGE-TIME preflight for the gated `returns_refund` (manifest `preflight`). Money leaves the
 *  store here, so a return that does not exist, or one already declined or cancelled, must be
 *  refused before a human is asked to approve a refund against it. */
export async function returns_refund_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = resolveReturnRefundId(params)
    await readReturnForTransition(ctx, id, RETURN_STATES_REFUNDABLE, "returns_refund", "refunded")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function returns_refund(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  resolveReturnRefundId(params)
  return runMutation(ctx, {
    query: RETURN_REFUND,
    variables: { returnRefundInput: params.returnRefundInput ?? params },
    dataKey: "returnRefund",
    eventEntity: "return",
    eventAction: "refunded",
    entityIdPath: "refund.id",
  })
}

const RETURN_CLOSE = `
  mutation ReturnClose($id: ID!) {
    returnClose(id: $id) { return { id status } userErrors { field message } }
  }
`
/** STAGE-TIME preflight for the gated `returns_close` (manifest `preflight`). */
export async function returns_close_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = requireTargetId(params, "id")
    await readReturnForTransition(ctx, id, RETURN_STATES_CLOSABLE, "returns_close", "closed")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function returns_close(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
  return runMutation(ctx, {
    query: RETURN_CLOSE,
    variables: { id: params.id },
    dataKey: "returnClose",
    eventEntity: "return",
    eventAction: "closed",
    entityIdPath: "return.id",
  })
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `deferred_dismiss` — close a park that must never issue an invoice: a staff test order, a voided
// order the shop still reports as paid, a sale invoiced by other means. The park is marked
// `resolved` with reason `dismissed` and the decision (reason, who, when, the approval) kept on its
// `blocked_on.dismissed`; its attention item closes. The order flow then skips that order for good
// (`parkDismissed`, read by shopify-order-paid.ts), so a webhook redelivery or a retry never issues
// it. Nothing is issued, nothing is mailed. GATED: a person decides.

import { refuseTool, type ToolRefusal } from "@liaison/app-sdk"
import { type ParkAttentionCtx, resolveParkAttention } from "../deferred"

export const DISMISSED_REASON = "dismissed"
const TERMINAL = new Set(["resolved", "permanent_failure"])
const REASON_MIN = 5
const REASON_MAX = 500

type Row = Record<string, unknown>

export interface DeferredDismissCtx {
  db: {
    findOne(entity: string, id: string): Promise<unknown | null>
    findMany(entity: string, opts?: Record<string, unknown>): Promise<unknown[]>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<unknown>
  }
  getUserId(): Promise<string>
  approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  emit?: ParkAttentionCtx["emit"]
}

export interface DeferredDismissInput {
  deferred_id?: string
  reason?: string
}

export type DeferredDismissResult =
  | { status: "completed"; deferred_id: string; order_id: string; message: string }
  | ToolRefusal

type Check = { ok: true; id: string; reason: string; row: Row } | { ok: false; error: ToolRefusal }

async function checkDismiss(ctx: DeferredDismissCtx, input: DeferredDismissInput): Promise<Check> {
  const id = typeof input?.deferred_id === "string" ? input.deferred_id.trim() : ""
  if (!id) return { ok: false, error: refuseTool("invalid_params", "deferred_id is required") }
  const reason = typeof input?.reason === "string" ? input.reason.trim() : ""
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return {
      ok: false,
      error: refuseTool(
        "reason_required",
        `reason is required: why this order must never be invoiced (${REASON_MIN} to ${REASON_MAX} characters, e.g. "staff test purchase").`,
      ),
    }
  }
  const row = (await ctx.db.findOne("deferred_events", id)) as Row | null
  if (!row) return { ok: false, error: refuseTool("not_found", `deferred event ${id} not found`) }
  if (TERMINAL.has(String(row.status ?? ""))) {
    return {
      ok: false,
      error: refuseTool(
        "already_resolved",
        `deferred event ${id} is already ${String(row.status)}`,
      ),
    }
  }
  return { ok: true, id, reason, row }
}

export async function deferredDismissPreflight(
  ctx: DeferredDismissCtx,
  input: DeferredDismissInput,
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const c = await checkDismiss(ctx, input)
  return c.ok ? { ok: true } : { error: c.error.error }
}

export async function deferredDismiss(
  ctx: DeferredDismissCtx,
  input: DeferredDismissInput,
): Promise<DeferredDismissResult> {
  const c = await checkDismiss(ctx, input)
  if (!c.ok) return c.error
  const { id, reason, row } = c
  const actor = await ctx.getUserId()
  const blocked = (row.blocked_on as Row | null) ?? {}
  const dismissed = {
    reason,
    by: ctx.approval?.approvalDeciderId ?? actor,
    requested_by: actor,
    at: new Date().toISOString(),
    approval_request_id: ctx.approval?.approvalRequestId ?? null,
    previous_status: String(row.status ?? ""),
    previous_reason: (row.reason as string | null) ?? null,
  }
  await ctx.db.update("deferred_events", id, {
    status: "resolved",
    reason: DISMISSED_REASON,
    blocked_on: { ...blocked, dismissed },
  })
  await resolveParkAttention(ctx as ParkAttentionCtx, { id, blocked_on: blocked })
  const orderId = String(row.event_id ?? "")
  if (ctx.emit) {
    await ctx.emit({
      entity: "deferred",
      action: "dismissed",
      entityId: id,
      data: {
        deferred_id: id,
        order_id: orderId,
        reason,
        previous_reason: dismissed.previous_reason,
      },
    })
  }
  return {
    status: "completed",
    deferred_id: id,
    order_id: orderId,
    message: `The park is dismissed (${reason}). This order is never invoiced automatically; nothing was issued or mailed.`,
  }
}

/** True once a person dismissed a park of this event: its sale is never issued by the order flow. */
export async function parkDismissed(
  db: { findMany(entity: string, opts?: Record<string, unknown>): Promise<unknown[]> },
  eventId: string,
): Promise<boolean> {
  if (!eventId) return false
  const rows = (await db.findMany("deferred_events", {
    where: { event_id: eventId, reason: DISMISSED_REASON },
    limit: 1,
  })) as Row[]
  return rows.some((r) => r.status === "resolved")
}

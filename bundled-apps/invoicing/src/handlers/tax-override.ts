// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `deferred_tax_override` — the human resolution of a tax review park.
//
// The order handler parks an order instead of issuing when its tax cannot be trusted as is: our
// computed tax disagrees with Shopify's reported amount (shopify_tax_mismatch), seller tax sits on
// an exempt treatment (tax_on_exempt_treatment), or a line would take the OSS placeholder rate
// (tax_rate_placeholder). Those facts never change on their own, so the retry cron leaves the park
// alone (deferred.ts HUMAN_REVIEW_KINDS) and a person decides here, through a GATED call:
//   - `shopify_reported`: issue with the tax Shopify reported on each line,
//   - `as_computed`: issue with the tax treatment's own rate on every line.
// The decision re-drives the ordinary order flow (same documents, numbering, PDF, email), resolves
// the park, records the choice on every issued document and clears the attention row.

import { refuseTool, type ToolRefusal } from "@liaison/app-sdk"
import { needsHumanReview } from "../deferred"
import {
  onShopifyOrderPaid,
  type OrderPaidCtx,
  type OrderPaidPayload,
  type TaxOverrideMode,
} from "./shopify-order-paid"

export const TAX_OVERRIDE_MODES: readonly TaxOverrideMode[] = ["shopify_reported", "as_computed"]

const TERMINAL = new Set(["resolved", "permanent_failure"])

export type TaxOverrideResult =
  | {
      status: "completed"
      deferred_id: string
      mode: TaxOverrideMode
      documents: Array<{ document_id: string; number: string; scope: string }>
    }
  | { status: "error"; error: { code: string; message: string } }
  | ToolRefusal

function err(code: string, message: string): TaxOverrideResult {
  return { status: "error", error: { code, message } }
}

type ParkCheck =
  | { ok: true; id: string; mode: TaxOverrideMode; row: Record<string, unknown> }
  | { ok: false; error: ToolRefusal }

/** A deliberate refusal (refuseTool): the host answers it as a 4xx at warn, never a 500 fault. */
function refuse(code: string, message: string): ParkCheck {
  return { ok: false, error: refuseTool(code, message) }
}

/**
 * The checks shared by the stage-time preflight and the handler: the params are well formed, the
 * park exists, is still open and is a tax review. Read-only.
 */
async function checkPark(
  ctx: OrderPaidCtx,
  input: { deferred_id?: string; mode?: string },
): Promise<ParkCheck> {
  const id = typeof input.deferred_id === "string" ? input.deferred_id.trim() : ""
  if (!id) return refuse("invalid_params", "deferred_id is required")
  const mode = input.mode as TaxOverrideMode
  if (!TAX_OVERRIDE_MODES.includes(mode)) {
    return refuse("invalid_params", `mode must be one of: ${TAX_OVERRIDE_MODES.join(", ")}`)
  }
  const row = (await ctx.db.findOne("deferred_events", id)) as Record<string, unknown> | null
  if (!row) return refuse("not_found", `deferred event ${id} not found`)
  if (TERMINAL.has(String(row.status ?? ""))) {
    return refuse("already_resolved", `deferred event ${id} is already ${String(row.status)}`)
  }
  const blockedOn = (row.blocked_on as Record<string, unknown> | null) ?? {}
  if (!needsHumanReview(blockedOn)) {
    return refuse(
      "not_a_tax_review",
      `deferred event ${id} is parked on ${String(blockedOn.kind ?? "unknown")}, not a tax review; it retries on its own once its blocker is fixed`,
    )
  }
  return { ok: true, id, mode, row }
}

/**
 * STAGE-TIME preflight for the gated `deferred_tax_override` (manifest `preflight`): a call on a
 * missing, already resolved or non tax review park is refused before the approval exists. The
 * handler re-runs the same checks, since the park can be resolved while the approval is pending.
 */
export async function deferredTaxOverridePreflight(
  ctx: OrderPaidCtx,
  input: { deferred_id?: string; mode?: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const check = await checkPark(ctx, input)
  return check.ok ? { ok: true } : { error: check.error.error }
}

export async function deferredTaxOverride(
  ctx: OrderPaidCtx,
  input: { deferred_id?: string; mode?: string },
): Promise<TaxOverrideResult> {
  const check = await checkPark(ctx, input)
  if (!check.ok) return check.error
  const { id, mode, row } = check
  const payload = row.event_payload_json as OrderPaidPayload
  const result = await onShopifyOrderPaid({ ...payload, tax_override: { mode, deferred_id: id } }, ctx)
  if (result.status === "deferred" || result.status === "pending_approval") {
    return err(
      "still_blocked",
      result.status === "deferred"
        ? `the order is still blocked (${result.reason}): fix that blocker first`
        : "the order needs its threshold approval first",
    )
  }
  if (result.status === "skipped" && result.reason !== "duplicate_document") {
    return err("not_issued", `the order was not issued: ${result.reason}`)
  }

  const actor = await ctx.getUserId()
  const now = new Date().toISOString()
  const documents = result.status === "ok" ? result.documents : []
  for (const d of documents) {
    const doc = (await ctx.db.findOne("documents", d.document_id)) as Record<string, unknown> | null
    const log = (doc?.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
    await ctx.db.update("documents", d.document_id, {
      lifecycle_log: [
        ...log,
        { event: "tax_override", actor, ts: now, mode, deferred_id: id, park_reason: row.reason ?? null },
      ],
    })
  }
  await ctx.db.update("deferred_events", id, { status: "resolved", reason: `tax_override_${mode}` })
  if (ctx.emit) {
    await ctx.emit({
      entity: "deferred",
      action: "tax_review",
      entityId: id,
      data: { deferred_id: id, order_id: payload.id, order_label: payload.order_number ?? payload.id, reason: row.reason ?? null, resolved: true },
    })
  }
  return {
    status: "completed",
    deferred_id: id,
    mode,
    documents: documents.map((d) => ({ document_id: d.document_id, number: d.number, scope: d.scope })),
  }
}

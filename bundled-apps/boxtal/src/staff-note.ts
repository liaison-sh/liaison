// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Shopify order's internal staff note, edited inline from the To-prepare grid.
//
// Staff write instructions on the order in Shopify admin; the grid reads them off the order
// scan (orders.ts maps `attributes.note` / `note` onto the row's `staff_note`) and saves an edit
// back through `shopify:order_note_set`, the one ungated internal-boundary write the Shopify app
// exposes for exactly this (an approval card on every keystroke would make inline editing
// unusable). Conflict policy is compare-and-set on the note the grid last showed: a concurrent
// edit in Shopify admin is refused with the fresh value, never clobbered.

import type { BoxtalToolCtx } from "./ctx"
import { ToolError } from "@liaison/app-sdk"
import { parseOrderKey } from "./order-state"
import { toShopifyOrderGid } from "./shopify-ref"

export interface PrepSetNoteInput {
  order_key: string
  note: string | null
  /** The note the caller last read (null when none). Present: refuse when Shopify now differs. */
  expected_note?: string | null
}

export type PrepSetNoteResult =
  | { ok: true; order_key: string; note: string | null }
  | { ok: false; reason: "conflict"; order_key: string; current_note: string | null }

interface OrderNoteSetOk {
  ok: true
  note: string | null
}
interface OrderNoteSetConflict {
  ok: false
  reason: "conflict"
  current_note: string | null
}

function normalizeNote(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "string") {
    throw new ToolError("note must be a string or null.", { code: "invalid_note", retryable: false })
  }
  const trimmed = raw.trim()
  return trimmed === "" ? null : trimmed
}

export async function prepSetNote(ctx: BoxtalToolCtx, input: PrepSetNoteInput): Promise<PrepSetNoteResult> {
  const parsed = typeof input?.order_key === "string" ? parseOrderKey(input.order_key) : null
  if (!parsed) {
    throw new ToolError(
      `"${String(input?.order_key)}" is not a prep row key. Expected so:<order id>.`,
      { code: "invalid_order_key", retryable: false },
    )
  }
  if (parsed.kind !== "order") {
    throw new ToolError(
      "Only a Shopify order row carries a staff note; an order-less row has none to set. Use prep_set_status with a note for those.",
      { code: "no_order", retryable: false },
    )
  }
  const note = normalizeNote(input.note)
  const hasExpected = Object.prototype.hasOwnProperty.call(input, "expected_note")
  const args: Record<string, unknown> = { order_id: toShopifyOrderGid(parsed.id), note }
  if (hasExpected) args.expected_note = normalizeNote(input.expected_note)

  const env = await ctx.executeTool("shopify:order_note_set", args)
  if (env.status === "error") {
    throw new ToolError(`Shopify refused the note: ${env.error.message}`, {
      code: env.error.code || "shopify_error",
      retryable: env.error.retryable ?? false,
    })
  }
  if (env.status === "pending_approval") {
    // order_note_set is ungated by contract; a parked write means the Shopify manifest changed
    // under us, and silently reporting success would show a note Shopify does not hold.
    throw new ToolError("Shopify parked the note write for approval; it is not saved.", {
      code: "note_pending_approval",
      retryable: false,
    })
  }
  const res = env.result as OrderNoteSetOk | OrderNoteSetConflict
  if (res && res.ok === false) {
    return { ok: false, reason: "conflict", order_key: input.order_key, current_note: res.current_note ?? null }
  }
  const saved = res?.note ?? note
  await cacheStaffNote(ctx, parsed.id, saved)
  return { ok: true, order_key: input.order_key, note: saved }
}

/** Keep the cached order facts in step, so a cache-mode or fail-soft read shows the saved note. */
async function cacheStaffNote(ctx: BoxtalToolCtx, shopifyOrderId: string, note: string | null): Promise<void> {
  const metas = (await ctx.db.findMany("prep_meta", {
    where: { shopify_order_id: shopifyOrderId },
    limit: 50,
  })) as Array<{ id: string }>
  for (const m of metas) await ctx.db.update("prep_meta", m.id, { staff_note: note })
}

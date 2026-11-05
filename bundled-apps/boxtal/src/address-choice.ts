// SPDX-License-Identifier: FSL-1.1-ALv2
//
// prep_set_address_choice: a person picks which address a label goes to when the order's own
// ship-to and the customer's VERIFIED delivery address are not the same place.
//
// Until a person picks, create_shipment refuses to stage (shipment.ts addressPickBlock). The pick
// is stored on the order's prep state together with a hash of BOTH addresses as they read now, so
// a later change to either one (the order edited in the store, the address book edited or
// re-verified) voids it and the row is held again.
//
// Gated with noAutoApprove in the manifest: a person's own click runs it, an agent's call waits for
// a person, and no auto-approve policy can answer it.
import { ToolError } from "@liaison/app-sdk"
import { type AddressCheck, type AddressChoiceRecord, type AddressPick, addressPairHash, needsAddressPick } from "./address-check"
import type { BoxtalToolCtx } from "./ctx"
import { deriveDraftFacts } from "./draft-cache"
import { orderKeyForDocumentRef, parseOrderKey, upsertPrepOrderState } from "./order-state"
import { refreshCachedShipTo } from "./prep-meta"
import { ORDER_UNREADABLE_MESSAGE, shipmentDraftCreate } from "./shipment"

export interface PrepSetAddressChoiceInput {
  document_ref: string
  choice: AddressPick
  /** The verified address picked, as prep_list's address_check.verified_address.id shows it. */
  address_id?: string | null
}

export interface PrepSetAddressChoiceResult {
  ok: true
  order_key: string
  choice: AddressPick
  address_check: AddressCheck | null
}

/**
 * Every check prep_set_address_choice makes before it stores a pick, in one place: the handler
 * runs it, and so does the stage-time preflight (which skips the grid cache refresh, its only
 * write), so a pick the handler would refuse is refused before a person is asked to approve it.
 */
async function resolveAddressChoice(
  ctx: BoxtalToolCtx,
  input: PrepSetAddressChoiceInput,
  opts: { preflight: boolean },
) {
  const documentRef = typeof input?.document_ref === "string" ? input.document_ref.trim() : ""
  if (!documentRef) {
    throw new ToolError("prep_set_address_choice needs the row's document_ref.", { code: "invalid_input", retryable: false })
  }
  const pick = input.choice
  if (pick !== "order" && pick !== "verified") {
    throw new ToolError(`Unknown choice "${String(pick)}". Use "order" or "verified".`, {
      code: "invalid_choice",
      retryable: false,
    })
  }

  // The pick is tied to the addresses as they read NOW: build from a live order read, and store
  // that read on the worklist's cache so the grid compares against the same addresses.
  const first = await shipmentDraftCreate(ctx, { document_ref: documentRef })
  const orderKey = await orderKeyForDocumentRef(ctx, documentRef)
  const parsedKey = parseOrderKey(orderKey)
  const orderId = parsedKey?.kind === "order" ? parsedKey.id : null
  if (orderId && !opts.preflight) await refreshCachedShipTo(ctx, documentRef, orderId)
  const check = first.address_check
  if (check?.order_read === "failed") {
    throw new ToolError(ORDER_UNREADABLE_MESSAGE, { code: "order_unreadable", retryable: true })
  }
  if (!orderId || !needsAddressPick(check)) {
    throw new ToolError(
      "Nothing to pick: this row's order address and the customer's verified address do not differ (or one of them is missing).",
      { code: "address_choice_not_needed", retryable: false },
    )
  }
  const verifiedId = check.verified_address.id
  if (pick === "verified" && input.address_id && input.address_id !== verifiedId) {
    throw new ToolError(
      `Verified address ${input.address_id} is not the one this row compares against (${verifiedId}). Re-read the row and pick again.`,
      { code: "address_choice_stale", retryable: false },
    )
  }
  return { documentRef, pick, orderKey, orderId, check, verifiedId }
}

/**
 * prep_set_address_choice STAGE-TIME preflight (manifest `preflight`): the handler's own checks
 * (a known row, a valid choice, a readable order, addresses that really differ, the verified
 * address still the one compared against). Read-only.
 */
export async function prepSetAddressChoicePreflight(
  ctx: BoxtalToolCtx,
  input: PrepSetAddressChoiceInput,
): Promise<{ ok: true } | { error: { code: string; message: string; retryable: boolean } }> {
  try {
    await resolveAddressChoice(ctx, input, { preflight: true })
    return { ok: true }
  } catch (err) {
    if (err instanceof ToolError) return { error: { code: err.code, message: err.message, retryable: err.retryable === true } }
    throw err
  }
}

export async function prepSetAddressChoice(
  ctx: BoxtalToolCtx,
  input: PrepSetAddressChoiceInput,
): Promise<PrepSetAddressChoiceResult> {
  const { documentRef, pick, orderKey, orderId, check, verifiedId } = await resolveAddressChoice(ctx, input, {
    preflight: false,
  })
  const record: AddressChoiceRecord = {
    pick,
    address_id: pick === "verified" ? verifiedId : null,
    hash: addressPairHash(check.order_address, check.verified_address),
    chosen_at: new Date().toISOString(),
    // The approver of an agent's call, else the person whose own click ran it.
    chosen_by: ctx.approval?.approvalDeciderId ?? (await callingUserId(ctx)),
  }
  await upsertPrepOrderState(ctx, orderKey, { address_choice: record }, { anchorRef: documentRef, shopifyOrderId: orderId })

  // Rebuild with the pick applied and patch the row's cached recipient, so a Ship click from the
  // grid sends the picked address and the chip reads the pick without waiting for the next sync.
  const after = await shipmentDraftCreate(ctx, { document_ref: documentRef })
  await patchCachedRecipient(ctx, documentRef, after)
  return { ok: true, order_key: orderKey, choice: pick, address_check: after.address_check ?? null }
}

async function callingUserId(ctx: BoxtalToolCtx): Promise<string | null> {
  try {
    const id = await ctx.getUserId?.()
    return typeof id === "string" && id.trim() !== "" ? id : null
  } catch {
    return null
  }
}

async function patchCachedRecipient(
  ctx: BoxtalToolCtx,
  documentRef: string,
  draft: Awaited<ReturnType<typeof shipmentDraftCreate>>,
): Promise<void> {
  try {
    const rows = (await ctx.db.findMany("prep_draft_cache", { where: { document_ref: documentRef }, limit: 1 })) as Array<{
      id: string
    }>
    if (!rows[0]) return
    const facts = deriveDraftFacts(draft, documentRef)
    await ctx.db.update("prep_draft_cache", rows[0].id, {
      recipient: facts.recipient,
      recipient_phone_issue: facts.recipient_phone_issue,
      address_check: facts.address_check,
    })
  } catch (err) {
    // The pick is stored; the row's cache catches up on its next read.
    ctx.logger?.warn?.("prep: could not refresh the row after an address pick", { document_ref: documentRef, err: String(err) })
  }
}

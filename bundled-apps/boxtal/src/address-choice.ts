// SPDX-License-Identifier: FSL-1.1-ALv2
//
// prep_set_address_choice: a person picks which address a label goes to when the order's own
// ship-to and the customer's VERIFIED delivery address are not the same place.
//
// Until a person picks, create_shipment refuses to stage (shipment.ts addressPickBlock). The pick
// is stored on the order's prep state together with a hash of BOTH addresses, so a later change to
// either one (the order edited in the store, the address book edited or re-verified) voids it and
// the row is held again.
//
// Gated with noAutoApprove in the manifest: a person's own click runs it, an agent's call waits for
// a person, and no auto-approve policy can answer it. What can be refused is refused before anyone
// is asked (prepSetAddressChoicePreflight), and the preflight pins the two addresses it read
// (`shown_addresses`, never the caller's): the card shows those, and the execution refuses when the
// live ones are no longer them, so a pick is only ever stored against what the person saw.
import { ToolError } from "@liaison/app-sdk"
import {
  type AddressCheck,
  type AddressChoiceRecord,
  type AddressPick,
  addressPairHash,
  needsAddressPick,
} from "./address-check"
import type { BoxtalToolCtx } from "./ctx"
import { deriveDraftFacts } from "./draft-cache"
import { orderKeyForDocumentRef, parseOrderKey, upsertPrepOrderState } from "./order-state"
import { refreshCachedShipTo } from "./prep-meta"
import {
  ORDER_UNREADABLE_MESSAGE,
  type RecipientAddressInput,
  shipmentDraftCreate,
} from "./shipment"

export interface PrepSetAddressChoiceInput {
  document_ref: string
  choice: AddressPick
  /** The verified address picked, as prep_list's address_check.verified_address.id shows it. */
  address_id?: string | null
  /** Pinned by the preflight, whatever the caller sent. */
  shown_addresses?: ShownAddresses | null
}

/** The fields of an address the approval card prints. */
type ShownAddress = Pick<
  RecipientAddressInput,
  "name" | "company" | "street" | "city" | "postalCode" | "countryIsoCode"
>

/** The two addresses a pick is decided on, as the preflight read them and the card shows them. */
export interface ShownAddresses {
  order_address: ShownAddress
  verified_address: ShownAddress
  hash: string
}

function shownAddress(a: RecipientAddressInput): ShownAddress {
  return {
    name: a.name,
    company: a.company,
    street: a.street,
    city: a.city,
    postalCode: a.postalCode,
    countryIsoCode: a.countryIsoCode,
  }
}

export interface PrepSetAddressChoiceResult {
  ok: true
  order_key: string
  choice: AddressPick
  address_check: AddressCheck | null
}

const ADDRESSES_CHANGED_MESSAGE =
  "The order's address or the verified address changed after this pick was requested, so it was not applied and the row stays held. Read the row again and pick again."

/** The document_ref and choice, or the refusal any call gets whatever the addresses read. */
function parseInput(input: PrepSetAddressChoiceInput): { documentRef: string; pick: AddressPick } {
  const documentRef = typeof input?.document_ref === "string" ? input.document_ref.trim() : ""
  if (!documentRef) {
    throw new ToolError("prep_set_address_choice needs the row's document_ref.", {
      code: "invalid_input",
      retryable: false,
    })
  }
  const pick = input.choice
  if (pick !== "order" && pick !== "verified") {
    throw new ToolError(`Unknown choice "${String(pick)}". Use "order" or "verified".`, {
      code: "invalid_choice",
      retryable: false,
    })
  }
  return { documentRef, pick }
}

/** The order's address could not be read: nobody knows yet whether there is anything to pick. */
function refuseUnreadable(check: AddressCheck | null | undefined): void {
  if (check?.order_read === "failed") {
    throw new ToolError(ORDER_UNREADABLE_MESSAGE, { code: "order_unreadable", retryable: true })
  }
}

const NOTHING_TO_PICK_MESSAGE =
  "Nothing to pick: this row's order address and the customer's verified address do not differ (or one of them is missing)."

function refuseOtherVerified(
  pick: AddressPick,
  addressId: string | null | undefined,
  verifiedId: string,
): void {
  if (pick === "verified" && addressId && addressId !== verifiedId) {
    throw new ToolError(
      `Verified address ${addressId} is not the one this row compares against (${verifiedId}). Re-read the row and pick again.`,
      { code: "address_choice_stale", retryable: false },
    )
  }
}

/**
 * Stage-time preflight (execute-tool.ts): everything that would only come back as a refusal after a
 * person decided is refused here, with no side effect, and the addresses the decision is about are
 * pinned on the call. It returns the refusal instead of throwing, like createShipmentPreflight.
 */
export async function prepSetAddressChoicePreflight(
  ctx: BoxtalToolCtx,
  input: PrepSetAddressChoiceInput,
): Promise<
  | { ok: true; pinnedParams: { shown_addresses: ShownAddresses } }
  | { error: { code: string; message: string; retryable: boolean } }
> {
  try {
    const { documentRef, pick } = parseInput(input)
    const draft = await shipmentDraftCreate(ctx, { document_ref: documentRef })
    const check = draft.address_check
    refuseUnreadable(check)
    const parsedKey = parseOrderKey(await orderKeyForDocumentRef(ctx, documentRef))
    if (parsedKey?.kind !== "order" || !needsAddressPick(check)) {
      throw new ToolError(NOTHING_TO_PICK_MESSAGE, {
        code: "address_choice_not_needed",
        retryable: false,
      })
    }
    refuseOtherVerified(pick, input.address_id, check.verified_address.id)
    return {
      ok: true,
      pinnedParams: {
        shown_addresses: {
          order_address: shownAddress(check.order_address),
          verified_address: shownAddress(check.verified_address),
          hash: addressPairHash(check.order_address, check.verified_address),
        },
      },
    }
  } catch (err) {
    if (err instanceof ToolError) {
      return { error: { code: err.code, message: err.message, retryable: err.retryable } }
    }
    return {
      error: {
        code: "draft_unresolved",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      },
    }
  }
}

export async function prepSetAddressChoice(
  ctx: BoxtalToolCtx,
  input: PrepSetAddressChoiceInput,
): Promise<PrepSetAddressChoiceResult> {
  const { documentRef, pick } = parseInput(input)

  // Compared with what the preflight pinned: build from a live order read, and store that read on
  // the worklist's cache so the grid compares against the same addresses.
  const first = await shipmentDraftCreate(ctx, { document_ref: documentRef })
  const orderKey = await orderKeyForDocumentRef(ctx, documentRef)
  const parsedKey = parseOrderKey(orderKey)
  const orderId = parsedKey?.kind === "order" ? parsedKey.id : null
  if (orderId) await refreshCachedShipTo(ctx, documentRef, orderId)
  const check = first.address_check
  refuseUnreadable(check)
  // No pinned addresses: a call staged before they were pinned, whose card showed another read.
  const shownHash = input.shown_addresses?.hash ?? null
  if (!orderId || !needsAddressPick(check)) {
    throw new ToolError(shownHash ? ADDRESSES_CHANGED_MESSAGE : NOTHING_TO_PICK_MESSAGE, {
      code: shownHash ? "address_choice_stale" : "address_choice_not_needed",
      retryable: false,
    })
  }
  const verifiedId = check.verified_address.id
  refuseOtherVerified(pick, input.address_id, verifiedId)
  const hash = addressPairHash(check.order_address, check.verified_address)
  if (shownHash !== hash) {
    throw new ToolError(ADDRESSES_CHANGED_MESSAGE, {
      code: "address_choice_stale",
      retryable: false,
    })
  }

  const record: AddressChoiceRecord = {
    pick,
    address_id: pick === "verified" ? verifiedId : null,
    hash,
    chosen_at: new Date().toISOString(),
    // The approver of an agent's call, else the person whose own click ran it.
    chosen_by: ctx.approval?.approvalDeciderId ?? (await callingUserId(ctx)),
  }
  await upsertPrepOrderState(
    ctx,
    orderKey,
    { address_choice: record },
    { anchorRef: documentRef, shopifyOrderId: orderId },
  )

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
    const rows = (await ctx.db.findMany("prep_draft_cache", {
      where: { document_ref: documentRef },
      limit: 1,
    })) as Array<{
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
    ctx.logger?.warn?.("prep: could not refresh the row after an address pick", {
      document_ref: documentRef,
      err: String(err),
    })
  }
}

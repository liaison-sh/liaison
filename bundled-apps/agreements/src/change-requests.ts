// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A change request's decision. A change request is an agreement of kind `change_request` under
// a signed parent; its client approves it on a link with the emailed code, which is a recorded
// approval, not a signature (`level = recorded_approval`). Its version is sealed and stamped
// by the same pipeline as a signature. Approved, the change request is accepted and the
// parent's amended total rises by its price, once, in one transaction; declined, nothing
// changes anywhere. The decision itself starts no work, creates no invoice and turns nothing
// on: what follows is announced by `change_request:accepted`.

import type { AgreementsCtx } from "./ctx"

export const CHANGE_REQUEST = "change_request"
/** The level a change request's approval is recorded at: never a signature. */
export const RECORDED_APPROVAL = "recorded_approval"

export interface ChangeRequestRow {
  id: string
  number: string
  kind: string
  status: string
  parent_agreement_id?: string | null
  price_minor?: string | number | null
  hours_minutes?: number | null
  rate_minor?: string | number | null
  currency?: string | null
}

interface ParentRow {
  id: string
  number: string
  price_minor?: string | number | null
  amended_total_minor?: string | number | null
}

/** Money in minor units, read from the database's decimal string (never a float). */
function minor(v: unknown): bigint {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v)
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v)
  return 0n
}

/** The change request's price: its own, else its hours at its rate (rounded to the minor unit). */
export function changeRequestPrice(cr: ChangeRequestRow): bigint {
  if (cr.price_minor !== null && cr.price_minor !== undefined) return minor(cr.price_minor)
  const minutes = BigInt(Math.max(0, Math.trunc(cr.hours_minutes ?? 0)))
  return (minutes * minor(cr.rate_minor) + 30n) / 60n
}

/** Which decisions a record of this kind takes: a change request is approved, never signed. */
export function decisionFits(kind: string, decision: string | null): boolean {
  if (kind === CHANGE_REQUEST) return decision === "approved"
  return decision === "signed" || decision === "accepted"
}

/**
 * The approved change request is accepted, its version marked signed (for the seal) and its
 * parent's amended total raised by its price, in one transaction guarded on the change
 * request still waiting: a second delivery of the
 * same decision changes nothing. Answers whether this call made the change.
 */
export async function acceptChangeRequest(
  ctx: AgreementsCtx,
  cr: ChangeRequestRow,
  waiting: readonly string[],
  versionId: string,
): Promise<{ accepted: boolean; amended_total_minor?: string; parent_number?: string }> {
  const parentId = cr.parent_agreement_id
  const parent = parentId
    ? ((await ctx.db.findOne("agreements", parentId)) as ParentRow | null)
    : null
  const price = changeRequestPrice(cr)
  const base = parent ? minor(parent.amended_total_minor ?? parent.price_minor ?? null) : 0n
  const total = (base + price).toString()
  try {
    await ctx.db.batch({
      ops: [
        {
          // The host refuses `id` in a bulk write's filter: a change request is found by its
          // parent and its number, which are unique together (its number's sequence).
          updateMany: "agreements",
          where: {
            parent_agreement_id: parentId ?? null,
            number: cr.number,
            kind: CHANGE_REQUEST,
            status: { in: [...waiting] },
          },
          data: { status: "accepted" },
          expect: { minRows: 1 },
        },
        { update: "agreement_versions", id: versionId, data: { status: "signed" } },
        ...(parent
          ? [{ update: "agreements", id: parent.id, data: { amended_total_minor: total } }]
          : []),
      ],
    })
  } catch {
    // Already accepted by an earlier delivery (or no longer waiting): nothing moves.
    return { accepted: false }
  }
  await ctx.emit?.({
    entity: CHANGE_REQUEST,
    action: "accepted",
    entityId: cr.id,
    data: {
      number: cr.number,
      parent_agreement_id: parentId ?? null,
      parent_number: parent?.number ?? null,
      price_minor: price.toString(),
      currency: cr.currency ?? null,
      hours_minutes: cr.hours_minutes ?? null,
      amended_total_minor: parent ? total : null,
    },
  })
  return { accepted: true, amended_total_minor: total, parent_number: parent?.number }
}

/** A declined change request: its own status, and the event; the parent is untouched. */
export async function declineChangeRequest(ctx: AgreementsCtx, cr: ChangeRequestRow) {
  await ctx.emit?.({
    entity: CHANGE_REQUEST,
    action: "declined",
    entityId: cr.id,
    data: { number: cr.number, parent_agreement_id: cr.parent_agreement_id ?? null },
  })
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A send cut off half way: its links went out (the kernel makes all of them or none) and the
// run that asked was killed before the agreement left draft. Nothing here sends anything. It
// reads that a draft's frozen version has links that stand, and marks the agreement sent once,
// whoever sees it first: the kernel's `client_action:links_made`, a signer's decision, the
// person's own next call, or the job that looks every 10 minutes.

import { CHANGE_REQUEST } from "./change-requests"
import type { AgreementsCtx } from "./ctx"
import type { SigningLink } from "./send"

interface AgreementState {
  id: string
  number: string
  status: string
  kind: string
  parent_agreement_id?: string | null
}

interface VersionState {
  id: string
  number: number
  status: string
  frozen_at?: string | null
}

/** A link that still counts: it can be answered, waits for its turn, or was answered. */
const STANDS = new Set(["open", "waiting_turn", "locked", "decided", "declined"])

export const standing = (links: readonly SigningLink[]): SigningLink[] =>
  links.filter((l) => l.replaced !== true && STANDS.has(l.state))

/**
 * The run of a change request mails its reply right after its link: for these minutes a draft
 * change request with a link is one being sent, not one cut off.
 */
const CHANGE_REQUEST_RUN_MS = 10 * 60_000

/** A change request whose own run may still be at work on it. */
export function stillSending(
  a: { kind: string },
  v: { frozen_at?: string | null },
  now = Date.now(),
): boolean {
  if (a.kind !== CHANGE_REQUEST) return false
  const at = v.frozen_at ? Date.parse(v.frozen_at) : Number.NaN
  return Number.isFinite(at) && now - at < CHANGE_REQUEST_RUN_MS
}

/**
 * Moves a draft to `sent` and says so once. Guarded on the draft: an agreement already sent,
 * signed or voided by then keeps its state, and nothing is announced twice. The host refuses
 * `id` in a bulk write's filter; a number is unique in its series, and under its parent.
 */
export async function markSent(
  ctx: AgreementsCtx,
  a: AgreementState,
  v: Pick<VersionState, "number">,
): Promise<boolean> {
  const { count } = await ctx.db.updateMany("agreements", {
    where: {
      number: a.number,
      kind: a.kind,
      status: "draft",
      ...(a.parent_agreement_id ? { parent_agreement_id: a.parent_agreement_id } : {}),
    },
    data: { status: "sent" },
  })
  if (count === 0) return false
  await ctx.emit?.({
    entity: "agreement",
    action: "sent",
    entityId: a.id,
    data: { number: a.number, version: v.number },
  })
  return true
}

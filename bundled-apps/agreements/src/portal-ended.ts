// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel/portal_user:access_ended`: a company's portal access ended, and the kernel
// withdrew its people's open links in the same step. An agreement still waiting on
// one of them keeps its status (a person may send a new link); its activity says
// which signer's link was withdrawn and why, once per link.

import { type AgreementsCtx, bridgeAnswer } from "./ctx"

const TARGET_TYPE = "agreement_version"
const WAITING = ["sent", "partly_signed"]

interface AccessEndedEvent {
  data?: { companyId?: string }
}

interface Link {
  id: string
  invited_name: string
  state: string
  replaced?: boolean
  revoke_reason?: string | null
}

export async function onPortalAccessEnded(ctx: AgreementsCtx, event: AccessEndedEvent) {
  const companyId = event?.data?.companyId
  if (!companyId || !ctx.client_actions_record) return { status: "ignored" }
  const agreements = (await ctx.db.findMany("agreements", {
    where: { company_id: companyId, status: { in: WAITING } },
  })) as Array<{ id: string; number: string }>
  let withdrawn = 0
  for (const a of agreements) {
    const versions = (await ctx.db.findMany("agreement_versions", {
      where: { agreement_id: a.id, status: "frozen" },
    })) as Array<{ id: string; number: number }>
    for (const v of versions) {
      const answer = bridgeAnswer<{ links?: Link[] }>(
        await ctx.client_actions_record({ target_type: TARGET_TYPE, target_id: v.id }),
      )
      const ended = (answer.links ?? []).filter(
        (l) => l.state === "revoked" && l.revoke_reason === "access_ended" && !l.replaced,
      )
      if (ended.length === 0) continue
      withdrawn += ended.length
      await ctx.emit?.({
        entity: "agreement",
        action: "links_withdrawn",
        entityId: a.id,
        data: {
          number: a.number,
          version: v.number,
          signers: ended.map((l) => l.invited_name),
          reason: "access_ended",
        },
      })
    }
  }
  return { status: withdrawn > 0 ? "withdrawn" : "none", links: withdrawn }
}

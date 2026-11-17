// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The clients under a signed agreement, kept in the app's own contact group ("Clients under a
// signed agreement", key `clients-signed`). The Scope check routine template reads new mail
// from that group only, and only mail whose sender the receiving provider authenticated; the
// kernel makes the group when the template is enabled.
//
// The daily reconcile adds each signed agreement's client to the group through the declared
// `kernel:contacts_group_add`, run as the person who sent that agreement for signature (the
// kernel finds them on its signed version), never as a wider system identity. Nothing is
// removed here: a client stays a member until a person removes them.

import { CHANGE_REQUEST } from "./change-requests"
import { type AgreementsCtx, bridgeAnswer } from "./ctx"

export const SCOPE_GROUP_KEY = "clients-signed"
const TARGET_TYPE = "agreement_version"

interface SignedRow {
  id: string
  number: string
  kind: string
  status: string
  contact_id?: string | null
}

export async function scopeGroupReconcile(ctx: AgreementsCtx, today?: string) {
  if (!ctx.client_actions_own_group || !ctx.client_actions_call_as_sender)
    return { status: "skipped", reason: "This host keeps no contact group for the app." }
  const own = bridgeAnswer<{ status: string; group_id?: string | null }>(
    await ctx.client_actions_own_group({ key: SCOPE_GROUP_KEY }),
  )
  const groupId = own.group_id ?? null
  if (!groupId)
    return {
      status: "skipped",
      reason: "The Scope check is not enabled: there is no group of clients to keep.",
    }
  const day = today ?? ctx.today ?? new Date().toISOString().slice(0, 10)
  const signed = (await ctx.db.findMany("agreements", {
    where: { status: "signed" },
    limit: 500,
  })) as SignedRow[]
  let added = 0
  const notAdded: Array<{ agreement: string; code: string }> = []
  for (const a of signed) {
    if (a.kind === CHANGE_REQUEST || !a.contact_id) continue
    const versions = (await ctx.db.findMany("agreement_versions", {
      where: { agreement_id: a.id, status: "signed" },
      limit: 1,
    })) as Array<{ id: string }>
    const version = versions[0]
    if (!version) continue
    const out = bridgeAnswer<{
      status: string
      result?: { added?: unknown[] }
      error?: { code: string }
    }>(
      await ctx.client_actions_call_as_sender({
        target_type: TARGET_TYPE,
        target_id: version.id,
        tool: "kernel:contacts_group_add",
        params: { groupId, contactIds: [a.contact_id] },
        idempotency_key: `agreements:scope-group:${a.id}:${day}`,
      }),
    )
    if (out.status === "completed")
      added += Array.isArray(out.result?.added) ? out.result.added.length : 0
    else notAdded.push({ agreement: a.number, code: out.error?.code ?? out.status })
  }
  return { status: "ok", group_id: groupId, added, not_added: notAdded }
}

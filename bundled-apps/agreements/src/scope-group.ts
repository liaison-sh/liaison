// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The clients under a signed agreement, kept in the app's own contact group ("Clients under a
// signed agreement", key `clients-signed`). The Scope check routine template reads new mail
// from that group only, and only mail whose sender the receiving provider authenticated; the
// kernel makes the group when the template is enabled.
//
// Signing adds the agreement's client to the group, and the daily reconcile catches up any
// signed agreement whose client is not added yet (the routine enabled after the signature, a
// pass that failed), both through the declared `kernel:contacts_group_add`, run as the person
// who sent that agreement for signature (the kernel finds them on its signed version), never
// as a wider system identity. Nothing is removed here: a client stays a member until a person
// removes them.

import { CHANGE_REQUEST } from "./change-requests"
import { type AgreementsCtx, bridgeAnswer } from "./ctx"

export const SCOPE_GROUP_KEY = "clients-signed"
const TARGET_TYPE = "agreement_version"

interface SignedRow {
  id: string
  number: string
  kind: string
  org_access?: string | null
  status: string
  contact_id?: string | null
}

type AddAnswer = { status: string; result?: { added?: unknown[] }; error?: { code: string } }

/** The group's id, or null when the Scope check is not enabled (or the host keeps none). */
async function scopeGroupId(ctx: AgreementsCtx): Promise<string | null> {
  if (!ctx.client_actions_own_group || !ctx.client_actions_call_as_sender) return null
  const own = bridgeAnswer<{ status: string; group_id?: string | null }>(
    await ctx.client_actions_own_group({ key: SCOPE_GROUP_KEY }),
  )
  return own.group_id ?? null
}

/** Adds one signed agreement's client to the group, as its sender, on its signed version. */
async function addClient(
  ctx: AgreementsCtx,
  groupId: string,
  a: SignedRow,
  ref: string,
): Promise<AddAnswer | null> {
  // A restricted agreement's client is not added: the routine's owner may be off its list.
  if (
    a.kind === CHANGE_REQUEST ||
    a.org_access === "none" ||
    !a.contact_id ||
    !ctx.client_actions_call_as_sender
  )
    return null
  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: a.id, status: "signed" },
    limit: 1,
  })) as Array<{ id: string }>
  const version = versions[0]
  if (!version) return null
  return bridgeAnswer<AddAnswer>(
    await ctx.client_actions_call_as_sender({
      target_type: TARGET_TYPE,
      target_id: version.id,
      tool: "kernel:contacts_group_add",
      params: { groupId, contactIds: [a.contact_id] },
      idempotency_key: ref,
    }),
  )
}

/**
 * On signing: the agreement's client joins the Scope check's group, when the routine is
 * enabled. A failure leaves the signature as it is; the daily reconcile adds the client later.
 */
export async function addSignedClientToScopeGroup(
  ctx: AgreementsCtx,
  agreementId: string,
): Promise<{ status: "added" | "skipped" | "not_added"; reason?: string }> {
  const groupId = await scopeGroupId(ctx)
  if (!groupId) return { status: "skipped", reason: "the Scope check is not enabled" }
  const a = (await ctx.db.findOne("agreements", agreementId)) as SignedRow | null
  if (!a) return { status: "skipped", reason: "no such agreement" }
  const out = await addClient(ctx, groupId, a, `agreements:scope-group:${a.id}:signed`)
  if (!out) return { status: "skipped", reason: "no client to add" }
  return out.status === "completed"
    ? { status: "added" }
    : { status: "not_added", reason: out.error?.code ?? out.status }
}

export async function scopeGroupReconcile(ctx: AgreementsCtx, today?: string) {
  if (!ctx.client_actions_own_group || !ctx.client_actions_call_as_sender)
    return { status: "skipped", reason: "This host keeps no contact group for the app." }
  const groupId = await scopeGroupId(ctx)
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
    const out = await addClient(ctx, groupId, a, `agreements:scope-group:${a.id}:${day}`)
    if (!out) continue
    if (out.status === "completed")
      added += Array.isArray(out.result?.added) ? out.result.added.length : 0
    else notAdded.push({ agreement: a.number, code: out.error?.code ?? out.status })
  }
  return { status: "ok", group_id: groupId, added, not_added: notAdded }
}

/** The Scope check's routine template key in this manifest (`routines`). */
export const SCOPE_CHECK_TEMPLATE_KEY = "scope-check"

/**
 * `kernel/routine:create`: when the Scope check template is enabled, its group is filled at
 * once (the kernel made it empty), so mail from a client who already signed is read from the
 * start rather than after the next daily reconcile. Any other routine is ignored.
 */
export async function onScopeCheckEnabled(
  ctx: AgreementsCtx,
  event: { data?: { appName?: unknown; templateKey?: unknown } } | null | undefined,
) {
  const d = event?.data
  if (d?.appName !== "agreements" || d?.templateKey !== SCOPE_CHECK_TEMPLATE_KEY)
    return { status: "ignored" }
  return scopeGroupReconcile(ctx)
}

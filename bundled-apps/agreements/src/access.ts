// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one writer of who can see an agreement: `org_access` and its list (`agreement_shares`).
// The database enforces the reading side (`sharedRows` on every table of the app); this file
// keeps the list's rules: never empty, the creator on it as editor at creation, a viewer cannot
// change it, an agent's change waits for a person (the caller parks it), and a removal sets
// `removed_at` (rows of this app are never deleted).
//
// Derived copies kept on the agreement (`acl_user_ids`) are written by `afterAccessChange` in the
// same batch. Copies held by the kernel follow the list by mechanism instead: attention and
// routine ticks read the list itself (`kernel.restricted_readers`), messages a turn writes after
// reading the agreement carry its restricted scope, and approvals it parks are owner-routed.

import type { DbBatchOp } from "@liaison/app-sdk"
import { type AgreementsCtx, type ErrorEnvelope, refusal } from "./ctx"

export type OrgAccess = "none" | "viewer" | "editor"
export interface ShareEntry {
  user_id: string
  role: "viewer" | "editor"
}

export interface ShareRow {
  id: string
  agreement_id: string
  user_id: string
  role: "viewer" | "editor"
  removed_at?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The list as it stands (rows not removed). */
export async function currentShares(ctx: AgreementsCtx, agreementId: string): Promise<ShareRow[]> {
  const rows = (await ctx.db.findMany("agreement_shares", {
    where: { agreement_id: agreementId },
    limit: 500,
  })) as ShareRow[]
  return rows.filter((r) => !r.removed_at)
}

/** Normalise a requested list: one entry per person, the editor role winning, valid ids only. */
export function normaliseShares(shares: ShareEntry[]): ShareEntry[] | null {
  const by = new Map<string, ShareEntry>()
  for (const s of shares) {
    if (!s || typeof s.user_id !== "string" || !UUID.test(s.user_id)) return null
    if (s.role !== "viewer" && s.role !== "editor") return null
    const had = by.get(s.user_id)
    if (!had || s.role === "editor") by.set(s.user_id, { user_id: s.user_id, role: s.role })
  }
  return [...by.values()]
}

/**
 * The derived copies of the list kept on the agreement itself, written with `org_access`: `acl_user_ids`
 * holds the list while the agreement is closed to the organization, and nothing while it is open
 * (the field a search document would carry, so a restricted row is never indexed open).
 */
export function afterAccessChange(change: {
  orgAccess: OrgAccess
  list: ShareEntry[]
}): Record<string, unknown> {
  const readers = change.orgAccess === "none" ? change.list.map((s) => s.user_id).sort() : []
  return { acl_user_ids: readers }
}

/**
 * Tell the kernel who can see the agreement now, once the change is committed: its client
 * actions (the agreement's versions are their targets) and its discussion follow the list
 * (`modules/client-actions/restricted-follow.ts`). The event carries ids and the list only.
 */
export async function emitAccessChanged(
  ctx: AgreementsCtx,
  agreementId: string,
  orgAccess: OrgAccess,
  list: ShareEntry[],
): Promise<void> {
  if (!ctx.emit || !agreementId) return
  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: agreementId },
    limit: 500,
  })) as Array<{ id: string }>
  await ctx.emit({
    entity: "agreement",
    action: "access_changed",
    entityId: agreementId,
    data: {
      org_access: orgAccess,
      visible_to: orgAccess === "none" ? list.map((s) => s.user_id).sort() : null,
      version_ids: versions.map((v) => v.id),
    },
  })
}

/**
 * The batch ops that bring an agreement's access to `orgAccess` with exactly `list`. Removed
 * people get `removed_at`; a person re-added gets their row back. The list is never empty.
 */
export function accessOps(
  agreementId: string,
  orgAccess: OrgAccess,
  list: ShareEntry[],
  existing: ShareRow[] | "new",
  actorUserId: string | null,
  now: string,
  allRows: ShareRow[] = [],
): DbBatchOp[] | ErrorEnvelope {
  if (list.length === 0) {
    return refusal(
      "ACCESS_LIST_EMPTY",
      "The list of people who can see this agreement cannot be empty; name at least one person. Nothing was changed.",
    )
  }
  const ops: DbBatchOp[] = []
  const ref = existing === "new" ? { $ref: "agreement" } : agreementId
  const current = existing === "new" ? [] : existing
  const keep = new Map(list.map((s) => [s.user_id, s]))
  for (const row of current) {
    const want = keep.get(row.user_id)
    if (!want) ops.push({ update: "agreement_shares", id: row.id, data: { removed_at: now } })
    else if (want.role !== row.role)
      ops.push({ update: "agreement_shares", id: row.id, data: { role: want.role } })
  }
  for (const s of list) {
    if (current.some((r) => r.user_id === s.user_id)) continue
    const old = allRows.find((r) => r.user_id === s.user_id)
    if (old) {
      ops.push({ update: "agreement_shares", id: old.id, data: { removed_at: null, role: s.role } })
    } else {
      ops.push({
        insert: "agreement_shares",
        data: { agreement_id: ref, user_id: s.user_id, role: s.role, created_by: actorUserId },
      })
    }
  }
  // Written last: closing the agreement while its list is in place keeps the writer reading it.
  // The derived copies ride on the same write, so they can never disagree with it.
  ops.push({
    update: "agreements",
    id: ref,
    data: { org_access: orgAccess, ...afterAccessChange({ orgAccess, list }) },
  })
  return ops
}

/**
 * May this person change who can see the agreement? A person on the list as editor may, a
 * viewer on it may not; someone not on the list may only while the organization has editor
 * access (the agreement is open to every member with the write scope).
 */
export function mayChangeAccess(
  userId: string | null,
  orgAccess: OrgAccess,
  shares: ShareRow[],
): boolean {
  if (!userId) return true
  const mine = shares.find((s) => s.user_id === userId)
  if (mine) return mine.role === "editor"
  return orgAccess === "editor"
}

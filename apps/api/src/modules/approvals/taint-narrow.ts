// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RESTAGING A PENDING APPROVAL FROM A TAINTED TURN, IN PLACE (scope-taint.ts, rule 8g).
//
// Editing the payload of a PENDING approval is not itself a disclosure: the edited payload stays
// pending and is decided by that same approval. So a tainted turn may rewrite a pending draft
// without a second approval, provided the row ends up exactly as narrow as a fresh tainted
// proposal would be:
//
//   - the union of what the row already demanded (`metadata.taintAudienceMustHold`) and what this
//     turn read becomes the row's demand, which RLS enforces on the shared-surface branches (0167);
//   - the notified audience is re-narrowed to holders of that union (never widened);
//   - the requester, who always sees their own row, must hold it, and somebody who may decide the
//     row must hold it too, else the edit is refused with the no-decider message.
//
// The caller runs this inside its row lock, then writes the returned `mustHold` and
// `notifyUserIds` with the payload, and stamps its edit-diff message with `mustHold`.

import { decidingScopeForToolDef } from "@liaison/shared"
import type { PrivilegedDb } from "~/db"
import {
  SCOPE_TAINT_BLOCKED_MESSAGE,
  SCOPE_TAINT_NO_DECIDER_MESSAGE,
  UNKNOWN_TURN_TAINT,
} from "~/modules/agent/scopes/scope-taint"
import { isSharedSurfaceApproval } from "~/modules/approvals/event-data"
import {
  eligibleApprovers,
  eligibleApproversWithDimension,
} from "~/modules/permissions/eligible-approvers"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

export type TaintNarrowRow = {
  tool_name: string
  requested_by: string
  notify_user_ids: string[] | null
  resource_owner_id: string | null
  approve_scope: string | null
  dimension_constraint: { key: string; values: string[] } | null
  metadata: { taintAudienceMustHold?: unknown } | null
}

export type TaintNarrowing =
  | { ok: true; mustHold: string[]; notifyUserIds: string[] }
  | { ok: false; message: string }

/** The scopes a pending row already demands of its audience (rule 8c), empty when none. */
export function rowTaintMustHold(metadata: { taintAudienceMustHold?: unknown } | null): string[] {
  const raw = metadata?.taintAudienceMustHold
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : []
}

async function holdersOfAll(
  tx: PrivilegedDb,
  orgId: string,
  scopes: readonly string[],
): Promise<Set<string>> {
  let holders: string[] | null = null
  for (const scope of scopes) {
    const these = new Set(await eligibleApprovers(tx, orgId, scope))
    holders = (holders ?? [...these]).filter((u) => these.has(u))
  }
  return new Set(holders ?? [])
}

/**
 * The narrowed audience of `row` once it also carries `turnTaint`, or the refusal. A turn
 * that read nothing new leaves the row's own demand in place (the audience is re-checked all
 * the same: it is cheap and keeps one rule).
 */
export async function narrowPendingApprovalForTaint(
  tx: PrivilegedDb,
  orgId: string,
  row: TaintNarrowRow,
  turnTaint: readonly string[],
): Promise<TaintNarrowing> {
  const mustHold = [...new Set([...rowTaintMustHold(row.metadata), ...turnTaint])].sort()
  const notify = row.notify_user_ids ?? []
  if (mustHold.length === 0) return { ok: true, mustHold, notifyUserIds: notify }
  const appName = row.tool_name.split(":")[0] ?? ""
  const approveScope = decidingScopeForToolDef({ approveScope: row.approve_scope }, appName)
  // An unknown taint is held by nobody: no decider can exist.
  if (mustHold.some((s) => UNKNOWN_TURN_TAINT.includes(s))) {
    return { ok: false, message: SCOPE_TAINT_NO_DECIDER_MESSAGE(mustHold, approveScope) }
  }
  // The requester always reads their own row, so they must hold the union.
  const requester = await loadEffectivePermissions(tx, row.requested_by, orgId)
  const requesterMissing = mustHold.filter((s) => !hasScope(s, requester.scopes))
  if (requesterMissing.length > 0) {
    return {
      ok: false,
      message: SCOPE_TAINT_BLOCKED_MESSAGE(
        "kernel.approval_requests",
        mustHold,
        "requester",
        undefined,
        {
          missingScopes: requesterMissing,
          lacking: 1,
        },
      ),
    }
  }
  if (row.resource_owner_id) {
    // Owner-routed: the owner is the only decider and the only one notified.
    const owner = await loadEffectivePermissions(tx, row.resource_owner_id, orgId)
    if (!mustHold.every((s) => hasScope(s, owner.scopes))) {
      return { ok: false, message: SCOPE_TAINT_NO_DECIDER_MESSAGE(mustHold, approveScope) }
    }
    return { ok: true, mustHold, notifyUserIds: notify }
  }
  const holders = await holdersOfAll(tx, orgId, mustHold)
  // Re-narrowed, never widened: the requester stays first (they hold the union).
  const notifyUserIds = notify.filter((u) => u === row.requested_by || holders.has(u))
  if (!notifyUserIds.includes(row.requested_by)) notifyUserIds.unshift(row.requested_by)
  const approvers = row.dimension_constraint
    ? await eligibleApproversWithDimension(
        tx,
        orgId,
        approveScope,
        row.dimension_constraint,
        appName,
      )
    : await eligibleApprovers(tx, orgId, approveScope, appName)
  // Who may decide it: a notified approver, or on a shared surface any approve holder (decide.ts
  // widens it so), in both cases holding the union.
  const audience = isSharedSurfaceApproval(row) ? null : new Set(notifyUserIds)
  const deciders = approvers.filter((u) => holders.has(u) && (audience === null || audience.has(u)))
  if (deciders.length === 0) {
    return { ok: false, message: SCOPE_TAINT_NO_DECIDER_MESSAGE(mustHold, approveScope) }
  }
  return { ok: true, mustHold, notifyUserIds }
}

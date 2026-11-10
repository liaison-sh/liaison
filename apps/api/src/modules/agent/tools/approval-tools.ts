// SPDX-License-Identifier: FSL-1.1-ALv2
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { captureActingAgentId } from "~/modules/agent/runtime/run-context"
import { updatePayload } from "~/modules/approvals/edit"
import { withdrawApproval } from "~/modules/approvals/withdraw"
import type { AppContext } from "~/modules/apps/context"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

export async function handleApprovalUpdatePayload(
  params: { requestId: string; fields: Record<string, unknown> },
  ctx: AppContext,
): Promise<unknown> {
  const perms = await withPrivilegedDb(ctx.orgId, "agent-approval-edit-perms", (pdb) =>
    loadEffectivePermissions(pdb, ctx.userId, ctx.orgId),
  )
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
  return updatePayload({
    orgId: ctx.orgId,
    requestId: params.requestId,
    fields: params.fields,
    actor,
    // A11: an AGENT is editing, in its own turn, so the acting agent is simply
    // this frame's. That is the SAME value the emitter would fall back to for
    // these events anyway (`stampActingAgentId` precedence 2, db/queue-event.ts),
    // so this call changes no outcome on its own. The load-bearing half of the
    // pair is the HTTP route, which passes a positive null: an explicit value
    // wins over the frame, and a human edits there. It is passed here too so
    // `updatePayload` takes its agent from ONE place, its own argument, rather
    // than from the argument on one path and the emitter's default on the other.
    actingAgentId: captureActingAgentId(),
    // The turn's own scopes (agent ceiling within the person's grants): editing a request this
    // person did not raise needs kernel:approvals:write in them (edit.ts). Absent fails closed.
    callerScopes: ctx.scopes ?? [],
    // Rule 8g (scope-taint.ts): the dispatch does not judge this edit as a disclosure; the
    // pending row is restaged in place, narrowed to holders of this turn's taint.
    ...(ctx.turnTaintScopes !== undefined ? { turnTaintScopes: ctx.turnTaintScopes } : {}),
  })
}

export async function handleApprovalWithdraw(
  params: { requestId: string; reason?: string },
  ctx: AppContext,
): Promise<unknown> {
  const perms = await withPrivilegedDb(ctx.orgId, "agent-approval-withdraw-perms", (pdb) =>
    loadEffectivePermissions(pdb, ctx.userId, ctx.orgId),
  )
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
  return withdrawApproval({
    orgId: ctx.orgId,
    requestId: params.requestId,
    reason: params.reason,
    actor,
    // The reason is stamped with what this turn read (withdraw.ts), so the withdraw never parks.
    ...(ctx.turnTaintScopes !== undefined ? { turnTaintScopes: ctx.turnTaintScopes } : {}),
  })
}

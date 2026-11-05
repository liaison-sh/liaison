// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's side of linking an import placeholder to a real person
// (merge-placeholder.ts has the rules). Two kernel tools, registered by
// kernel-tools.ts beside the other identity tools:
//
// - `merge_imported_user_preview`: read-only, ungated. The dry run: what a
//   merge would move, so the agent can say it before proposing one.
// - `merge_imported_user`: GATED like every identity change (invite_user,
//   assign_role...). The agent only stages it; a human with the admin scope
//   approves, seeing the counts in the approval summary. Stage-time preflight
//   refuses what no approval could ever make valid (a real account as source,
//   a placeholder as target, an id outside the org), so nobody is asked to
//   approve a merge that would be refused.
//
// Both require `kernel:users:admin` (the registry's gate on the caller), and
// both handlers re-check the executing user's persisted scopes before touching
// anything, so a stale grant in a queued approval cannot slip through.
import type { ApprovalSummary } from "@liaison/shared"
import type { RlsClient } from "~/db"
import { type OrgConfigToolCtx, resolveActor } from "~/modules/agent/tools/org-config-tools"
import { hasScope } from "~/modules/permissions/permissions"
import { type MergeCounts, MergeUserError, mergePlaceholderIntoUser } from "./merge-placeholder"

export const MERGE_SCOPE = "kernel:users:admin"

export interface MergeToolParams {
  placeholderUserId: string
  targetUserId: string
}

async function refuseWithoutAdmin(ctx: OrgConfigToolCtx) {
  const actor = await resolveActor(ctx)
  if (hasScope(MERGE_SCOPE, actor.scopes as string[])) return null
  return { error: { code: "FORBIDDEN", message: `Merging users needs ${MERGE_SCOPE}.` } }
}

/** A compact digest of what moves (the agentic-digest rule: small, parsable). */
function digest(counts: MergeCounts) {
  return {
    messages: counts.messagesAuthored,
    mentions: counts.messagesMentioning,
    reactions: counts.reactionsMoved,
    files: counts.filesMoved,
    threadsJoined: counts.participationsMoved,
    threadsCreated: counts.threadsCreated,
  }
}

async function run(params: MergeToolParams, ctx: OrgConfigToolCtx, dryRun: boolean) {
  const refused = await refuseWithoutAdmin(ctx)
  if (refused) return refused
  try {
    const r = await mergePlaceholderIntoUser({
      orgId: ctx.orgId,
      actorId: ctx.userId,
      placeholderId: params.placeholderUserId,
      targetId: params.targetUserId,
      dryRun,
    })
    return {
      dryRun: r.dryRun,
      alreadyMerged: r.alreadyMerged,
      placeholder: { id: r.placeholder.id, name: r.placeholder.name },
      target: { id: r.target.id, name: r.target.name, email: r.target.email },
      moves: digest(r.counts),
    }
  } catch (err) {
    if (err instanceof MergeUserError) return { error: { code: err.code, message: err.message } }
    throw err
  }
}

export function handleMergeImportedUserPreview(params: MergeToolParams, ctx: OrgConfigToolCtx) {
  return run(params, ctx, true)
}

export function handleMergeImportedUser(params: MergeToolParams, ctx: OrgConfigToolCtx) {
  return run(params, ctx, false)
}

/** Stage-time refusal: the same checks the merge makes, as a dry run. */
export async function mergeImportedUserPreflight(
  params: MergeToolParams,
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  const r = await run(params, ctx, true)
  if ("error" in r) return { error: r.error }
  if (r.alreadyMerged) {
    return { error: { code: "ALREADY_MERGED", message: "This imported user was already merged." } }
  }
  return { ok: true }
}

export async function summarizeMergeImportedUser(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as Partial<MergeToolParams>
  let title = "Link an imported user to a person"
  const lines: string[] = []
  if (p.placeholderUserId && p.targetUserId) {
    try {
      const plan = await mergePlaceholderIntoUser({
        orgId: ctx.orgId,
        actorId: ctx.userId,
        placeholderId: p.placeholderUserId,
        targetId: p.targetUserId,
        dryRun: true,
      })
      const c = plan.counts
      title = `Merge imported "${plan.placeholder.name}" into ${plan.target.name} <${plan.target.email}>`
      lines.push(
        `Moves ${c.messagesAuthored} messages, ${c.messagesMentioning} mentions, ${c.reactionsMoved} reactions and ${c.filesMoved} files to ${plan.target.name}.`,
        `${plan.target.name} joins ${c.participationsMoved} conversations the imported user was in, and can read their history.`,
        ...(c.contactsMerged > 0
          ? [
              `${c.contactsMerged} private contacts of the imported user are merged into ${plan.target.name}'s own contacts for the same addresses.`,
            ]
          : []),
        "The imported user is removed afterwards. This cannot be undone.",
      )
    } catch (err) {
      lines.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { kind: "merge_imported_user", title, lines }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A pending approval staged the way production stages one: the requester asks
// in a conversation, their agent makes a gated tool call through `executeTool`
// (origin "in-app-agent", so the kernel's own gate parks it, picks the
// approvers it notifies, writes the summary and the "opened" line, and
// publishes the create event), and the agent's turn keeps the blocked call in
// its message, which is what renders the inline card. Test builds only: a
// browser test needs the card without a model turn (`/api/_test/agent-script`
// covers the turn itself).
//
// Approvers hold the deciding scope through a role, granted before the call so
// the gate's own approver fan-out finds them. An expired approval is the
// kernel's expiry job run on it (`expireApproval`), never a status written by
// hand.
import { eq } from "drizzle-orm"
import type { UserContext } from "~/db/rls"
import { approvalRequests } from "~/db/schema/kernel/agent-memory"
import { runApprovalExpiry } from "~/modules/approvals/expiry"
import { executeTool } from "~/modules/apps/execute-tool"
import { sendMessage } from "~/modules/threads/message"
import { createThread } from "~/modules/threads/thread"
import type { SeedContext } from "~/seed/context"
import { seedPersonalAgent } from "~/seed/factories/agent/agents"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { grantScopesThroughRole } from "~/seed/factories/people/scoped-role"

export interface GatedApprovalInput {
  key: string
  adminUserId: string
  requesterUserId: string
  toolName: string
  params: Record<string, unknown>
  /** The conversation the call is made in; a new one titled `title` when absent. */
  threadId?: string | null
  title: string
  /** Other people in the new conversation (the approvers are added on their own). */
  participantUserIds: string[]
  /** People given the deciding scope (`approveScope`) before the call. */
  approverUserIds: string[]
  /** Default: `<app>:approve` of the tool. */
  approveScope?: string
  /** The agent's message keeps the blocked call (the inline card). Default true. */
  toolCallMessage: boolean
  /** The requester then names the approval in a message (a mention pill). */
  mention: boolean
}

export interface GatedApprovalResult {
  approvalRequestId: string
  handle: string
  threadId: string
}

export async function stageGatedApproval(
  ctx: SeedContext,
  input: GatedApprovalInput,
): Promise<GatedApprovalResult> {
  const { orgId } = ctx
  const approvers = [...new Set(input.approverUserIds)]
  if (approvers.length > 0) {
    const scope = input.approveScope ?? `${input.toolName.split(":")[0]}:approve`
    for (const userId of approvers) {
      const held = (await actorFor(ctx, userId)).scopes
      if (held.includes(scope) || held.includes("*")) continue
      await grantScopesThroughRole(orgId, {
        adminUserId: input.adminUserId,
        userId,
        name: `approver-${input.key.slice(0, 8)}-${userId.slice(0, 8)}`,
        scopes: [scope],
        dimensions: {},
      })
    }
  }

  const requester = await actorFor(ctx, input.requesterUserId)
  let threadId = input.threadId ?? null
  if (!threadId) {
    const people = [...new Set([input.requesterUserId, ...input.participantUserIds, ...approvers])]
    const created = await asUser(requester, (tx) =>
      createThread(
        tx as never,
        {
          orgId,
          userId: input.requesterUserId,
          participantIds: people,
          title: input.title,
          forceCreate: true,
        } as never,
      ),
    )
    threadId = (created as { id: string }).id
  }
  const inThread = threadId

  // The ask the agent's turn answers.
  await asUser(requester, (tx) =>
    sendMessage(
      tx as never,
      {
        orgId,
        userId: input.requesterUserId,
        threadId: inThread,
        content: "Please take care of this.",
        authorType: "user",
        requiredScopes: [],
      } as never,
    ),
  )

  const result = await executeTool({
    toolName: input.toolName,
    orgId,
    actor: requester,
    threadId: inThread,
    params: input.params,
    origin: "in-app-agent",
  })
  if (!("blocked" in result) || !result.blocked) {
    throw new Error(
      `${input.toolName} was not parked for approval: ${JSON.stringify(
        "error" in result ? result.error : result,
      )}`,
    )
  }
  const approvalRequestId = result.blocked.approvalRequestId
  if (!approvalRequestId) {
    throw new Error(`${input.toolName}: the blocked envelope names no approval`)
  }
  const handle = await approvalHandle(requester, approvalRequestId)

  if (input.toolCallMessage) {
    const agent = await seedPersonalAgent(orgId, input.requesterUserId, "@assistant")
    await asUser(requester, (tx) =>
      sendMessage(
        tx as never,
        {
          orgId,
          userId: input.requesterUserId,
          threadId: inThread,
          content: "This needs an approval first.",
          authorType: "agent",
          agentId: agent.agentId,
          agentAuthorLabel: agent.displayName,
          requiredScopes: [],
          metadata: {
            toolCalls: [
              {
                toolCallId: `tc-${input.key.slice(0, 8)}`,
                toolName: input.toolName,
                args: input.params,
                result: { blocked: result.blocked },
                status: "completed",
              },
            ],
          },
        } as never,
      ),
    )
  }

  if (input.mention) {
    await asUser(requester, (tx) =>
      sendMessage(
        tx as never,
        {
          orgId,
          userId: input.requesterUserId,
          threadId: inThread,
          content: `Please review @[${handle}](kernel:approval_request:${approvalRequestId}).`,
          authorType: "user",
          requiredScopes: [],
        } as never,
      ),
    )
  }

  return { approvalRequestId, handle, threadId: inThread }
}

/** The handle the gate gave the approval, read as the requester (they are always notified). */
async function approvalHandle(requester: UserContext, approvalRequestId: string): Promise<string> {
  const [row] = await asUser(requester, (tx) =>
    tx
      .select({ handle: approvalRequests.handle })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRequestId))
      .limit(1),
  )
  if (!row) throw new Error(`approval ${approvalRequestId} is not readable by its requester`)
  return row.handle
}

/** The kernel's expiry job, run on one pending approval now. */
export async function expireApproval(
  ctx: SeedContext,
  approvalRequestId: string,
): Promise<{ expired: true }> {
  await runApprovalExpiry({ orgId: ctx.orgId, requestId: approvalRequestId })
  return { expired: true }
}

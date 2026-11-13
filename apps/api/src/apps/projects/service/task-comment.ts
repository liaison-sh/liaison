// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { sendMessage } from "~/modules/threads/message"
import { getTask } from "./tasks"

export interface PostTaskCommentParams {
  orgId: string
  userId: string
  taskId: string
  body: string
  /** Scopes a reader must hold to see the comment; the caller states them. */
  requiredScopes: string[]
  /** "agent" when an agent acts, so the thread shows the post came from one. */
  authorType?: "user" | "agent"
  /**
   * The agent acting in the turn that posts (agent authorship only). A sandbox
   * bridge callback has lost the turn's frame, so it hands over the agent it
   * captured while the frame was live. Undefined reads the live frame, then
   * falls back to the person's own agent (sendMessage).
   */
  agentId?: string | null
  /**
   * Who signs an agent comment when the caller knows better than the acting agent: a routine's
   * run signs as the routine ("Routine <title>"), like the messages it posts. Agent authorship only.
   */
  agentAuthorLabel?: string | null
}

export interface PostedTaskComment {
  taskId: string
  taskKey: string | null
  threadId: string
  messageId: string | null
}

/**
 * Post a comment to a task's discussion thread, in the caller's transaction.
 *
 * Resolves the task through `getTask` with `viewerId`, which lazily enrols the
 * author as a participant of the thread (the same enrolment the web detail
 * pane relies on), so the participant-gated message write goes through. A
 * binned task throws 404: nobody comments on something deleted.
 */
export async function postTaskComment(
  tx: RlsClient,
  params: PostTaskCommentParams,
): Promise<PostedTaskComment> {
  const { orgId, userId, taskId, body, requiredScopes } = params
  const authorType = params.authorType ?? "user"
  const task = await getTask({ tx, orgId, taskId, viewerId: userId })
  if (!task.threadId) throw new Error("task_has_no_thread")
  let agentAuthorLabel: string | undefined =
    authorType === "agent" ? params.agentAuthorLabel?.trim() || undefined : undefined
  if (authorType === "agent" && !agentAuthorLabel && params.agentId) {
    // A named (role) agent speaks under its own name: "{User}'s agent" on a
    // Finance Desk post misnames the speaker. A personal agent is the person's.
    const [agent] = extractRows<{ kind: string; display_name: string | null }>(
      await tx.execute(drizzleSql`
        SELECT kind, display_name FROM ${kernelRel("agents")}
        WHERE id = ${params.agentId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
      `),
    )
    if (agent && agent.kind !== "personal" && agent.display_name) {
      agentAuthorLabel = agent.display_name
    }
  }
  if (authorType === "agent" && !agentAuthorLabel) {
    // Attributed, never impersonated: "{User}'s agent", the label every other
    // agent post without a named acting agent carries.
    const [user] = extractRows<{ name: string | null }>(
      await tx.execute(drizzleSql`
        SELECT name FROM ${kernelRel("users")}
        WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
      `),
    )
    agentAuthorLabel = `${user?.name ?? "User"}'s agent`
  }
  const message = await sendMessage(tx, {
    orgId,
    userId,
    threadId: task.threadId,
    content: body,
    requiredScopes,
    ...(authorType === "agent"
      ? {
          authorType,
          agentAuthorLabel,
          ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        }
      : {}),
  })
  return {
    taskId,
    taskKey: task.key ?? null,
    threadId: task.threadId,
    messageId: (message as { id?: string } | null)?.id ?? null,
  }
}

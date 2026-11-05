// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Requests that go to a node instead of a cloud turn (S21, S25, A17, A24).
 *
 * `routeDispatchToNode` is asked by THE one dispatch path
 * (`dispatchAgentMention`), after its loop guards and before any seat or
 * turn, so `agents_ask` and an @mention (posted-message-dispatch) take the
 * same decision:
 *   - an agent attached to someone's node, asked by a requester the
 *     attachment allows: an `agent_tag` job on that node (the result goes to
 *     the node owner's own conversation with the agent, and the answer is
 *     posted back here when this conversation may see it, D22),
 *     or a refusal in words when a daily cap is reached;
 *   - a HUMAN's message in a conversation whose runtime for this agent is a
 *     node (thread-settings.ts), when that human is the node owner: an
 *     INTERACTIVE job carrying the session's permission mode and the SDK
 *     session to resume (S24, A24). Anyone else's message runs in the cloud;
 *     `node_else_cloud` with no live node runs in the cloud too, recorded as
 *     a `fell_back` job;
 *   - anything else: null, and the turn runs in the cloud as today.
 */
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages, users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import {
  folderNamedIn,
  loadNodeCandidates,
  pickNode,
  resolveFolderOnNode,
} from "~/modules/node-sessions/resolve"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createOrGetAgentDm } from "~/modules/threads/thread"
import { attachmentCapRefusal, findNodeRoute } from "./attachments"
import {
  createNodeJob,
  liveNodeTargets,
  loadNodeProfile,
  NodeJobRefusedError,
  recordFellBackJob,
} from "./jobs"
import { loadThreadNodeSetting } from "./thread-settings"

const log = rootLogger.child({ module: "node-routing" })

export type NodeDispatch =
  | {
      kind: "queued"
      jobId: string
      on: string
      backlog: boolean
      /** The owner's own node chat turn: no line in the room for it. */
      interactive?: boolean
    }
  | {
      kind: "refused"
      reason: "node_daily_cap" | "node_source_scope" | "node_routing_failed"
      message: string
    }

export interface NodeDispatchInput {
  orgId: string
  /** The conversation the request was made in. */
  threadId: string
  calleeAgentId: string
  callerAgentId: string | null
  /** The person the request originates from. */
  actorUserId: string
  /** The message that asked (the question row, or the human's message). */
  triggerMessageId: string
  questionText: string
  /** Who asked, as the callee is told (an agent's name, or the person's). */
  askedBy: string
  /** What the asking agent's turn had already read (A18). */
  callerTaintScopes?: string[]
}

/** "Olive's computer": where a queued job runs, as the asker is told. */
export async function computerLabel(orgId: string, userId: string): Promise<string> {
  const [row] = await withSystemDb("nodes:owner-name", (db) =>
    db
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  const name = row?.name?.trim()
  return name ? `${name}'s computer` : "a colleague's computer"
}

/** The scopes the triggering message carries (A18: the job must not widen them). */
async function triggerScopes(orgId: string, messageId: string): Promise<string[]> {
  const [row] = await withPrivilegedDb(orgId, "nodes:trigger-scopes", (tx) =>
    tx
      .select({ requiredScopes: messages.requiredScopes })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)))
      .limit(1),
  )
  return row?.requiredScopes ?? []
}

/** The node owner's own 1:1 with the agent: where an agent_tag result lands (A17). */
async function ownerAgentThread(
  orgId: string,
  ownerUserId: string,
  agentId: string,
): Promise<string | null> {
  const perms = await withPrivilegedDb(orgId, "nodes:owner-dm-perms", (tx) =>
    loadEffectivePermissions(tx, ownerUserId, orgId),
  )
  const dm = await withRlsContext(
    {
      actorType: "user",
      userId: ownerUserId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    (tx) => createOrGetAgentDm(tx, { orgId, userId: ownerUserId, agentId }),
  )
  return dm?.id ?? null
}

/** The agent_tag route (A17), or null when this request runs as today. */
async function routeAgentTag(input: NodeDispatchInput): Promise<NodeDispatch | null> {
  const route = await findNodeRoute({
    orgId: input.orgId,
    agentId: input.calleeAgentId,
    requesterUserId: input.actorUserId,
    requesterAgentId: input.callerAgentId,
  })
  if (!route) return null
  // L31: once a route matched, the request belongs to that computer. An error
  // from here on is refused in words, never run silently in the cloud.
  try {
    return await queueAgentTag(input, route)
  } catch (err) {
    log.error({ err, agentId: input.calleeAgentId }, "node routing failed after a route matched")
    return {
      kind: "refused",
      reason: "node_routing_failed",
      message: "The request could not be handed to the computer this agent runs on.",
    }
  }
}

/**
 * Walk D24: the shared folder the node owner's own message names, on the
 * attachment's node (or the owner's node that shares it), resolved as
 * run_on_my_computer resolves its `folder`. Only the owner's own runs: an
 * isolated request from someone else never gets a shared folder from text.
 */
async function namedFolderPlacement(
  orgId: string,
  route: NonNullable<Awaited<ReturnType<typeof findNodeRoute>>>,
  text: string,
): Promise<{ nodeId: string; folderName: string; folderPath: string | null } | null> {
  const candidates = (await loadNodeCandidates(orgId, route.nodeOwnerUserId)).filter(
    (c) => !route.nodeId || c.nodeId === route.nodeId,
  )
  const folders = candidates.flatMap((c) => c.folders)
  const named = folderNamedIn(text, folders)
  if (!named) return null
  const pick = pickNode(candidates, named.name)
  if (!pick.ok) return null
  const folderPath = await resolveFolderOnNode(orgId, pick.node.nodeId, {
    folderName: named.name,
  })
  return { nodeId: pick.node.nodeId, folderName: named.name, folderPath }
}

async function queueAgentTag(
  input: NodeDispatchInput,
  route: NonNullable<Awaited<ReturnType<typeof findNodeRoute>>>,
): Promise<NodeDispatch | null> {
  // P1-walk D8: the node owner's own message (a person, not an agent asking)
  // is an owner run (S13, D27): their ~/.claude, and no daily cap, which bounds
  // only what other people start on this computer (L30). Everyone else's
  // request stays isolated.
  const ownerRun = input.callerAgentId === null && input.actorUserId === route.nodeOwnerUserId
  const capped = ownerRun ? null : await attachmentCapRefusal(route)
  if (capped) return { kind: "refused", reason: "node_daily_cap", message: capped }
  const threadId = await ownerAgentThread(input.orgId, route.nodeOwnerUserId, route.agentId)
  if (!threadId) return null
  const sourceRequiredScopes = [
    ...new Set([
      ...(await triggerScopes(input.orgId, input.triggerMessageId)),
      ...(input.callerTaintScopes ?? []),
    ]),
  ]
  const placement = ownerRun
    ? await namedFolderPlacement(input.orgId, route, input.questionText)
    : null
  try {
    const job = await createNodeJob({
      orgId: input.orgId,
      ownerUserId: route.nodeOwnerUserId,
      agentId: route.agentId,
      threadId,
      targetNodeId: placement?.nodeId ?? route.nodeId,
      source: "agent_tag",
      sourceRef: input.triggerMessageId,
      runsOn: "node",
      prompt: input.questionText,
      // A22: what was asked, and by whom, goes to the node as DATA for its
      // untrusted-data block.
      trigger: {
        askedBy: input.askedBy,
        question: input.questionText,
        threadId: input.threadId,
        messageId: input.triggerMessageId,
      },
      sourceRequiredScopes,
      requesterUserId: input.actorUserId,
      requesterAgentId: input.callerAgentId,
      replyThreadId: input.threadId,
      replyMessageId: input.triggerMessageId,
      // S17, D27: a session at the agent's profile level, isolated unless the
      // owner asked (D8); the
      // model is resolved at claim against the claiming node's models.
      session: {
        source: "agent_tag",
        configKind: ownerRun ? "owner" : "isolated",
        ...(placement
          ? { folderName: placement.folderName, folderPath: placement.folderPath }
          : {}),
        model: "default",
        level: (await loadNodeProfile(input.orgId, route.nodeOwnerUserId, route.agentId)).level,
      },
    })
    return {
      kind: "queued",
      jobId: job.id,
      on: await computerLabel(input.orgId, route.nodeOwnerUserId),
      backlog: job.backlog,
    }
  } catch (err) {
    if (err instanceof NodeJobRefusedError) {
      return { kind: "refused", reason: "node_source_scope", message: err.message }
    }
    throw err
  }
}

/**
 * The node chat route (S24, A24): only the node owner's own message, in a
 * conversation whose runtime for this agent is their node.
 */
async function routeInteractive(input: NodeDispatchInput): Promise<NodeDispatch | null> {
  if (input.callerAgentId) return null
  const setting = await loadThreadNodeSetting(input.orgId, input.threadId, input.calleeAgentId)
  if (!setting) return null
  // A24: someone else's message in the same conversation runs in the cloud.
  if (setting.ownerUserId !== input.actorUserId) return null
  const job = {
    orgId: input.orgId,
    ownerUserId: setting.ownerUserId,
    agentId: input.calleeAgentId,
    threadId: input.threadId,
    targetNodeId: setting.targetNodeId,
    source: "chat" as const,
    sourceRef: input.triggerMessageId,
    prompt: input.questionText,
    sourceRequiredScopes: await triggerScopes(input.orgId, input.triggerMessageId),
    kind: "interactive" as const,
    permissionMode: setting.permissionMode,
    sdkSessionId: setting.sdkSessionId,
  }
  if (setting.runsOn === "node_else_cloud") {
    const live = await liveNodeTargets(input.orgId, setting.ownerUserId, setting.targetNodeId)
    if (live.length === 0) {
      await recordFellBackJob(job)
      return null
    }
  }
  try {
    const created = await createNodeJob({ ...job, runsOn: setting.runsOn })
    return {
      kind: "queued",
      jobId: created.id,
      on: "your computer",
      backlog: created.backlog,
      interactive: true,
    }
  } catch (err) {
    if (err instanceof NodeJobRefusedError) {
      return { kind: "refused", reason: "node_source_scope", message: err.message }
    }
    throw err
  }
}

/**
 * Where this dispatch goes. Null: the cloud, as today. A failure before any
 * route matched is logged and read as null, the behaviour every request had
 * before nodes; after an agent_tag route matched it is refused in words
 * (`node_routing_failed`, L31).
 */
export async function routeDispatchToNode(input: NodeDispatchInput): Promise<NodeDispatch | null> {
  try {
    return (await routeInteractive(input)) ?? (await routeAgentTag(input))
  } catch (err) {
    log.error({ err, agentId: input.calleeAgentId }, "node routing failed; running in the cloud")
    return null
  }
}

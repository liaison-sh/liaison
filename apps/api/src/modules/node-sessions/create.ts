// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A session started from the app (S4, D24, D32, D42, D45, two-node rule),
 * `POST /api/me/node-sessions`.
 *
 * - Agent: the one picked, else the owner's personal agent (D32); it must be
 *   one the owner can mention.
 * - Folder: resolved among the folders the owner's nodes share (names only);
 *   the node is the one advertising it (online first, then the most recently
 *   seen), and the session and job carry THAT node's path, the job targeting
 *   that node (K9).
 * - Model: offered by that node exactly or as its dated snapshot (D45).
 * - Effort: the reasoning effort the owner chose, or the model's default (S23).
 * - Autonomy (S30) and finish-with (S57): stored as asked; finish-with null is
 *   a pull request for a repository folder, decided by the node.
 * - Level: the profile's unless the owner chose one. A raise, and any choice
 *   of Open (K18), needs the owner's in-app `session_start` confirmation,
 *   attached to the new session in the same transaction as its job (K5);
 *   without it nothing is created. Lowering asks nothing. The refusal names
 *   the node the server picked and the level (m6), owner-only like the route,
 *   so the app confirms exactly that node instead of guessing. Every id sent
 *   (`confirmationId`, `confirmationIds`) is tried; the first that binds wins.
 *
 * The app offers no repo (A30).
 */
import {
  type Autonomy,
  type EffortLevel,
  type FinishWith,
  levelNeedsConfirmation,
  type NodeLevel,
} from "@liaison/shared"
import { withPrivilegedDb } from "~/db/privileged"
import { isMentionableAgent } from "~/modules/agent/directory/listing"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { createNodeJob, loadNodeProfile } from "~/modules/nodes/jobs"
import { attachConfirmation, type ConfirmationRefusal } from "./confirmations"
import {
  type FolderRef,
  loadNodeCandidates,
  pickNode,
  resolveFolder,
  resolveFolderOnNode,
  resolveModel,
} from "./resolve"

export interface AppSessionInput {
  orgId: string
  userId: string
  prompt: string
  folderName?: string
  model: string
  agentId?: string
  level?: NodeLevel
  /** S23: the reasoning effort the owner chose (absent or null: the model's default). */
  effort?: EffortLevel | null
  /** S30: guided (absent) or autonomous. */
  autonomy?: Autonomy
  /**
   * S57: how the session finishes. The row stores what was asked; null means
   * a pull request when the folder is a git repository (the node decides) and
   * is ignored otherwise.
   */
  finishWith?: FinishWith | null
  confirmationId?: string
  confirmationIds?: string[]
}

/** The node a confirmation must name: the one the two-node rule picked. */
export interface ConfirmationTarget {
  nodeId: string
  nodeName: string
}

export type AppSessionOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; code: "agent_not_yours" }
  | { ok: false; code: "no_node" }
  | { ok: false; code: "folder_unresolved"; candidates: string[] }
  | { ok: false; code: "model_unavailable"; offered: string[] }
  | {
      ok: false
      code: "confirmation_required"
      reason?: ConfirmationRefusal
      nodeIds: string[]
      nodes: ConfirmationTarget[]
      level: NodeLevel
    }

/** Rolls the creating transaction back when the confirmation does not attach. */
class ConfirmationNotAttached extends Error {
  constructor(readonly reason: ConfirmationRefusal) {
    super("confirmation_required")
  }
}

/**
 * The owner's personal agent, created on first use (kernel.agents is written
 * privileged by design), bound to org and owner. Shared by the app start and
 * the import start (import.ts).
 */
export function ownerPersonalAgentId(orgId: string, userId: string): Promise<string> {
  return withPrivilegedDb(orgId, "node-sessions:personal-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId }),
  )
}

export async function createAppSession(input: AppSessionInput): Promise<AppSessionOutcome> {
  const { orgId, userId } = input
  const agentId = input.agentId ?? (await ownerPersonalAgentId(orgId, userId))
  if (!(await isMentionableAgent(orgId, userId, agentId))) {
    return { ok: false, code: "agent_not_yours" }
  }

  const candidates = await loadNodeCandidates(orgId, userId)
  let folderName: string | null = null
  if (input.folderName !== undefined) {
    const shared = new Map<string, FolderRef>()
    for (const c of candidates) for (const f of c.folders) shared.set(f.name, f)
    const resolved = resolveFolder([...shared.values()], input.folderName)
    if (!resolved.ok) {
      return { ok: false, code: "folder_unresolved", candidates: resolved.candidates }
    }
    folderName = resolved.folder.name
  }
  const pick = pickNode(candidates, folderName)
  if (!pick.ok) return { ok: false, code: "no_node" }
  const node = pick.node

  const model = resolveModel(node, { requested: input.model })
  if (!model.ok) return { ok: false, code: "model_unavailable", offered: model.offered }

  const profile = await loadNodeProfile(orgId, userId, agentId)
  const level = input.level ?? profile.level
  const needsConfirmation = levelNeedsConfirmation(profile.level, level)
  const confirmationIds = [
    ...new Set([
      ...(input.confirmationId ? [input.confirmationId] : []),
      ...(input.confirmationIds ?? []),
    ]),
  ]
  const required = (reason?: ConfirmationRefusal): AppSessionOutcome => ({
    ok: false,
    code: "confirmation_required",
    ...(reason ? { reason } : {}),
    nodeIds: [node.nodeId],
    nodes: [{ nodeId: node.nodeId, nodeName: node.name }],
    level,
  })
  if (needsConfirmation && confirmationIds.length === 0) return required()
  const folderPath = folderName
    ? await resolveFolderOnNode(orgId, node.nodeId, { folderName })
    : null

  try {
    const job = await createNodeJob({
      orgId,
      ownerUserId: userId,
      agentId,
      threadId: null,
      source: "app",
      prompt: input.prompt,
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      session: {
        source: "app",
        configKind: "owner",
        folderName,
        folderPath,
        model: model.model,
        level,
        effort: input.effort ?? null,
        autonomy: input.autonomy ?? "guided",
        finishWith: input.finishWith ?? null,
      },
      inTransaction: needsConfirmation
        ? async (tx, created) => {
            // A failed attach only reads (select for update), so the next id is tried.
            let refusal: ConfirmationRefusal = "confirmation_not_found"
            for (const id of confirmationIds) {
              const attached = await attachConfirmation(tx, {
                id,
                orgId,
                ownerUserId: userId,
                nodeId: node.nodeId,
                agentId,
                level,
                purpose: "session_start",
                attachedSessionId: created.sessionId ?? null,
              })
              if (attached.ok) return
              refusal = attached.code
            }
            throw new ConfirmationNotAttached(refusal)
          }
        : undefined,
    })
    return { ok: true, sessionId: job.sessionId as string }
  } catch (err) {
    if (err instanceof ConfirmationNotAttached) {
      return required(err.reason)
    }
    throw err
  }
}

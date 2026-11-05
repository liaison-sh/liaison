// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * IMPORTING A CLAUDE CODE SESSION (S40, S41, S42, A44, A46, A47, A56).
 *
 * `listImportable` asks the owner's node for the sessions recorded in its
 * shared folders and gives each an opaque candidate (import-requests.ts),
 * saying which one Liaison already holds.
 *
 * `importStart` turns one candidate into an `import` session and its follow
 * job, for the candidate's owner only:
 *  1. the candidate is taken (single use, bound to the org and the owner);
 *  2. one import in flight per node (`nil:<nodeId>`, released at the end);
 *  3. the node checks the session again, fresh (S42), else its code;
 *  4. one Liaison session per CLI session per owner: an import of that id, or
 *     the owner's own in-place session running it (A56), is answered
 *     `already_in_liaison` with that session;
 *  5. the row: the owner's personal agent at its profile level, owner config,
 *     finish with nothing, guided (A44), the transcript's model when the node
 *     offers it exactly or as its dated snapshot, else the node's default
 *     with a system line saying so; and one `follow` job that replays the
 *     history window (once, for a Take over).
 *
 * Reachable only from the owner route (routes-import.ts) and the agent's
 * gated, owner-routed import tool (nodes/import-tools.ts): import.test.ts
 * walks the import graph.
 */
import type {
  NodeImportListAnswer,
  NodeImportMode,
  NodeImportOp,
  NodeSessionEventIn,
  NodeUnsharedGroup,
} from "@liaison/shared"
import { redis } from "~/lib/redis"
import { rememberCandidates } from "~/modules/nodes/folder-requests"
import {
  askNodeImport,
  type ImportAskFailure,
  type ImportRowView,
  rememberImportCandidates,
  takeImportCandidate,
} from "~/modules/nodes/import-requests"
import { createNodeJob, loadNodeProfile } from "~/modules/nodes/jobs"
import { ownerPersonalAgentId } from "./create"
import { loadNodeCandidates, resolveFolderOnNode, resolveModel } from "./resolve"
import { ownerSessionsHoldingSdkIds } from "./store"

/** How long one start may hold its node's import lock. */
const IMPORT_LOCK_SECONDS = 60
const lockKey = (nodeId: string) => `nil:${nodeId}`

/** A node's failure as the start and the listing answer it. */
export type ImportNodeFailure =
  | { code: "node_offline" }
  | { code: "node_outdated" }
  | { code: "timeout" }
  | { code: "failed" }
  | { code: string }

function nodeFailure(asked: ImportAskFailure): ImportNodeFailure {
  switch (asked.status) {
    case "offline":
      return { code: "node_offline" }
    case "node_outdated":
      return { code: "node_outdated" }
    case "timeout":
      return { code: "timeout" }
    case "failed":
      return { code: "failed" }
    case "refused":
      return { code: asked.code }
  }
}

/** The owner's sessions that hold one of these CLI ids: id -> session id. */
async function sessionsHolding(
  orgId: string,
  ownerUserId: string,
  sdkSessionIds: readonly string[],
): Promise<Map<string, string>> {
  const held = new Map<string, string>()
  if (sdkSessionIds.length === 0) return held
  const rows = await ownerSessionsHoldingSdkIds(orgId, ownerUserId, sdkSessionIds)
  for (const r of rows) {
    // The import of an id wins over a session that later moved onto it.
    if (r.importSdkSessionId && !held.has(r.importSdkSessionId)) {
      held.set(r.importSdkSessionId, r.id)
    }
  }
  for (const r of rows) {
    if (r.sdkSessionId && !held.has(r.sdkSessionId)) held.set(r.sdkSessionId, r.id)
  }
  return held
}

/** An unshared group as the owner sees it: an id to share the folder by, never its token or path. */
export type UnsharedGroupView = Omit<NodeUnsharedGroup, "token"> & { candidateId: string | null }

export type ImportListing =
  | {
      status: "done"
      rows: ImportRowView[]
      truncated: boolean
      /** The rest come only from a node that answered `detail` (A1). */
      folders?: NonNullable<NodeImportListAnswer["folders"]>
      unshared?: UnsharedGroupView[]
      skipped?: number
      unsharedPartial?: boolean
    }
  | ({ status: "refused" } & ImportNodeFailure)

/**
 * The node's importable sessions as the owner sees them: each with an id to
 * import it by (none for Liaison's own), and the Liaison session already
 * holding it. `query` filters on the node (a search the person asked for over
 * a truncated listing, D47), `folder` lists one shared folder (S12).
 *
 * `detail` asks for the per-folder counts, the sessions of folders not shared
 * yet and the skipped count (S12-S14). A node older than that refuses the key
 * (`failed`): it is asked once more with the plain listing, and the answer
 * has none of them (A1, S16). An unshared group's token becomes a folder
 * candidate, shared by id like a lookup's (folder-requests.ts).
 */
export async function listImportable(input: {
  orgId: string
  userId: string
  nodeId: string
  query?: string
  folder?: string
  detail?: boolean
  waitMs?: number
}): Promise<ImportListing> {
  const owner = { orgId: input.orgId, ownerUserId: input.userId, nodeId: input.nodeId }
  const ask = (op: Extract<NodeImportOp, { kind: "list" }>) =>
    askNodeImport({ ...owner, op, ...(input.waitMs ? { waitMs: input.waitMs } : {}) })
  const plain: Extract<NodeImportOp, { kind: "list" }> = input.query
    ? { kind: "list", query: input.query }
    : { kind: "list" }
  let asked = await ask(
    input.detail
      ? { ...plain, detail: true, ...(input.folder ? { folder: input.folder } : {}) }
      : plain,
  )
  if (input.detail && asked.status === "failed") asked = await ask(plain)
  if (asked.status !== "done") return { status: "refused", ...nodeFailure(asked) }
  const answer = asked.answer
  const held = await sessionsHolding(
    input.orgId,
    input.userId,
    answer.rows.map((r) => r.sdkSessionId),
  )
  const rows = await rememberImportCandidates(owner, answer.rows, held)
  const listing: Extract<ImportListing, { status: "done" }> = {
    status: "done",
    rows,
    truncated: answer.truncated,
  }
  if (!input.detail) return listing
  if (answer.folders) listing.folders = answer.folders
  if (answer.skipped !== undefined) listing.skipped = answer.skipped
  if (answer.unsharedPartial !== undefined) listing.unsharedPartial = answer.unsharedPartial
  if (answer.unshared) {
    const unshared: UnsharedGroupView[] = []
    for (const { token, ...group } of answer.unshared) {
      let candidateId: string | null = null
      if (token) {
        const [view] = await rememberCandidates(owner, [
          {
            name: group.name,
            token,
            display: group.display,
            isRepo: false,
            shared: false,
            shareable: true,
          },
        ])
        candidateId = view?.id ?? null
      }
      unshared.push({ ...group, candidateId })
    }
    listing.unshared = unshared
  }
  return listing
}

export interface ImportStartInput {
  orgId: string
  userId: string
  candidateId: string
  mode: NodeImportMode
  /** The approval the agent's card was decided by (nodes/import-tools.ts). */
  approvalId?: string
}

export type ImportStartOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "import_in_flight" }
  | { ok: false; code: "already_in_liaison"; sessionId: string }
  | { ok: false; code: "model_unavailable" }
  | ({ ok: false } & ImportNodeFailure)

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return (e?.code ?? e?.cause?.code) === "23505"
}

/** Starts a Follow or a Take over of the owner's candidate (see the file header). */
export async function importStart(input: ImportStartInput): Promise<ImportStartOutcome> {
  const { orgId, userId } = input
  const candidate = await takeImportCandidate(input.candidateId, { orgId, ownerUserId: userId })
  if (!candidate) return { ok: false, code: "not_found" }
  const nodeId = candidate.nodeId

  const token = crypto.randomUUID()
  const locked = await redis.set(lockKey(nodeId), token, "EX", IMPORT_LOCK_SECONDS, "NX")
  if (locked !== "OK") return { ok: false, code: "import_in_flight" }
  try {
    const checked = await askNodeImport({
      orgId,
      ownerUserId: userId,
      nodeId,
      op: {
        kind: "check",
        sdkSessionId: candidate.sdkSessionId,
        folderName: candidate.folderName,
        ...(candidate.worktreePath !== undefined ? { worktreePath: candidate.worktreePath } : {}),
        cwdSubdir: candidate.cwdSubdir,
      },
    })
    if (checked.status !== "done") return { ok: false, ...nodeFailure(checked) }
    const check = checked.answer
    if (!check.ok) return { ok: false, code: check.code }
    if (check.from === "liaison") return { ok: false, code: "already_liaison" }

    const held = await sessionsHolding(orgId, userId, [candidate.sdkSessionId])
    const holder = held.get(candidate.sdkSessionId)
    if (holder) return { ok: false, code: "already_in_liaison", sessionId: holder }

    const node = (await loadNodeCandidates(orgId, userId)).find((n) => n.nodeId === nodeId)
    if (!node) return { ok: false, code: "not_found" }
    const folderPath = await resolveFolderOnNode(orgId, nodeId, {
      folderName: candidate.folderName,
    })
    if (!folderPath) return { ok: false, code: "outside_shared" }

    const events: NodeSessionEventIn[] = []
    let model: string
    const asked = check.model ? resolveModel(node, { requested: check.model }) : null
    if (asked?.ok) {
      model = asked.model
    } else {
      const fallback = resolveModel(node, {})
      if (!fallback.ok) return { ok: false, code: "model_unavailable" }
      model = fallback.model
      if (check.model) {
        events.push({
          at: new Date().toISOString(),
          type: "system",
          payload: {
            subtype: "imported",
            text: `Model ${check.model} is not offered on this computer; using ${model}.`,
          },
        })
      }
    }

    const agentId = await ownerPersonalAgentId(orgId, userId)
    const profile = await loadNodeProfile(orgId, userId, agentId)
    const title = check.title.trim() || candidate.title.trim() || "Imported session"
    try {
      const job = await createNodeJob({
        orgId,
        ownerUserId: userId,
        agentId,
        threadId: null,
        source: "import",
        kind: "follow",
        prompt: title,
        sourceRequiredScopes: [],
        targetNodeId: nodeId,
        // The follow the claim answers (T09a): the history window, once for a Take over.
        trigger: {
          follow: { startAt: "window", once: input.mode === "take_over", inPlace: false },
        },
        session: {
          source: "import",
          configKind: "owner",
          title,
          folderName: candidate.folderName,
          folderPath,
          model,
          level: profile.level,
          effort: null,
          autonomy: "guided",
          finishWith: "none",
          import: {
            mode: input.mode,
            sdkSessionId: candidate.sdkSessionId,
            from: check.from,
            cwdSubdir: candidate.cwdSubdir,
            ...(candidate.worktreePath !== undefined
              ? { worktreePath: candidate.worktreePath }
              : {}),
          },
          ...(events.length > 0 ? { events } : {}),
        },
      })
      return { ok: true, sessionId: job.sessionId as string }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      const again = await sessionsHolding(orgId, userId, [candidate.sdkSessionId])
      const existing = again.get(candidate.sdkSessionId)
      if (!existing) throw err
      return { ok: false, code: "already_in_liaison", sessionId: existing }
    }
  } finally {
    // Released only by its holder: a lock that lapsed and was taken again stays.
    if ((await redis.get(lockKey(nodeId))) === token) await redis.del(lockKey(nodeId))
  }
}

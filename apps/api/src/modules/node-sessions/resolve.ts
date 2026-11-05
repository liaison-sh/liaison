// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Server-side resolution for a session's start (S2, S3, D28, D45): which
 * shared folder a name means, whether a repo is a URL or a repo folder, which
 * of the owner's nodes runs it, and which model.
 *
 * Paths: candidates are loaded with folder names and kinds only. A folder's
 * path is read for one node at a time (`resolveFolderOnNode`), the chosen or
 * claiming node, for that session's row and job; it never reaches a client.
 */
import {
  currentNodeModels,
  type NodeModelResolution,
  type OfferedNodeModel,
  parseClaudeModelId,
  resolveNodeModel,
} from "@liaison/shared"
import { and, eq, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { nodeCapabilities } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { liveDesktopConnections } from "~/modules/nodes/presence"

const K = () => sql.raw(schemaRef("kernel"))

/** A shared folder as resolution sees it: its name and kind, no path. */
export interface FolderRef {
  name: string
  kind: "root" | "repo"
}

export type FolderResolution<F extends { name: string }> =
  | { ok: true; folder: F }
  | { ok: false; reason: "folder_unresolved"; candidates: string[] }

const MAX_CANDIDATES = 10

/**
 * The folder a name means: the exact name, else the one name equal ignoring
 * case, else the one name it starts (ignoring case). Otherwise refused with up
 * to 10 candidate names, sorted: the names it starts or appears in, else all.
 */
export function resolveFolder<F extends { name: string }>(
  folders: readonly F[],
  query: string,
): FolderResolution<F> {
  const q = query.trim()
  const exact = folders.find((f) => f.name === q)
  if (exact) return { ok: true, folder: exact }
  const lower = q.toLowerCase()
  const insensitive = folders.filter((f) => f.name.toLowerCase() === lower)
  if (insensitive.length === 1) return { ok: true, folder: insensitive[0] }
  const prefix = folders.filter((f) => f.name.toLowerCase().startsWith(lower))
  if (lower.length > 0 && prefix.length === 1) return { ok: true, folder: prefix[0] }
  const near =
    lower.length === 0
      ? []
      : folders.filter((f) => f.name.toLowerCase().includes(lower) || insensitive.includes(f))
  const pool = near.length > 0 ? near : folders
  const candidates = [...new Set(pool.map((f) => f.name))].sort().slice(0, MAX_CANDIDATES)
  return { ok: false, reason: "folder_unresolved", candidates }
}

/**
 * Walk D24: the one shared folder a free-text request names ("In
 * liaison-walk-sample, list the files"), for a request that has no folder
 * field (an @mention of an attached agent). A name counts as a whole word,
 * ignoring case; a name inside a longer matched name does not count. None
 * when no folder or more than one is named: the session then runs as before.
 */
export function folderNamedIn<F extends { name: string }>(
  text: string,
  folders: readonly F[],
): F | null {
  const hay = text.toLowerCase()
  const named = folders.filter((f) => {
    const name = f.name.toLowerCase()
    if (!name) return false
    const re = new RegExp(`(^|[^a-z0-9_.-])${escapeRe(name)}(?![a-z0-9_-])`)
    return re.test(hay)
  })
  const outer = named.filter(
    (f) =>
      !named.some(
        (g) =>
          g !== f &&
          g.name.length > f.name.length &&
          g.name.toLowerCase().includes(f.name.toLowerCase()),
      ),
  )
  return outer.length === 1 ? outer[0] : null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const GIT_URL = /^(https:\/\/\S+|ssh:\/\/\S+|git@[^\s:]+:\S+)$/

export type RepoResolution =
  | { ok: true; url: string }
  | { ok: true; folderName: string }
  | { ok: false; reason: "folder_unresolved"; candidates: string[] }

/**
 * A repo is a git URL (https, ssh, or scp-like `git@host:path`), which the
 * node clones, or the name of a shared repo folder, whose `origin` the node
 * reads. A name resolves only among repo folders.
 */
export function resolveRepo(repo: string, folders: readonly FolderRef[]): RepoResolution {
  const r = repo.trim()
  if (GIT_URL.test(r)) return { ok: true, url: r }
  const resolved = resolveFolder(
    folders.filter((f) => f.kind === "repo"),
    r,
  )
  return resolved.ok ? { ok: true, folderName: resolved.folder.name } : resolved
}

/** One of the owner's nodes able to take a session. */
export interface NodeCandidate {
  nodeId: string
  name: string
  online: boolean
  lastSeenAt: Date | null
  folders: FolderRef[]
  /**
   * What the node OFFERS: each family's current model (`currentNodeModels`),
   * with the name the person knows each by (`label`). The SDK also lists every
   * pinned older version, and an agent offered them picked a legacy one. Lists
   * shown or chosen from read this.
   */
  models: Array<OfferedNodeModel & { label?: string }>
  /** Every model the node runs, as published (labels kept): what a session is resolved against. */
  runs: Array<OfferedNodeModel & { label?: string }>
}

export type NodePick = { ok: true; node: NodeCandidate } | { ok: false; reason: "no_node" }

/**
 * Two-node rule: with a folder, only nodes advertising it; then online first,
 * then the most recently seen.
 */
export function pickNode(
  candidates: readonly NodeCandidate[],
  folderName?: string | null,
): NodePick {
  const pool = folderName
    ? candidates.filter((c) => c.folders.some((f) => f.name === folderName))
    : [...candidates]
  if (pool.length === 0) return { ok: false, reason: "no_node" }
  pool.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0)
  })
  return { ok: true, node: pool[0] }
}

/**
 * The owner's enabled, unrevoked nodes that published capabilities (a node
 * that never did cannot run a session), with presence. Folder names and kinds
 * only: the paths are stripped in the query.
 */
export async function loadNodeCandidates(
  orgId: string,
  ownerUserId: string,
): Promise<NodeCandidate[]> {
  const rows = await withPrivilegedDb(orgId, "node-sessions:candidates", async (tx) =>
    extractRows<{
      node_id: string
      name: string
      last_seen_at: string | Date | null
      folders: FolderRef[] | null
      models: Array<{ id: string; label?: unknown }> | null
    }>(
      await tx.execute(sql`
        SELECT n.id AS node_id, n.name, n.last_seen_at,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('name', f->>'name', 'kind', f->>'kind')), '[]'::jsonb)
             FROM jsonb_array_elements(c.shared_folders) f) AS folders,
          c.models
        FROM ${K()}.nodes n
        JOIN ${K()}.node_capabilities c ON c.node_id = n.id AND c.org_id = n.org_id
        WHERE n.org_id = ${orgId} AND n.owner_user_id = ${ownerUserId}
          AND c.owner_user_id = ${ownerUserId}
          AND n.enabled AND n.revoked_at IS NULL`),
    ),
  )
  const live = await liveDesktopConnections(orgId, ownerUserId)
  return rows.map((r) => {
    const runs = (r.models ?? [])
      .filter((m) => m && typeof m.id === "string")
      .map((m) => ({ id: m.id, ...(typeof m.label === "string" ? { label: m.label } : {}) }))
    return {
      nodeId: r.node_id,
      name: r.name,
      online: live.has(r.node_id),
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at) : null,
      folders: r.folders ?? [],
      models: currentNodeModels(runs),
      runs,
    }
  })
}

/**
 * The model a session runs on, on the chosen node (D45): an explicit name
 * (app, a routine's `model`, a retry) must be one the node RUNS, exactly or
 * as its dated snapshot, an older version included (an agent's own pick goes
 * through `resolveAgentModel`, current models only); the agent's
 * preference falls back within its family's current model. Creation passes a
 * candidate (`runs`), the claim the stored list as `models`: both are the
 * full published list, so both give the same answer for the same id.
 */
export function resolveModel(
  node: { models: OfferedNodeModel[]; runs?: OfferedNodeModel[] },
  input: { requested?: string | null; agentPreference?: string | null },
): NodeModelResolution {
  return resolveNodeModel({
    requested: input.requested,
    agentPreference: input.agentPreference,
    offered: node.runs ?? node.models,
  })
}

export type AgentModelResolution =
  | { ok: true; model: string }
  | {
      ok: false
      /** The node still runs it, as an older version: the person did not choose it here. */
      legacy: boolean
      offered: string[]
    }

/**
 * A model the AGENT passes (run_on_my_computer, computer_session_settings),
 * among the node's CURRENT models only (`models`), by id or by the name the
 * person says. The agent is only ever offered those, so an older id it passes
 * came from its own knowledge or from an earlier call it copied, never from
 * the person's choice (production 2026-10-14/15: `claude-opus-4-6` started
 * twice, the person had said "Opus 5.5"). `legacy` tells such an id (which
 * the node still runs) from an unknown one. A variant of a current version
 * (its `[1m]` context row, a dated duplicate) is that version, so current:
 * same family and version as a current model. Older versions stay accepted on
 * the person's own paths: "Start again" from a card, a saved routine, the
 * Sessions controls, which resolve against `runs` (`resolveModel`).
 */
export function resolveAgentModel(
  node: {
    models: Array<OfferedNodeModel & { label?: string }>
    runs: Array<OfferedNodeModel & { label?: string }>
  },
  name: string,
): AgentModelResolution {
  const current = resolveNodeModel({
    requested: modelIdForName(node.models, name),
    offered: node.models,
  })
  if (current.ok) return current
  const runs = resolveNodeModel({ requested: modelIdForName(node.runs, name), offered: node.runs })
  if (runs.ok && isCurrentVersion(runs.model, node.models)) return runs
  return { ok: false, legacy: runs.ok, offered: current.offered }
}

/** Whether an id has the family and version of one of the current models. */
function isCurrentVersion(id: string, current: readonly OfferedNodeModel[]): boolean {
  const v = parseClaudeModelId(id)
  if (!v) return false
  return current.some((m) => {
    const c = parseClaudeModelId(m.id)
    return c !== null && c.family === v.family && c.major === v.major && c.minor === v.minor
  })
}

/**
 * A model as the person names it, among the models a node runs (`runs`, an
 * older version included): an id as is, else the one model whose label is
 * that name, ignoring case, spacing and a leading
 * "Claude" ("Opus 5.5" is "Claude Opus 5.5"). Anything else is returned as
 * given, for `resolveModel` to accept (a dated snapshot) or refuse.
 */
export function modelIdForName(
  models: ReadonlyArray<{ id: string; label?: string }>,
  name: string,
): string {
  const asked = name.trim()
  if (models.some((m) => m.id === asked)) return asked
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/^\s*claude\s+/, "")
      .replace(/\s+/g, " ")
      .trim()
  const want = norm(asked)
  const named = models.filter((m) => m.label && norm(m.label) === want)
  return named.length === 1 ? named[0].id : asked
}

/**
 * The absolute path of a folder on one node (the chosen or claiming node,
 * K9), for that session's row and job, resolved among that node's folders as
 * `resolveFolder` does. A git URL has no folder (the node clones it); a name
 * the node does not share answers null, and the node fails the session with
 * `folder_missing`.
 */
export async function resolveFolderOnNode(
  orgId: string,
  nodeId: string,
  target: { folderName: string } | { repo: string },
): Promise<string | null> {
  const name = "folderName" in target ? target.folderName : target.repo.trim()
  if ("repo" in target && GIT_URL.test(name)) return null
  const [row] = await withPrivilegedDb(orgId, "node-sessions:folder-path", (tx) =>
    tx
      .select({ sharedFolders: nodeCapabilities.sharedFolders })
      .from(nodeCapabilities)
      .where(and(eq(nodeCapabilities.nodeId, nodeId), eq(nodeCapabilities.orgId, orgId))),
  )
  const folders = (row?.sharedFolders ?? []) as Array<FolderRef & { path: string }>
  const pool = "repo" in target ? folders.filter((f) => f.kind === "repo") : folders
  const resolved = resolveFolder(pool, name)
  return resolved.ok ? resolved.folder.path : null
}

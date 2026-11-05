// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A node's folders from any client (owner-only): the server asks the node
// (apps/api/src/modules/nodes/folder-routes.ts) and answers what it said.
//
//   GET  /api/nodes/:id/folders                       the shared and search roots
//   POST /api/nodes/:id/folders/lookup        {query} folders found, each with an id
//   POST /api/nodes/:id/folders/share         {candidateId}
//   POST /api/nodes/:id/folders/unshare       {path}
//   POST /api/nodes/:id/folders/search-roots  {path}  (`~` allowed)
//   POST /api/nodes/:id/folders/search-roots/remove {path}
//   POST /api/nodes/:id/folders/scan                  every repository in the search roots
//   POST /api/nodes/:id/folders/share-many {candidateIds} several scan rows in one write
//   POST /api/nodes/:id/folders/remotes               the repositories gh and glab can list
//   POST /api/nodes/dispatch-blocked/:messageId/retry  "Start again" on a blocked card
//
// Refusals come back as an ApiError whose `code` is the node's rule
// (SharedRootHome, SearchRootAboveHome, …) or the channel's (node_offline,
// timeout); the screen turns each into a sentence.

import {
  type NodeFolderList,
  type NodeFolderRefusal,
  type NodeRemoteState,
  type NodeRemoteTool,
  parseNodeFolderList,
} from "@liaison/shared"
import type { ApiClient } from "~/lib/api-client"

type Api = Pick<ApiClient, "get" | "post">

/** A folder a lookup found: shared by its id, shown by its `~/…` path. */
export interface FoundFolder {
  id: string
  name: string
  display: string
  isRepo: boolean
  shared: boolean
  shareable: boolean
}

export interface FolderLookup {
  searchRoots: number
  candidates: FoundFolder[]
  /** The computer stopped searching early: there may be more. */
  partial: boolean
  /** Places the computer did not let Liaison read (`~/Documents`): not searched. */
  denied: string[]
  /** The implicit home default skipped Documents, Desktop and Downloads. */
  skippedProtected: boolean
}

const base = (nodeId: string) => `/nodes/${encodeURIComponent(nodeId)}/folders`

export async function nodeFolders(api: Api, nodeId: string): Promise<NodeFolderList> {
  return parseNodeFolderList(await api.get<unknown>(base(nodeId)))
}

export async function findNodeFolder(
  api: Api,
  nodeId: string,
  query: string,
): Promise<FolderLookup> {
  const raw = await api.post<{
    searchRoots?: unknown
    candidates?: unknown
    partial?: unknown
    denied?: unknown
    skippedProtected?: unknown
  }>(`${base(nodeId)}/lookup`, { query })
  const candidates = Array.isArray(raw?.candidates) ? raw.candidates : []
  return {
    searchRoots: typeof raw?.searchRoots === "number" ? raw.searchRoots : 0,
    partial: raw?.partial === true,
    skippedProtected: raw?.skippedProtected === true,
    denied: Array.isArray(raw?.denied)
      ? raw.denied.filter((d: unknown): d is string => typeof d === "string")
      : [],
    candidates: candidates
      .filter((c: any) => c && typeof c.id === "string" && typeof c.display === "string")
      .map((c: any) => ({
        id: c.id,
        name: typeof c.name === "string" ? c.name : c.display,
        display: c.display,
        isRepo: c.isRepo === true,
        shared: c.shared === true,
        shareable: c.shareable !== false,
      })),
  }
}

export async function shareNodeFolder(api: Api, nodeId: string, candidateId: string) {
  return parseNodeFolderList(await api.post<unknown>(`${base(nodeId)}/share`, { candidateId }))
}

export async function unshareNodeFolder(api: Api, nodeId: string, path: string) {
  return parseNodeFolderList(await api.post<unknown>(`${base(nodeId)}/unshare`, { path }))
}

export async function addSearchRoot(api: Api, nodeId: string, path: string) {
  return parseNodeFolderList(await api.post<unknown>(`${base(nodeId)}/search-roots`, { path }))
}

export async function removeSearchRoot(api: Api, nodeId: string, path: string) {
  return parseNodeFolderList(
    await api.post<unknown>(`${base(nodeId)}/search-roots/remove`, { path }),
  )
}

/** One repository a scan found: shared by its id (null: shared already, or it cannot be). */
export interface ScannedRepo {
  candidateId: string | null
  name: string
  display: string
  shared: boolean
  shareable: boolean
  /** Why it cannot be shared as it is (null when it can, or is shared). */
  refusal: NodeFolderRefusal | null
}

export interface RepoScan {
  searchRoots: number
  candidates: ScannedRepo[]
  /** The computer stopped on its time or folder budget: there may be more. */
  partial: boolean
  denied: string[]
  skippedProtected: boolean
}

const REFUSALS: readonly NodeFolderRefusal[] = ["home", "hidden", "outside_search"]
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

/** Every repository inside the places Add a folder looks in (S1). */
export async function scanNodeRepos(api: Api, nodeId: string): Promise<RepoScan> {
  const raw = (await api.post<unknown>(`${base(nodeId)}/scan`, {})) as Record<string, unknown>
  const candidates = Array.isArray(raw?.candidates) ? (raw.candidates as unknown[]) : []
  return {
    searchRoots: typeof raw?.searchRoots === "number" ? raw.searchRoots : 0,
    partial: raw?.partial === true,
    skippedProtected: raw?.skippedProtected === true,
    denied: Array.isArray(raw?.denied)
      ? (raw.denied as unknown[]).filter((d): d is string => typeof d === "string")
      : [],
    candidates: candidates.flatMap((v): ScannedRepo[] => {
      const c = (v ?? {}) as Record<string, unknown>
      const display = str(c.display)
      if (!display) return []
      return [
        {
          candidateId: str(c.candidateId),
          name: str(c.name) ?? display,
          display,
          shared: c.shared === true,
          shareable: c.shareable === true,
          refusal: REFUSALS.includes(c.refusal as NodeFolderRefusal)
            ? (c.refusal as NodeFolderRefusal)
            : null,
        },
      ]
    }),
  }
}

/** Several scanned repositories shared in one write (S2): the list after, and the ids refused. */
export async function shareManyNodeFolders(
  api: Api,
  nodeId: string,
  candidateIds: string[],
): Promise<{ list: NodeFolderList; refused: Array<{ candidateId: string; code: string }> }> {
  const raw = (await api.post<unknown>(`${base(nodeId)}/share-many`, { candidateIds })) as {
    refused?: unknown
  }
  const refused = Array.isArray(raw?.refused)
    ? (raw.refused as Array<Record<string, unknown>>).flatMap((r) =>
        typeof r?.candidateId === "string"
          ? [{ candidateId: r.candidateId, code: str(r.code) ?? "failed" }]
          : [],
      )
    : []
  return { list: parseNodeFolderList(raw), refused }
}

/** A repository the computer's gh or glab can list, and its clone here if any. */
export interface RemoteRepo {
  source: "github" | "gitlab"
  fullName: string
  host: string
  cloneUrl: string
  private: boolean
  pushedAt: number | null
  /** On this computer (matched by its origin): shared, or shared by `candidateId`. */
  local: { display: string; shared: boolean; candidateId: string | null } | null
}

export interface RemoteRepos {
  repos: RemoteRepo[]
  sources: Array<{ tool: NodeRemoteTool; state: NodeRemoteState }>
  dropped: number
}

const TOOLS: readonly string[] = ["gh", "glab"]
const STATES: readonly string[] = ["ok", "missing", "signed_out", "failed"]

/** The repositories the computer's signed-in gh and glab can list (S3). */
export async function nodeRemoteRepos(api: Api, nodeId: string): Promise<RemoteRepos> {
  const raw = (await api.post<unknown>(`${base(nodeId)}/remotes`, {})) as Record<string, unknown>
  const repos = (Array.isArray(raw?.repos) ? (raw.repos as unknown[]) : []).flatMap(
    (v): RemoteRepo[] => {
      const r = (v ?? {}) as Record<string, unknown>
      const fullName = str(r.fullName)
      const cloneUrl = str(r.cloneUrl)
      if (!fullName || !cloneUrl) return []
      const l = (r.local ?? null) as Record<string, unknown> | null
      return [
        {
          source: r.source === "gitlab" ? "gitlab" : "github",
          fullName,
          host: str(r.host) ?? "",
          cloneUrl,
          private: r.private === true,
          pushedAt: typeof r.pushedAt === "number" ? r.pushedAt : null,
          local:
            l && typeof l.display === "string"
              ? { display: l.display, shared: l.shared === true, candidateId: str(l.candidateId) }
              : null,
        },
      ]
    },
  )
  const sources = (Array.isArray(raw?.sources) ? (raw.sources as unknown[]) : []).flatMap((v) => {
    const x = (v ?? {}) as Record<string, unknown>
    return TOOLS.includes(x.tool as string) && STATES.includes(x.state as string)
      ? [{ tool: x.tool as NodeRemoteTool, state: x.state as NodeRemoteState }]
      : []
  })
  return {
    repos,
    sources,
    dropped: typeof raw?.dropped === "number" ? raw.dropped : 0,
  }
}

/** A clone's answer: done (the new folder list) or still running (follow its request). */
export type CloneAnswer =
  | { state: "done"; list: NodeFolderList }
  | { state: "cloning"; requestId: string }

function cloneAnswer(raw: unknown, requestId?: string): CloneAnswer {
  const r = raw as { state?: unknown; requestId?: unknown } | null
  if (r?.state === "cloning") {
    return {
      state: "cloning",
      requestId: typeof r.requestId === "string" ? r.requestId : (requestId ?? ""),
    }
  }
  return { state: "done", list: parseNodeFolderList(raw) }
}

/** Clone a repository onto the node with its own git login, then share it. */
export async function cloneOntoNode(
  api: Api,
  nodeId: string,
  url: string,
  name?: string,
): Promise<CloneAnswer> {
  return cloneAnswer(
    await api.post<unknown>(`${base(nodeId)}/clone`, { url, ...(name ? { name } : {}) }),
  )
}

/** How a running clone is doing: still cloning, done, or refused (an ApiError). */
export async function followCloneRequest(
  api: Api,
  nodeId: string,
  requestId: string,
): Promise<CloneAnswer> {
  return cloneAnswer(
    await api.get<unknown>(`${base(nodeId)}/requests/${encodeURIComponent(requestId)}`),
    requestId,
  )
}

/** "Start again" on a dispatch that was blocked by a folder not shared; `already`: another tap started it. */
export async function retryBlockedDispatch(
  api: Api,
  messageId: string,
): Promise<{ sessionId: string; already: boolean }> {
  const res = await api.post<{ sessionId?: unknown; already?: unknown }>(
    `/nodes/dispatch-blocked/${encodeURIComponent(messageId)}/retry`,
    {},
  )
  return {
    sessionId: typeof res?.sessionId === "string" ? res.sessionId : "",
    already: res?.already === true,
  }
}

/** The computer's Folders tab, with Add a folder searching for a name (the card's "Fix it"). */
export function nodeFoldersRoute(nodeId: string, folder?: string | null): string {
  const base = `/settings/computers/${encodeURIComponent(nodeId)}`
  return folder ? `${base}?${new URLSearchParams({ folder }).toString()}` : base
}

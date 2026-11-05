// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The per agent memory tree, as the Memory tab reads it.
 *
 * Deliberately NOT part of `memories-store`: that store is the signed in
 * human's own `/agent/memories` rows, keyed by `type` + `name` and isolated by
 * per user RLS. This one is one agent's tree, keyed by path, and its rows
 * belong to the agent, not to the reader. Conflating the two would put two RLS
 * domains behind one cache.
 *
 * SCOPE FILTERING IS DEFENCE IN DEPTH HERE. The server filters every scoped row
 * against the caller's grants before it answers (the same `filterByVisibility`
 * the memory verbs go through); this store filters again so the tab can say how
 * many rows it is not showing, which is the only place the count can be
 * rendered without the server inventing a "denied" answer.
 *
 * The tree surface is REST: see the contract at the top of `AgentProfile.tsx`.
 * A backend that does not carry it yet answers 404, which reads here as an
 * empty tree, never as an error.
 */
import { createStore } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { hasScope } from "~/modules/auth/auth-store"

/** One file in the tree, as its columns render into frontmatter. */
export interface AgentMemoryFile {
  path: string
  name: string
  description: string
  type: string
  /** ISO calendar date, `YYYY-MM-DD`. */
  modified: string
  requiredScopes: string[]
  /** `human` when a person wrote it, `agent` when a turn did. */
  sourceKind?: string
  /** The thread an episode came from, for the per thread grouping. */
  threadHandle?: string | null
}

/** One `memory_search` hit, as the search route answers it. Memory hits cite
 *  a path; transcript hits cite a thread, a date and an author. */
export interface AgentMemoryHit {
  kind: "file" | "episode" | "transcript"
  key: string
  path?: string
  description?: string
  snippet: string
  threadHandle?: string
  messageId?: string
  author?: string
  date?: string
  rowId?: string
  requiredScopes: string[]
  fusedScore: number
}

/** How full `MEMORY.md` is, so the tab can render the nag and the refusal. */
export interface AgentMemoryIndexFill {
  lines: number
  nearLimit: boolean
  full: boolean
}

interface AgentMemoryState {
  agentId: string | null
  files: AgentMemoryFile[]
  index: AgentMemoryIndexFill
  loading: boolean
  /** The backend carries no tree surface (404): an empty tab, not a failure. */
  unavailable: boolean
  error: string | null
  /** File bodies, by path, once read. */
  bodies: Record<string, string>
  openPath: string | null
  /** The search box: its query, its answer and how the answer failed. */
  query: string
  hits: AgentMemoryHit[]
  searching: boolean
  searched: boolean
  /** The backend carries no search route (404). Unlike the tree, this is NOT
   *  an empty result: "nothing found" and "cannot look" are different claims
   *  and the tab must never make the first one on the second one's evidence. */
  searchUnavailable: boolean
  searchError: string | null
}

const EMPTY_INDEX: AgentMemoryIndexFill = { lines: 0, nearLimit: false, full: false }

const [agentMemoryStore, setAgentMemoryStore] = createStore<AgentMemoryState>({
  agentId: null,
  files: [],
  index: { ...EMPTY_INDEX },
  loading: false,
  unavailable: false,
  error: null,
  bodies: {},
  openPath: null,
  query: "",
  hits: [],
  searching: false,
  searched: false,
  searchUnavailable: false,
  searchError: null,
})

export { agentMemoryStore }

/** `MEMORY.md` is always first; a checkpoint is immutable once written. */
export const MEMORY_INDEX_PATH = "MEMORY.md"
export const MEMORY_INDEX_MAX_LINES = 200

export function isCheckpointPath(path: string): boolean {
  return path.startsWith("checkpoints/")
}

export function isEpisodePath(path: string): boolean {
  return path.startsWith("episodes/")
}

/** A file is editable by a human unless it is a rendered checkpoint. */
export function isEditablePath(path: string): boolean {
  return !isCheckpointPath(path)
}

function coversScopes(required: string[] | undefined): boolean {
  if (!required || required.length === 0) return true
  return required.every((scope) => hasScope(scope))
}

/** The rows this viewer may see. */
export function visibleMemoryFiles(): AgentMemoryFile[] {
  return agentMemoryStore.files.filter((f) => coversScopes(f.requiredScopes))
}

/** How many rows the viewer's scopes do not cover. */
export function hiddenMemoryCount(): number {
  return agentMemoryStore.files.length - visibleMemoryFiles().length
}

function normalizeFile(raw: any): AgentMemoryFile | null {
  const path = raw?.path
  if (typeof path !== "string" || path.length === 0) return null
  return {
    path,
    name: typeof raw.name === "string" ? raw.name : path,
    description: typeof raw.description === "string" ? raw.description : "",
    type: typeof raw.type === "string" ? raw.type : "",
    modified: typeof raw.modified === "string" ? raw.modified : "",
    requiredScopes: Array.isArray(raw.requiredScopes) ? raw.requiredScopes.map(String) : [],
    sourceKind: typeof raw.sourceKind === "string" ? raw.sourceKind : undefined,
    threadHandle: typeof raw.threadHandle === "string" ? raw.threadHandle : null,
  }
}

function normalizeIndex(raw: any): AgentMemoryIndexFill {
  const lines = Number.isFinite(raw?.lines) ? Number(raw.lines) : 0
  return {
    lines,
    nearLimit: raw?.nearLimit === true,
    full: raw?.full === true,
  }
}

/** The thread a rendered artefact belongs to: `episodes/<thread>/<date>.md`
 *  and `checkpoints/<thread>.md` both carry it in the path, which is the only
 *  handle the tab has for a conversation. */
export function threadOfPath(path: string): string | null {
  if (isEpisodePath(path)) return path.split("/")[1] || null
  if (isCheckpointPath(path)) return path.slice("checkpoints/".length).replace(/\.md$/, "") || null
  return null
}

/**
 * The day an episode covers, read off its own path.
 *
 * A SECOND episode of the same day is written as `<date>-2`, and that suffix
 * belongs to the FILE, not to the day: shown as the date it reads
 * "2026-09-17-2", which is not a date anyone recognises. The row shows the day
 * and the path line under it still shows the whole file name.
 */
export function episodeDateOfPath(path: string): string | null {
  if (!isEpisodePath(path)) return null
  const parts = path.split("/")
  if (parts.length < 3) return null
  const name = parts.slice(2).join("/").replace(/\.md$/, "")
  if (!name) return null
  const day = /^(\d{4}-\d{2}-\d{2})(?:-\d+)?$/.exec(name)
  return day ? day[1] : name
}

/**
 * THE TITLE A TREE ROW SHOWS.
 *
 * An episode is written by the consolidation job under the name
 * `<handle>-<date>` with the description "Conversation in <handle> on <date>":
 * a restatement of the path, in a column that already shows the path. It reads
 * as the conversation it came from instead, "<thread title>, <date>", with the
 * handle standing in when no title is known. Everything else keeps its own
 * description, which is what a person wrote for it.
 */
export function memoryRowParts(
  file: AgentMemoryFile,
  threadTitle?: string | null,
): { title: string; date: string | null } {
  if (isEpisodePath(file.path)) {
    return {
      title: (threadTitle ?? "").trim() || threadOfPath(file.path) || file.name || file.path,
      date: episodeDateOfPath(file.path),
    }
  }
  return { title: file.description || file.name || file.path, date: null }
}

/**
 * The same row as ONE string, for a caller with one line to give it. The tree
 * itself uses `memoryRowParts`: a row that truncates must be able to keep the
 * day out of the part that gets cut.
 */
export function memoryRowLabel(file: AgentMemoryFile, threadTitle?: string | null): string {
  const { title, date } = memoryRowParts(file, threadTitle)
  return date ? `${title}, ${date}` : title
}

/** The hits this viewer may see. The server already filtered them; this is the
 *  same defence in depth the tree rows get. */
export function visibleMemoryHits(): AgentMemoryHit[] {
  return agentMemoryStore.hits.filter((h) => coversScopes(h.requiredScopes))
}

export function treePath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/memory/tree`
}

export function filePath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/memory/file`
}

export function searchPath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/memory/search`
}

export function forgetPath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/memory/forget`
}

function normalizeHit(raw: any): AgentMemoryHit | null {
  const kind = raw?.kind
  if (kind !== "file" && kind !== "episode" && kind !== "transcript") return null
  const key = typeof raw.key === "string" ? raw.key : ""
  if (!key) return null
  return {
    kind,
    key,
    path: typeof raw.path === "string" ? raw.path : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    snippet: typeof raw.snippet === "string" ? raw.snippet : "",
    threadHandle: typeof raw.threadHandle === "string" ? raw.threadHandle : undefined,
    messageId: typeof raw.messageId === "string" ? raw.messageId : undefined,
    author: typeof raw.author === "string" ? raw.author : undefined,
    date: typeof raw.date === "string" ? raw.date : undefined,
    rowId: typeof raw.rowId === "string" ? raw.rowId : undefined,
    requiredScopes: Array.isArray(raw.requiredScopes) ? raw.requiredScopes.map(String) : [],
    fusedScore: Number.isFinite(raw?.fusedScore) ? Number(raw.fusedScore) : 0,
  }
}

/** Run the search route. An empty query clears the results rather than asking
 *  the server for everything. */
export async function searchAgentMemory(
  api: ApiClient,
  agentId: string,
  query: string,
): Promise<void> {
  const trimmed = query.trim()
  setAgentMemoryStore({ query: trimmed })
  if (trimmed.length === 0) {
    clearAgentMemorySearch()
    return
  }
  setAgentMemoryStore({
    searching: true,
    searchUnavailable: false,
    searchError: null,
  })
  try {
    const res = (await api.get<any>(
      `${searchPath(agentId)}?q=${encodeURIComponent(trimmed)}`,
    )) as any
    const raw = Array.isArray(res) ? res : (res?.hits ?? [])
    setAgentMemoryStore({
      hits: (Array.isArray(raw) ? raw : [])
        .map(normalizeHit)
        .filter((h): h is AgentMemoryHit => h !== null),
      searched: true,
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      setAgentMemoryStore({ hits: [], searched: true, searchUnavailable: true })
    } else {
      setAgentMemoryStore({
        hits: [],
        searched: true,
        searchError: err instanceof Error ? err.message : "search failed",
      })
    }
  } finally {
    setAgentMemoryStore("searching", false)
  }
}

export function clearAgentMemorySearch(): void {
  setAgentMemoryStore({
    query: "",
    hits: [],
    searched: false,
    searching: false,
    searchUnavailable: false,
    searchError: null,
  })
}

/**
 * Forget one conversation: the agent's episodes for that thread and its
 * checkpoint versions go, the messages stay. The server is what deletes and
 * what audits; the store drops the rows the answer says are gone so the tree
 * does not need a reload to stop showing them.
 */
export async function forgetThreadMemory(
  api: ApiClient,
  agentId: string,
  threadHandle: string,
): Promise<{ episodesDeleted: number; checkpointsDeleted: number }> {
  const res = (await api.post<any>(forgetPath(agentId), { threadHandle })) as any
  const result = {
    episodesDeleted: Number.isFinite(res?.episodesDeleted) ? Number(res.episodesDeleted) : 0,
    checkpointsDeleted: Number.isFinite(res?.checkpointsDeleted)
      ? Number(res.checkpointsDeleted)
      : 0,
  }
  setAgentMemoryStore("files", (prev) => prev.filter((f) => threadOfPath(f.path) !== threadHandle))
  if (agentMemoryStore.openPath && threadOfPath(agentMemoryStore.openPath) === threadHandle) {
    setAgentMemoryStore("openPath", null)
  }
  return result
}

export async function loadAgentMemoryTree(api: ApiClient, agentId: string): Promise<void> {
  setAgentMemoryStore({ agentId, loading: true, error: null, unavailable: false })
  try {
    const res = (await api.get<any>(treePath(agentId))) ?? {}
    const raw = Array.isArray(res) ? res : (res.files ?? [])
    const files = (Array.isArray(raw) ? raw : [])
      .map(normalizeFile)
      .filter((f): f is AgentMemoryFile => f !== null)
    setAgentMemoryStore({ files, index: normalizeIndex(res.index) })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      setAgentMemoryStore({ files: [], index: { ...EMPTY_INDEX }, unavailable: true })
    } else {
      setAgentMemoryStore({
        files: [],
        index: { ...EMPTY_INDEX },
        error: err instanceof Error ? err.message : "load failed",
      })
    }
  } finally {
    setAgentMemoryStore("loading", false)
  }
}

export function setOpenMemoryPath(path: string | null): void {
  setAgentMemoryStore("openPath", path)
}

/** Read one file's body. A 404 leaves the body empty rather than failing. */
export async function loadAgentMemoryFileBody(
  api: ApiClient,
  agentId: string,
  path: string,
): Promise<string> {
  try {
    const res = (await api.get<any>(`${filePath(agentId)}?path=${encodeURIComponent(path)}`)) as any
    const content = typeof res?.content === "string" ? res.content : ""
    setAgentMemoryStore("bodies", path, content)
    return content
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      setAgentMemoryStore("bodies", path, "")
      return ""
    }
    throw err
  }
}

/**
 * Save a human's edit. `sourceKind: "human"` rides in the body because the
 * stamp is what tells consolidation never to drop this file, and the route is
 * the same one the verbs write through: the server still owns the audit row
 * and `lastConfirmedAt`.
 */
export async function saveAgentMemoryFile(
  api: ApiClient,
  agentId: string,
  path: string,
  content: string,
): Promise<void> {
  const res = (await api.patch<any>(filePath(agentId), {
    path,
    content,
    sourceKind: "human",
  })) as any
  const saved = typeof res?.content === "string" ? res.content : content
  setAgentMemoryStore("bodies", path, saved)
  setAgentMemoryStore("files", (prev) =>
    prev.map((f) => (f.path === path ? { ...f, sourceKind: "human" } : f)),
  )
}

export function resetAgentMemoryStore(): void {
  setAgentMemoryStore({
    agentId: null,
    files: [],
    index: { ...EMPTY_INDEX },
    loading: false,
    unavailable: false,
    error: null,
    bodies: {},
    openPath: null,
    query: "",
    hits: [],
    searching: false,
    searched: false,
    searchUnavailable: false,
    searchError: null,
  })
}

onSessionTeardown(resetAgentMemoryStore)

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE SESSION READS, typed (spec-protocol.md, client reads; P1-T15). The
// one place the web client names them:
//
//   GET /api/me/node-sessions?group=needs_you|running|done|failed|older&v=2&cursor=
//       (an API older than S9 knows only waiting|running|done|older; v=2 makes
//       its `done` done only, the old `done` being done, failed and stopped)
//       -> { sessions: NodeSessionRow[], nextCursor: string | null }
//   GET /api/me/node-sessions/:id                  -> NodeSessionRow (never a folder path)
//   GET /api/me/node-sessions/:id/events?after=&limit=&scope=top | &parent=<toolUseId>
//       -> { events: NodeSessionEvent[], lastSeq, through? }  in seq order, at most 500;
//       S53 (D20): `scope=top` is the main thread only, `parent=` one subagent
//       only, `through` the seq up to which that read is complete
//   GET /api/me/node-sessions/:id/events?before=&limit=&scope=top
//       -> { events, lastSeq }  S56 (D30): the last `limit` events below a seq,
//       in seq order ("load earlier": the client holds a recent window)
//   GET /api/me/node-sessions/:id/files-changed[?hunks=1]
//       -> { files: [{ path, added, removed, cut, hunks? }] }  S53 (D29), every event's edits
//   POST /api/me/node-sessions {prompt, folderName?, model, agentId?, level?, effort?,
//       autonomy?, finishWith?, confirmationIds?}
//       -> 201 NodeSessionRow, or a refusal { error: { code, candidates?, offered?, nodeIds? } }
//   GET /api/me/node-session-imports?nodeId=&query=&folder=  (P3-T13, S40, D47, S12)
//       -> { rows: ImportableRow[], truncated, folders?, unshared?, skipped?,
//          unsharedPartial? }  the node's importable sessions (the optional
//          fields absent from an older computer, S16)
//   POST /api/me/node-session-imports {candidateId, mode} -> 201 { sessionId }
//       or a refusal { error: { code, sessionId? } }; an API older than wave 3
//       answers its generic 404 NOT_FOUND (the entry hides, D42 pattern)
//   DELETE /api/me/node-sessions/:id   (P3-T14, A49) an import, from Liaison only
//       -> 200 { id, deleted: true }, or 404, or 409 not_import | session_live

import type {
  Autonomy,
  EffortLevel,
  FileChange,
  FinishWith,
  NodeImportFrom,
  NodeImportMode,
  NodeLevel,
  NodeSessionAtelierState,
  NodeSessionConfigKind,
  NodeSessionEvent,
  NodeSessionReasonCode,
  NodeSessionSource,
  NodeSessionStatus,
} from "@liaison/shared"
import type { ApiClient, RequestInitLike } from "~/lib/api-client"

/** A session as its owner reads it (the server's public row). */
export interface NodeSessionRow {
  id: string
  ownerUserId: string
  nodeId: string | null
  jobId: string | null
  agentId: string
  source: NodeSessionSource
  configKind: NodeSessionConfigKind
  sourceThreadId: string | null
  sourceMessageId: string | null
  title: string
  /** Absent from live `node_session` frames (fixed at creation, a GET carries it). */
  prompt?: string
  folderName: string | null
  repo: string | null
  branch: string | null
  pushed: boolean
  prUrl: string | null
  model: string
  level: NodeLevel
  /**
   * Legacy-safe status (D14): `needs_you` travels as `waiting` here so older
   * clients never see it. Read the true status with `sessionState(row)`.
   */
  status: NodeSessionStatus
  /** The true status (S9, D14); absent from an API older than this wave. */
  state?: string | null
  /** The reasoning level (D7); absent from an older API. */
  effort?: EffortLevel | null
  /** No push, computer notification or email for this session (S14); absent from an older API. */
  muted?: boolean
  /** S30: guided or autonomous; absent from an older API (the controls hide). */
  autonomy?: Autonomy
  /** S57: how the session finishes, as asked (null: a pull request for a repository). */
  finishWith?: FinishWith | null
  /** S35: the last valid Atelier state the node read (null: none); absent from an older API. */
  atelier?: NodeSessionAtelierState | null
  /** A51: an import's mode (null: not an import); absent from an API older than wave 3. */
  importMode?: NodeImportMode | null
  /** A51: which Claude Code started the imported session (null: not an import). */
  importFrom?: NodeImportFrom | null
  /** A45: a follow job of this session holds its lease (Liaison mirrors it read only). */
  following?: boolean
  /** A51: an import's recorded cwd relative to its shared folder ("" the folder itself). */
  cwdSubdir?: string | null
  /** D53: the shared repo's worktree outside the folder `cwdSubdir` is relative to. */
  worktreePath?: string | null
  pendingCount: number
  waitingReason: string | null
  claudeCode: string | null
  /** The last event's seq: a client below it pulls the tail (D40, K21). */
  lastSeq: number
  latestActivity: string | null
  /** Every input token, cache reads and writes included (unchanged for old clients, D23). */
  tokensIn: number
  tokensOut: number
  /** D23: the cumulative cache split; absent from an older API. */
  tokensCacheRead?: number
  tokensCacheWrite5m?: number
  tokensCacheWrite1h?: number
  resultSummary: string | null
  /**
   * S51: the reason line as a code to localise (another Claude Code drives
   * the session, its token limit); absent from an older API, null when the
   * session's own words (`resultSummary`) are the reason.
   */
  reasonCode?: NodeSessionReasonCode | null
  error: string | null
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  updatedAt: string
}

/** The Sessions list's groups (S9), in display order, Older last. */
export type NodeSessionGroup = "needs_you" | "running" | "done" | "failed" | "older"

/** A group id as the list route takes it: S9's, or the ids an older API knows. */
export type NodeSessionGroupQuery = NodeSessionGroup | "waiting"

export interface NodeSessionPage {
  sessions: NodeSessionRow[]
  nextCursor: string | null
}

export interface NodeSessionEventsPage {
  events: NodeSessionEvent[]
  lastSeq: number
  /**
   * S53: the seq up to which a scoped read is complete (the other scope's
   * events below it were skipped, not lost). Absent from an older API, which
   * ignores the scope and answers every event.
   */
  through?: number
}

/** S53 (D20): the main thread's events, or one subagent's (its Agent call's tool use id). */
export type EventScope = { top: true } | { parent: string }

export const NODE_SESSION_EVENTS_LIMIT = 500

type Api = Pick<ApiClient, "get">

export const SESSION_ROUTES = {
  create: "/me/node-sessions",
  imports: (nodeId: string, query?: string, folder?: string) =>
    `/me/node-session-imports?nodeId=${encodeURIComponent(nodeId)}${
      query ? `&query=${encodeURIComponent(query)}` : ""
    }${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`,
  importStart: "/me/node-session-imports",
  list: (group: NodeSessionGroupQuery, cursor?: string | null) =>
    `/me/node-sessions?group=${group}&v=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  session: (id: string) => `/me/node-sessions/${encodeURIComponent(id)}`,
  filesChanged: (id: string, hunks: boolean) =>
    `/me/node-sessions/${encodeURIComponent(id)}/files-changed${hunks ? "?hunks=1" : ""}`,
  events: (id: string, after: number, limit = NODE_SESSION_EVENTS_LIMIT, scope?: EventScope) =>
    `/me/node-sessions/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}${
      !scope ? "" : "parent" in scope ? `&parent=${encodeURIComponent(scope.parent)}` : "&scope=top"
    }`,
  eventsBefore: (
    id: string,
    before: number,
    limit = NODE_SESSION_EVENTS_LIMIT,
    scope: EventScope = { top: true },
  ) =>
    `/me/node-sessions/${encodeURIComponent(id)}/events?before=${before}&limit=${limit}${
      "parent" in scope ? `&parent=${encodeURIComponent(scope.parent)}` : "&scope=top"
    }`,
} as const

export function getSession(api: Api, id: string): Promise<NodeSessionRow> {
  return api.get<NodeSessionRow>(SESSION_ROUTES.session(id))
}

export async function getSessionEvents(
  api: Api,
  id: string,
  after: number,
  scope?: EventScope,
): Promise<NodeSessionEventsPage> {
  const page = await api.get<NodeSessionEventsPage>(
    SESSION_ROUTES.events(id, after, NODE_SESSION_EVENTS_LIMIT, scope),
  )
  return {
    events: Array.isArray(page?.events) ? page.events : [],
    lastSeq: typeof page?.lastSeq === "number" ? page.lastSeq : after,
    ...(typeof page?.through === "number" ? { through: page.through } : {}),
  }
}

/**
 * S53 (D29): what the session changed, per file, from every event (the
 * client holds the main thread only). The hunks only when asked (the drawer
 * is open). Null when the read failed or the API predates it.
 */
export async function getFilesChanged(
  api: Api,
  id: string,
  hunks: boolean,
): Promise<FileChange[] | null> {
  try {
    const page = await api.get<{ files?: unknown }>(SESSION_ROUTES.filesChanged(id, hunks))
    if (!Array.isArray(page?.files)) return null
    return (page.files as Array<Partial<FileChange>>)
      .filter((f) => typeof f?.path === "string")
      .map((f) => ({
        path: f.path as string,
        added: typeof f.added === "number" ? f.added : 0,
        removed: typeof f.removed === "number" ? f.removed : 0,
        cut: f.cut === true,
        hunks: Array.isArray(f.hunks) ? f.hunks : [],
      }))
  } catch {
    return null
  }
}

export async function listSessions(
  api: Api,
  group: NodeSessionGroupQuery,
  cursor?: string | null,
  init?: RequestInitLike,
): Promise<NodeSessionPage> {
  const page = init
    ? await api.get<NodeSessionPage>(SESSION_ROUTES.list(group, cursor), init)
    : await api.get<NodeSessionPage>(SESSION_ROUTES.list(group, cursor))
  return {
    sessions: Array.isArray(page?.sessions) ? page.sessions : [],
    nextCursor: page?.nextCursor ?? null,
  }
}

export interface CreateSessionInput {
  prompt: string
  folderName?: string
  model: string
  agentId?: string
  level?: NodeLevel
  /** S23: the reasoning level, only when the owner chose one (absent: the model's default). */
  effort?: EffortLevel
  /** S30: only when the owner switched Run on its own on (absent: guided). */
  autonomy?: Autonomy
  /** S57: how the session finishes, only when not the default `pr` (D42). */
  finishWith?: FinishWith
  /** Every `session_start` confirmation made for this start; the server uses the one that binds. */
  confirmationIds?: string[]
}

/** Why the server refused to start a session (spec-protocol.md, client reads; S4). */
export interface CreateSessionRefusal {
  ok: false
  /**
   * `folder_unresolved`, `model_unavailable`, `no_node`, `confirmation_required`, …,
   * `server_outdated` (D42: the API does not know autonomy or finishWith) or `failed`.
   */
  code: string
  /** folder_unresolved: the shared folders that came close. */
  candidates?: string[]
  /** model_unavailable: the models the node offers. */
  offered?: string[]
  /** confirmation_required: the nodes that must confirm, when the server names them. */
  nodeIds?: string[]
  /** confirmation_required: those nodes with their names (the node the server picked, m6). */
  nodes?: Array<{ nodeId: string; nodeName: string }>
}

export type CreateSessionOutcome = { ok: true; session: NodeSessionRow } | CreateSessionRefusal

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined
}

/** The start fields an API older than wave 2 does not know (D42). */
const NEW_START_FIELDS = ["autonomy", "finishWith"] as const

/**
 * D42: an API older than wave 2 validates the start body strictly, so a field
 * it does not know is a 400 VALIDATION_ERROR whose message names the field
 * (lib/validate.ts joins zod's issues). Only a field this start actually sent
 * counts.
 */
function refusesNewStartFields(input: CreateSessionInput, error: Record<string, unknown>): boolean {
  if (error.code !== "VALIDATION_ERROR" || typeof error.message !== "string") return false
  const message = error.message
  return NEW_START_FIELDS.some((f) => input[f] !== undefined && message.includes(f))
}

/**
 * Start a session from the app (S4). A refusal is an answer, not a thrown
 * error: its detail sits beside `code` in the error body (and, for some codes,
 * in `error.details`), which the API client's error does not carry, so the
 * body is read here.
 */
export async function createSession(
  api: Pick<ApiClient, "rawPost">,
  input: CreateSessionInput,
): Promise<CreateSessionOutcome> {
  const res = await api.rawPost(SESSION_ROUTES.create, input, { suppressGlobalError: true })
  let body: Record<string, unknown> | null = null
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    body = null
  }
  if (res.ok) {
    const row = (body?.data ?? body) as NodeSessionRow | null
    if (row && typeof row.id === "string") return { ok: true, session: row }
    return { ok: false, code: "failed" }
  }
  const error = (body?.error ?? {}) as Record<string, unknown>
  if (res.status === 400 && refusesNewStartFields(input, error)) {
    return { ok: false, code: "server_outdated" }
  }
  const details = (error.details ?? {}) as Record<string, unknown>
  const pick = (k: string) => strings(error[k]) ?? strings(details[k])
  const refusal: CreateSessionRefusal = {
    ok: false,
    code: typeof error.code === "string" ? error.code : "failed",
  }
  const candidates = pick("candidates")
  const offered = pick("offered")
  const nodeIds = pick("nodeIds")
  if (candidates) refusal.candidates = candidates
  if (offered) refusal.offered = offered
  if (nodeIds) refusal.nodeIds = nodeIds
  const named = Array.isArray(error.nodes) ? error.nodes : []
  const nodes = named
    .map((n) => n as Record<string, unknown>)
    .filter((n) => typeof n?.nodeId === "string" && typeof n?.nodeName === "string")
    .map((n) => ({ nodeId: n.nodeId as string, nodeName: n.nodeName as string }))
  if (nodes.length > 0) refusal.nodes = nodes
  return refusal
}

/** Where a listed session was last driven from (the node's reading of its transcript). */
export type ImportableFrom = "vscode" | "cli" | "liaison" | "other"

/** One importable session as its owner reads it (S40; never a path or a CLI id). */
export interface ImportableRow {
  /** The id to import it by (A47); null for Liaison's own session (A56: nothing to import). */
  candidateId: string | null
  title: string
  firstPrompt: string
  folderName: string
  /**
   * D53: the shared repository's own worktree outside the folder the session
   * ran in (the folder is still `folderName`); null: it ran in the folder.
   */
  worktreePath: string | null
  /** The recorded cwd relative to the worktree when there is one, else to the shared folder; "" for it itself. */
  cwdSubdir: string
  branch: string | null
  /** Epoch milliseconds. */
  lastModified: number
  createdAt: number | null
  sizeBytes: number
  from: ImportableFrom
  /** Open in another Claude Code right now (registry, argv, or written in the last 60 s). */
  liveNow: boolean
  /** The owner's Liaison session already holding it. */
  inLiaison: string | null
}

/**
 * Why a listing or an import was refused: the API's code (`node_offline`,
 * `node_outdated`, `import_in_flight`, `already_in_liaison`, `not_found`,
 * `timeout`, the node's own codes), `server_outdated` (an API older than
 * wave 3) or `failed`.
 */
export interface ImportRefusal {
  ok: false
  code: string
  /** already_in_liaison: the session that holds it. */
  sessionId?: string
}

/**
 * Sessions in a folder that is not shared (S13): its name, how it reads
 * (`~/…`), a count. Never a title, a prompt or a branch. Shared by its
 * `candidateId` through the folders share route; null with the `refusal`.
 */
export interface UnsharedGroup {
  candidateId: string | null
  name: string
  display: string
  sessions: number
  lastModified: number
  refusal: "home" | "hidden" | "outside_search" | null
}

export interface ImportListing {
  ok: true
  rows: ImportableRow[]
  truncated: boolean
  /** Each shared folder's exact session count (S12); absent from an older computer. */
  folders?: Array<{ name: string; sessions: number }>
  unshared?: UnsharedGroup[]
  /** Sessions the computer found but could not list (S14). */
  skipped?: number
  /** The computer stopped grouping unshared folders early: there may be more. */
  unsharedPartial?: boolean
}

export type ImportListOutcome = ImportListing | ImportRefusal

export type ImportStartOutcome = { ok: true; sessionId: string } | ImportRefusal

const IMPORTABLE_FROM: readonly ImportableFrom[] = ["vscode", "cli", "liaison", "other"]

async function readBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/** A refusal from an error body; the route an older API does not have is `server_outdated`. */
function importRefusal(status: number, body: Record<string, unknown> | null): ImportRefusal {
  const error = (body?.error ?? {}) as Record<string, unknown>
  if (status === 404 && error.code === "NOT_FOUND") return { ok: false, code: "server_outdated" }
  const details = (error.details ?? {}) as Record<string, unknown>
  const sessionId = error.sessionId ?? details.sessionId
  return {
    ok: false,
    code: typeof error.code === "string" ? error.code : "failed",
    ...(typeof sessionId === "string" ? { sessionId } : {}),
  }
}

function importableRow(v: unknown): ImportableRow | null {
  const r = (v ?? {}) as Record<string, unknown>
  if (typeof r.title !== "string" || typeof r.folderName !== "string") return null
  const str = (x: unknown) => (typeof x === "string" ? x : null)
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null)
  return {
    candidateId: str(r.candidateId),
    title: r.title,
    firstPrompt: str(r.firstPrompt) ?? "",
    folderName: r.folderName,
    worktreePath: str(r.worktreePath),
    cwdSubdir: str(r.cwdSubdir) ?? "",
    branch: str(r.branch),
    lastModified: num(r.lastModified) ?? 0,
    createdAt: num(r.createdAt),
    sizeBytes: num(r.sizeBytes) ?? 0,
    from: IMPORTABLE_FROM.includes(r.from as ImportableFrom) ? (r.from as ImportableFrom) : "other",
    liveNow: r.liveNow === true,
    inLiaison: str(r.inLiaison),
  }
}

const UNSHARED_REFUSALS = ["home", "hidden", "outside_search"] as const

function unsharedGroup(v: unknown): UnsharedGroup | null {
  const g = (v ?? {}) as Record<string, unknown>
  if (typeof g.name !== "string" || typeof g.display !== "string") return null
  if (typeof g.sessions !== "number" || g.sessions <= 0) return null
  const refusal = UNSHARED_REFUSALS.find((r) => r === g.refusal) ?? null
  return {
    candidateId: typeof g.candidateId === "string" ? g.candidateId : null,
    name: g.name,
    display: g.display,
    sessions: g.sessions,
    lastModified: typeof g.lastModified === "number" ? g.lastModified : 0,
    refusal,
  }
}

/**
 * The node's importable sessions (S40). `query` only for a search the person
 * submitted over a truncated listing (D47); `folder` lists one shared folder
 * (S12). A refusal is an answer.
 */
export async function listImportable(
  api: Pick<ApiClient, "rawGet">,
  nodeId: string,
  query?: string,
  folder?: string,
): Promise<ImportListOutcome> {
  let res: Response
  try {
    res = await api.rawGet(SESSION_ROUTES.imports(nodeId, query, folder), {
      suppressGlobalError: true,
      userInitiated: true,
    })
  } catch {
    return { ok: false, code: "failed" }
  }
  const body = await readBody(res)
  if (!res.ok) return importRefusal(res.status, body)
  const page = (body?.data ?? body ?? {}) as Record<string, unknown>
  const rows = Array.isArray(page.rows)
    ? page.rows.map(importableRow).filter((r): r is ImportableRow => r !== null)
    : []
  const listing: ImportListing = { ok: true, rows, truncated: page.truncated === true }
  if (Array.isArray(page.folders)) {
    listing.folders = (page.folders as Array<Record<string, unknown>>).flatMap((f) =>
      typeof f?.name === "string" && typeof f.sessions === "number"
        ? [{ name: f.name, sessions: f.sessions }]
        : [],
    )
  }
  if (Array.isArray(page.unshared)) {
    listing.unshared = page.unshared
      .map(unsharedGroup)
      .filter((g): g is UnsharedGroup => g !== null)
  }
  if (typeof page.skipped === "number") listing.skipped = page.skipped
  if (page.unsharedPartial === true) listing.unsharedPartial = true
  return listing
}

/** Import a listed session as a Follow or a Take over (S41, S42). */
export async function startImport(
  api: Pick<ApiClient, "rawPost">,
  input: { candidateId: string; mode: NodeImportMode },
): Promise<ImportStartOutcome> {
  let res: Response
  try {
    res = await api.rawPost(SESSION_ROUTES.importStart, input, { suppressGlobalError: true })
  } catch {
    return { ok: false, code: "failed" }
  }
  const body = await readBody(res)
  if (!res.ok) return importRefusal(res.status, body)
  const data = (body?.data ?? body ?? {}) as Record<string, unknown>
  return typeof data.sessionId === "string"
    ? { ok: true, sessionId: data.sessionId }
    : { ok: false, code: "failed" }
}

/** Why a delete was refused: `not_found`, `not_import`, `session_live`, or `failed`. */
export type DeleteImportOutcome = { ok: true } | { ok: false; code: string }

/**
 * A49: delete an imported session from Liaison (its row, events and
 * attention). Nothing on the computer is touched: the transcript stays.
 */
export async function deleteImportedSession(
  api: Pick<ApiClient, "delete">,
  id: string,
): Promise<DeleteImportOutcome> {
  try {
    await api.delete(SESSION_ROUTES.session(id), undefined, { suppressGlobalError: true })
    return { ok: true }
  } catch (err) {
    const e = err as { status?: unknown; code?: unknown }
    if (e?.status === 404) return { ok: false, code: "not_found" }
    return { ok: false, code: typeof e?.code === "string" ? e.code : "failed" }
  }
}

// P3-T11: the steering client lives in session-commands.ts; its two entry
// points are named here too (P2's header Stop, P4's phone top bar).
export { sendCommand, stopSession } from "./session-commands"

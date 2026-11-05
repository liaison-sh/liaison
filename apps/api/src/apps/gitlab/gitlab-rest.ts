// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real HTTP IO for the GitLab REST v4 API.
 *
 * Three responsibilities:
 *   1. Centralise `PRIVATE-TOKEN: <token>` + URL composition.
 *   2. Translate HTTP errors into the typed shape the adapter expects
 *      (`AUTH_REVOKED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, or a generic
 *      `GitlabHttpError`). Never leak the token into error messages or logs.
 *   3. Enforce a 10 MB body cap and host-pinned egress via `onHopValidate`
 *      so a rogue GITLAB_API_BASE_URL or redirect cannot reach internal infra
 *      or leak the token off-host.
 *
 * Pagination — two distinct mechanisms:
 *   - Offset endpoints: follow `x-next-page` header until empty.
 *   - Keyset endpoints (tree, where supported): follow `Link: <url>; rel="next"` URL.
 * Never depend on `x-total`.
 */

import { fetchWithPinnedHost, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"
import { readStreamCapped } from "~/lib/read-capped-body"

const GITLAB_API_BASE = process.env.GITLAB_API_BASE_URL ?? "https://gitlab.com/api/v4"

const BODY_SIZE_CAP_BYTES = 10 * 1024 * 1024 // 10 MB

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class GitlabHttpError extends Error {
  status: number
  /** Typed short code — always set for 401 / 403 / 404 / 429; undefined otherwise. */
  code?: string
  /** Raw GitLab JSON `message` or `error` field from the response body. */
  gitlabMessage?: string
  /** Parsed `Retry-After` seconds (429 only). */
  retryAfter?: number

  constructor(
    status: number,
    message: string,
    code?: string,
    gitlabMessage?: string,
    retryAfter?: number,
  ) {
    super(message)
    this.name = "GitlabHttpError"
    this.status = status
    this.code = code
    if (gitlabMessage !== undefined) this.gitlabMessage = gitlabMessage
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}

// ---------------------------------------------------------------------------
// Host-pinning validator — enforces gitlab.com on every hop
// ---------------------------------------------------------------------------

// The host the egress is pinned to is derived from the CONFIGURED base URL, not
// hardcoded to gitlab.com. In prod `GITLAB_API_BASE` defaults to
// `https://gitlab.com/api/v4`, so `configuredHost` is `gitlab.com` and pinning
// is identical to before. When a test overrides `GITLAB_API_BASE_URL` to a
// localhost mock, the mock's host becomes reachable while every other path stays
// pinned to exactly the configured host (and its subdomains).
const CONFIGURED_HOST = new URL(GITLAB_API_BASE).hostname

function makeGitlabHopValidator(token: string): (next: URL) => void {
  return (next: URL): void => {
    const h = next.hostname
    if (h !== CONFIGURED_HOST && !h.endsWith(`.${CONFIGURED_HOST}`)) {
      // Do not include the token in this error
      throw new UnsafeOutboundUrlError(
        `GitLab egress refused: host "${h}" is not ${CONFIGURED_HOST} or a subdomain`,
      )
    }
    // Ensure the token is not accidentally in the URL
    if (next.toString().includes(token)) {
      throw new UnsafeOutboundUrlError("GitLab egress refused: token detected in URL")
    }
  }
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------

async function readBodyWithSizeCap(res: Response, capBytes: number): Promise<string> {
  if (!res.body) return await res.text()
  const bytes = await readStreamCapped(res.body, capBytes)
  if (!bytes) throw new GitlabHttpError(413, `GitLab body exceeds ${capBytes}-byte cap`)
  return new TextDecoder().decode(bytes)
}

/**
 * Read a success-response body through the 10 MB size cap, then `JSON.parse`.
 * Every JSON-decoding read path (single-object GETs + keyset/offset pagers)
 * must go through this so a large blob — e.g. a base64-inflated repo file via
 * `getFile` — cannot OOM the process by bypassing the cap.
 */
async function readJsonWithSizeCap<T>(res: Response): Promise<T> {
  return JSON.parse(await readBodyWithSizeCap(res, BODY_SIZE_CAP_BYTES)) as T
}

// ---------------------------------------------------------------------------
// Parse Link header rel="next"
// ---------------------------------------------------------------------------

function parseLinkNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  // Handles: <https://...>; rel="next", <...>; rel="prev"
  for (const part of linkHeader.split(",")) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"/)
    if (m) return m[1]
  }
  return null
}

// ---------------------------------------------------------------------------
// Core fetch — injects token header, pins host, enforces size cap
// ---------------------------------------------------------------------------

async function gitlabFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${GITLAB_API_BASE}${path}`
  const onHopValidate = makeGitlabHopValidator(token)

  const res = await fetchWithPinnedHost(
    url,
    {
      ...init,
      headers: {
        "PRIVATE-TOKEN": token,
        ...((init.headers as Record<string, string>) ?? {}),
      },
      signal:
        (init as RequestInit & { signal?: AbortSignal }).signal ?? AbortSignal.timeout(15_000),
    },
    {
      requireHttps: true,
      allowPrivateHostsInTest: true,
      maxRedirects: 0,
      onHopValidate,
    },
  )

  if (res.ok) return res

  // Parse error body (safe — it comes from GitLab's response, not from our request)
  let gitlabMessage: string | undefined
  let retryAfter: number | undefined

  try {
    const body = await readBodyWithSizeCap(res, BODY_SIZE_CAP_BYTES)
    const json = JSON.parse(body) as { message?: string; error?: string }
    gitlabMessage = json.message ?? json.error
  } catch {
    /* ignore — body parse failure is non-fatal */
  }

  // The typed `code` is embedded in the message (not only the separate `.code`
  // field) so downstream surfaces that only read `err.message` — notably the
  // sync reconciler's `last_error = err.message.slice(0,500)` on a Phase-A
  // (listFolder) failure — carry the code, satisfying the "lastError has the
  // typed code" contract.
  if (res.status === 401) {
    throw new GitlabHttpError(
      401,
      "GitLab authentication failed (AUTH_REVOKED)",
      "AUTH_REVOKED",
      gitlabMessage,
    )
  }
  if (res.status === 403) {
    throw new GitlabHttpError(
      403,
      "GitLab access forbidden (FORBIDDEN)",
      "FORBIDDEN",
      gitlabMessage,
    )
  }
  if (res.status === 404) {
    throw new GitlabHttpError(
      404,
      "GitLab resource not found (NOT_FOUND)",
      "NOT_FOUND",
      gitlabMessage,
    )
  }
  if (res.status === 429) {
    const raHeader = res.headers.get("Retry-After")
    if (raHeader) {
      const parsed = Number(raHeader)
      if (!Number.isNaN(parsed)) retryAfter = parsed
    }
    throw new GitlabHttpError(
      429,
      "GitLab rate limit reached (RATE_LIMITED)",
      "RATE_LIMITED",
      gitlabMessage,
      retryAfter,
    )
  }

  throw new GitlabHttpError(res.status, `GitLab HTTP ${res.status}`, undefined, gitlabMessage)
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

interface PaginatedResult<T> {
  items: T[]
  nextCursor?: string
}

/**
 * Keyset pagination: follow `Link rel="next"` URL; no `x-next-page`.
 * Returns ALL items if no cursor given, up to internal limits.
 */
async function fetchAllKeyset<T>(
  firstPath: string,
  token: string,
  extract: (res: Response) => Promise<T[]>,
  initialCursor?: string,
): Promise<PaginatedResult<T>> {
  // `gitlabFetch` already handles absolute URLs (the `path.startsWith("http")`
  // check at the top of `gitlabFetch`), so passing `initialCursor` — which is the
  // absolute `Link: rel="next"` URL from GitLab — directly is correct.
  const res = await gitlabFetch(initialCursor ?? firstPath, token)
  const items = await extract(res)
  const linkHeader = res.headers.get("link")
  const nextUrl = parseLinkNextUrl(linkHeader)
  return { items, nextCursor: nextUrl ?? undefined }
}

/**
 * Offset pagination: follow `x-next-page` header.
 * Collects ALL pages (for methods like listCommits, listIssues, etc.).
 */
async function fetchAllOffset<T>(
  path: string,
  token: string,
  extract: (body: unknown) => T[],
): Promise<T[]> {
  const allItems: T[] = []
  let currentPath: string | null = path

  while (currentPath !== null) {
    const res = await gitlabFetch(currentPath, token)
    const body = JSON.parse(await readBodyWithSizeCap(res, BODY_SIZE_CAP_BYTES))
    allItems.push(...extract(body))

    const nextPage = res.headers.get("x-next-page")
    if (nextPage && nextPage !== "") {
      // Reconstruct URL with page= param
      const baseUrl: URL = currentPath.startsWith("http")
        ? new URL(currentPath)
        : new URL(`${GITLAB_API_BASE}${currentPath}`)
      baseUrl.searchParams.set("page", nextPage)
      currentPath = baseUrl.toString()
    } else {
      currentPath = null
    }
  }
  return allItems
}

// ---------------------------------------------------------------------------
// Path encoding helpers
// ---------------------------------------------------------------------------

function encodeProjectId(projectId: string | number): string {
  return encodeURIComponent(String(projectId))
}

function encodeFilePath(filePath: string): string {
  return encodeURIComponent(filePath)
}

// ---------------------------------------------------------------------------
// Public client shape
// ---------------------------------------------------------------------------

export interface GitlabProject {
  id: number
  path_with_namespace: string
  web_url: string
  default_branch: string
}

export interface GitlabTreeEntry {
  id: string // blob SHA
  name: string
  type: "blob" | "tree"
  path: string
}

export interface GitlabFileInfo {
  content: string // base64
  blob_id: string
  last_commit_id: string
  file_name: string
  file_path: string
  size: number
}

export interface GitlabCommit {
  id: string
  short_id: string
  title: string
  message: string
  author_name: string
  authored_date: string
  committed_date: string
  web_url: string
  parent_ids: string[]
  stats?: { additions: number; deletions: number; total: number }
  diffs?: Array<{ old_path: string; new_path: string; diff: string }>
}

export interface GitlabMergeRequest {
  iid: number
  title: string
  description: string | null
  state: string
  target_branch: string
  source_branch: string
  author: { username: string; name: string }
  assignees: Array<{ username: string }>
  milestone: { id: number; title: string; iid: number } | null
  labels: string[]
  created_at: string
  updated_at: string
  merged_at: string | null
  web_url: string
  changes?: Array<{ old_path: string; new_path: string; diff: string }>
}

export interface GitlabIssue {
  iid: number
  title: string
  description: string | null
  state: string
  labels: string[]
  milestone: { id: number; title: string; iid: number } | null
  author: { username: string; name: string }
  assignees: Array<{ username: string }>
  created_at: string
  updated_at: string
  closed_at: string | null
  web_url: string
}

export interface GitlabMilestone {
  id: number
  iid: number
  title: string
  description: string | null
  state: string
  start_date: string | null
  due_date: string | null
  web_url: string
  issue_stats?: { total: number; closed: number }
}

export interface GitlabLabel {
  id: number
  name: string
  color: string
  description: string | null
  open_issues_count?: number
  closed_issues_count?: number
  open_merge_requests_count?: number
}

export interface GitlabRelease {
  tag_name: string
  name: string
  description: string | null
  created_at: string
  released_at: string
  author: { username: string } | null
  milestones: Array<{
    id: number
    iid: number
    title: string
    issue_stats: { total: number; closed: number }
  }> | null
  assets?: { count: number }
}

export interface GitlabTag {
  name: string
  message: string | null
  commit: { id: string; title: string; committed_date: string }
  release: { tag_name: string; description: string } | null
}

export interface GitlabSearchHit {
  basename: string
  data: string
  path: string
  filename: string
  id: string | null
  ref: string
  startline?: number
  project_id: number
}

/** Minimal shape of `GET /user` — just enough to prove the token is live and
 *  report a non-secret identity (username). Never carries the token. */
export interface GitlabUser {
  id: number
  username: string
}

export interface GitlabClient {
  /** Cheapest authenticated read GitLab offers — the token owner's own profile.
   *  Used by `liaison config verify` to prove a STORED credential still works
   *  without driving any project-scoped call. */
  getCurrentUser(): Promise<GitlabUser>
  getProject(input: { projectId: string | number }): Promise<GitlabProject>
  listTree(input: {
    projectId: string | number
    ref: string
    path?: string
    recursive?: boolean
    cursor?: string
  }): Promise<{ items: GitlabTreeEntry[]; nextCursor?: string }>
  getFile(input: { projectId: string | number; path: string; ref: string }): Promise<GitlabFileInfo>
  listProjects(input: { groupId: string | number }): Promise<GitlabProject[]>
  listCommits(input: {
    projectId: string | number
    ref?: string
    path?: string
    since?: string
    until?: string
  }): Promise<GitlabCommit[]>
  getCommit(input: {
    projectId: string | number
    sha: string
    withDiff?: boolean
  }): Promise<GitlabCommit>
  listMergeRequests(input: {
    projectId: string | number
    state?: string
    target_branch?: string
    milestone?: string
    labels?: string
    updated_after?: string
  }): Promise<GitlabMergeRequest[]>
  getMergeRequest(input: {
    projectId: string | number
    iid: number
    withChanges?: boolean
  }): Promise<GitlabMergeRequest>
  listIssues(input: {
    projectId: string | number
    state?: string
    milestone?: string
    labels?: string
    search?: string
    updated_after?: string
  }): Promise<GitlabIssue[]>
  listMilestones(input: { projectId: string | number; state?: string }): Promise<GitlabMilestone[]>
  listLabels(input: { projectId: string | number; withCounts?: boolean }): Promise<GitlabLabel[]>
  listReleases(input: { projectId: string | number }): Promise<GitlabRelease[]>
  listTags(input: { projectId: string | number }): Promise<GitlabTag[]>
  search(input: {
    projectId?: string | number
    groupId?: string | number
    scope: string
    query: string
    ref?: string
  }): Promise<GitlabSearchHit[]>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeGitlabFetchers(getToken: () => Promise<string>): GitlabClient {
  return {
    async getCurrentUser() {
      const token = await getToken()
      const res = await gitlabFetch("/user", token)
      return readJsonWithSizeCap<GitlabUser>(res)
    },

    async getProject({ projectId }) {
      const token = await getToken()
      const res = await gitlabFetch(`/projects/${encodeProjectId(projectId)}`, token)
      return readJsonWithSizeCap<GitlabProject>(res)
    },

    async listTree({ projectId, ref, path = "", recursive = false, cursor }) {
      const token = await getToken()
      const qs = new URLSearchParams({
        ref,
        recursive: String(recursive),
        per_page: "100",
        pagination: "keyset",
      })
      if (path) qs.set("path", path)

      const firstPath = `/projects/${encodeProjectId(projectId)}/repository/tree?${qs.toString()}`
      return fetchAllKeyset<GitlabTreeEntry>(
        firstPath,
        token,
        async (res) => readJsonWithSizeCap<GitlabTreeEntry[]>(res),
        cursor,
      )
    },

    async getFile({ projectId, path, ref }) {
      const token = await getToken()
      const encoded = encodeFilePath(path)
      const qs = new URLSearchParams({ ref })
      const res = await gitlabFetch(
        `/projects/${encodeProjectId(projectId)}/repository/files/${encoded}?${qs.toString()}`,
        token,
      )
      return readJsonWithSizeCap<GitlabFileInfo>(res)
    },

    async listProjects({ groupId }) {
      const token = await getToken()
      // `simple=true` returns the lightweight project representation (id, name,
      // path_with_namespace, default_branch, web_url, …) — a large org (100+
      // repos) returns the FULL representation per project otherwise, and a
      // single page of 100 full objects can exceed the per-request timeout.
      // `per_page=50` keeps each page small; `fetchAllOffset` collects them all.
      return fetchAllOffset<GitlabProject>(
        `/groups/${encodeProjectId(groupId)}/projects?per_page=50&include_subgroups=true&simple=true`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabProject[],
      )
    },

    async listCommits({ projectId, ref, path, since, until }) {
      const token = await getToken()
      const qs = new URLSearchParams({ per_page: "100" })
      if (ref) qs.set("ref_name", ref)
      if (path) qs.set("path", path)
      if (since) qs.set("since", since)
      if (until) qs.set("until", until)
      return fetchAllOffset<GitlabCommit>(
        `/projects/${encodeProjectId(projectId)}/repository/commits?${qs.toString()}`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabCommit[],
      )
    },

    async getCommit({ projectId, sha, withDiff = false }) {
      const token = await getToken()
      // The single-commit endpoint returns metadata + stats only; it does NOT
      // accept `with_diffs` (silently ignored). Diffs live on the dedicated
      // `GET .../commits/:sha/diff` endpoint — fetch it separately when asked.
      const base = `/projects/${encodeProjectId(projectId)}/repository/commits/${encodeURIComponent(sha)}`
      const res = await gitlabFetch(base, token)
      const commit = await readJsonWithSizeCap<GitlabCommit>(res)
      if (withDiff) {
        const diffRes = await gitlabFetch(`${base}/diff`, token)
        commit.diffs = await readJsonWithSizeCap<GitlabCommit["diffs"]>(diffRes)
      }
      return commit
    },

    async listMergeRequests({ projectId, state, target_branch, milestone, labels, updated_after }) {
      const token = await getToken()
      const qs = new URLSearchParams({ per_page: "100" })
      if (state) qs.set("state", state)
      if (target_branch) qs.set("target_branch", target_branch)
      if (milestone) qs.set("milestone", milestone)
      if (labels) qs.set("labels", labels)
      if (updated_after) qs.set("updated_after", updated_after)
      return fetchAllOffset<GitlabMergeRequest>(
        `/projects/${encodeProjectId(projectId)}/merge_requests?${qs.toString()}`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabMergeRequest[],
      )
    },

    async getMergeRequest({ projectId, iid, withChanges = false }) {
      const token = await getToken()
      // The single-MR GET does NOT support `with_changes` (silently ignored).
      // The legacy `/changes` sub-endpoint was deprecated; the supported path
      // for an MR's per-file diffs is the paginated `/diffs` endpoint.
      const base = `/projects/${encodeProjectId(projectId)}/merge_requests/${iid}`
      const res = await gitlabFetch(base, token)
      const mr = await readJsonWithSizeCap<GitlabMergeRequest>(res)
      if (withChanges) {
        mr.changes = await fetchAllOffset<NonNullable<GitlabMergeRequest["changes"]>[number]>(
          `${base}/diffs?per_page=100`,
          token,
          (body) => (Array.isArray(body) ? body : []) as NonNullable<GitlabMergeRequest["changes"]>,
        )
      }
      return mr
    },

    async listIssues({ projectId, state, milestone, labels, search, updated_after }) {
      const token = await getToken()
      const qs = new URLSearchParams({ per_page: "100" })
      if (state) qs.set("state", state)
      if (milestone) qs.set("milestone", milestone)
      if (labels) qs.set("labels", labels)
      if (search) qs.set("search", search)
      if (updated_after) qs.set("updated_after", updated_after)
      return fetchAllOffset<GitlabIssue>(
        `/projects/${encodeProjectId(projectId)}/issues?${qs.toString()}`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabIssue[],
      )
    },

    async listMilestones({ projectId, state }) {
      const token = await getToken()
      const qs = new URLSearchParams({ per_page: "100" })
      if (state) qs.set("state", state)
      return fetchAllOffset<GitlabMilestone>(
        `/projects/${encodeProjectId(projectId)}/milestones?${qs.toString()}`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabMilestone[],
      )
    },

    async listLabels({ projectId, withCounts = false }) {
      const token = await getToken()
      const qs = new URLSearchParams({ per_page: "100" })
      if (withCounts) qs.set("with_counts", "true")
      return fetchAllOffset<GitlabLabel>(
        `/projects/${encodeProjectId(projectId)}/labels?${qs.toString()}`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabLabel[],
      )
    },

    async listReleases({ projectId }) {
      const token = await getToken()
      return fetchAllOffset<GitlabRelease>(
        `/projects/${encodeProjectId(projectId)}/releases?per_page=100`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabRelease[],
      )
    },

    async listTags({ projectId }) {
      const token = await getToken()
      return fetchAllOffset<GitlabTag>(
        `/projects/${encodeProjectId(projectId)}/repository/tags?per_page=100`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabTag[],
      )
    },

    async search({ projectId, groupId, scope, query, ref }) {
      const token = await getToken()
      const qs = new URLSearchParams({ scope, search: query, per_page: "100" })
      if (ref) qs.set("ref", ref)

      let basePath: string
      if (projectId !== undefined) {
        basePath = `/projects/${encodeProjectId(projectId)}/search`
      } else if (groupId !== undefined) {
        basePath = `/groups/${encodeProjectId(groupId)}/search`
      } else {
        basePath = "/search"
      }

      return fetchAllOffset<GitlabSearchHit>(
        `${basePath}?${qs.toString()}`,
        token,
        (body) => (Array.isArray(body) ? body : []) as GitlabSearchHit[],
      )
    },
  }
}

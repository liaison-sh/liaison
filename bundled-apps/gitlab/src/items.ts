// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Knowledge items (manifest `knowledgeItems`): GitLab files Knowledge reaches
// without syncing them.
//   - `searchGitlabKnowledge`: Knowledge's federated search, a blob search in the
//     connected group; each hit's id is `<project id>:<ref>:<path>`.
//   - `resolveGitlabItem`: one file by that same reference (a source link, a
//     remote read): its name, link and, when asked, its text.
// A reference is the one this connector always used for files, so a link made
// by an earlier release resolves here unchanged.

import {
  connectedGroup,
  encodeId,
  type GitlabCtx,
  GitlabHttpError,
  GitlabNotConnectedError,
  getJson,
  gitlabGet,
  readFile,
  redactSecrets,
  WEB_BASE,
} from "./client"
import { documentType, parseFolderRef } from "./knowledge"

/** Hits one search returns, at most. */
const SEARCH_MAX = 20
/** A snippet's length in a hit. */
const SNIPPET_CHARS = 300

interface BlobHit {
  project_id: number
  ref: string
  path: string
  filename?: string
  data?: string
}

export async function searchGitlabKnowledge(
  params: { query?: string; limit?: number; cursor?: string | null },
  ctx: GitlabCtx,
): Promise<{ results: Array<Record<string, unknown>>; nextCursor: null }> {
  const query = (params.query ?? "").trim()
  if (!query) return { results: [], nextCursor: null }
  let group: string
  try {
    group = await connectedGroup(ctx)
  } catch (err) {
    // Not connected: this source has nothing to say, not an error.
    if (err instanceof GitlabNotConnectedError) return { results: [], nextCursor: null }
    throw err
  }
  const perPage = Math.min(Math.max(Math.trunc(params.limit ?? 10), 1), SEARCH_MAX)
  const answer = await gitlabGet(
    ctx,
    `/groups/${encodeId(group)}/search?scope=blobs&search=${encodeURIComponent(query)}&per_page=${perPage}`,
  )
  const hits = JSON.parse(answer.body) as BlobHit[]
  return {
    results: hits.map((h) => ({
      id: `${h.project_id}:${h.ref}:${h.path}`,
      entity: "file",
      title: h.path,
      ...(h.data ? { snippet: redactSecrets(h.data).slice(0, SNIPPET_CHARS) } : {}),
    })),
    nextCursor: null,
  }
}

export async function resolveGitlabItem(
  params: { ref?: string; content?: boolean },
  ctx: GitlabCtx,
): Promise<Record<string, unknown>> {
  const { project, branch, path } = parseFolderRef(params.ref)
  let file: Awaited<ReturnType<typeof readFile>>
  try {
    file = await readFile(ctx, project, path, branch)
  } catch (err) {
    // Gone, or not readable with this connection: not visible. Anything else
    // (auth revoked, rate limit, outage) is an error, so a link never goes
    // stale because GitLab could not be asked.
    if (err instanceof GitlabHttpError && (err.status === 404 || err.status === 403)) {
      return { found: false }
    }
    throw err
  }
  let namespace = project
  try {
    namespace = (
      await getJson<{ path_with_namespace: string }>(ctx, `/projects/${encodeId(project)}`)
    ).path_with_namespace
  } catch {
    // Keep the given project as a best-effort link.
  }
  // Only a text file gives text; any other file is linked by name and URL.
  const text = params.content && documentType(path) ? redactSecrets(file.text) : undefined
  return {
    found: true,
    title: path.split("/").pop() || path,
    url: `${WEB_BASE}/${namespace}/-/blob/${branch}/${path}`,
    ...(text !== undefined ? { text } : {}),
  }
}

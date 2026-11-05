// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * GitLab knowledge-source adapter — implements `KnowledgeSourceAdapter`.
 *
 * `folderRef` format: `"<projectId>:<branch>:<pathPrefix>"` e.g. `"123:main:docs"`.
 * A folder item's `externalId` is also a `"<projectId>:<branch>:<entry.path>"` triple,
 * so it is a valid `folderRef` the reconciler can pass back to `listFolder`.
 *
 * `listFolder` returns DIRECT CHILDREN ONLY — the reconciler (`walkFolder`) drives
 * BFS recursion. Never call `listTree({recursive:true})`.
 *
 * Secret redaction (criterion 8): a lightweight high-confidence pattern pass is
 * applied to file bodies before upsert and on `fetchRemoteContent` output.
 */

import type { KnowledgeActor } from "~/apps/knowledge/service"
import type {
  KnowledgeFolderItem,
  KnowledgeFolderListInput,
  KnowledgeFolderListResult,
  KnowledgeSearchHit,
  KnowledgeSourceAdapter,
  KnowledgeSourceSearchResult,
} from "~/apps/knowledge/source-protocol"
import { type GitlabClient, GitlabHttpError } from "./gitlab-rest"

// ---------------------------------------------------------------------------
// MIME type map (by extension)
// ---------------------------------------------------------------------------

const EXT_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
}

function mimeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return EXT_MIME[ext] ?? "application/octet-stream"
}

function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath
}

// ---------------------------------------------------------------------------
// Secret redaction pass — minimal high-confidence patterns (criterion 8)
// No Gitleaks dependency; ~30 lines.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /AKIA[0-9A-Z]{16}/g, // AWS AKIA key
  /-----BEGIN [\w ]+ PRIVATE KEY-----[\s\S]*?-----END [\w ]+ PRIVATE KEY-----/g, // PEM private key
  /PRIVATE-TOKEN:\s*\S+/g, // Raw header value
  /Authorization:\s*Bearer\s+\S+/gi, // Bearer token in content
]

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    // `String.prototype.replace` with a `/g` regex does not advance/consult
    // `lastIndex` across calls, so no manual reset is needed here.
    out = out.replace(pattern, "[REDACTED]")
  }
  return out
}

// ---------------------------------------------------------------------------
// folderRef parser / formatter
// ---------------------------------------------------------------------------

interface FolderRef {
  projectId: string
  branch: string
  pathPrefix: string
}

function parseFolderRef(ref: string): FolderRef {
  const firstColon = ref.indexOf(":")
  const secondColon = ref.indexOf(":", firstColon + 1)
  if (firstColon === -1 || secondColon === -1) {
    throw new Error(`Invalid GitLab folderRef "${ref}": expected "<projectId>:<branch>:<path>"`)
  }
  const projectId = ref.slice(0, firstColon)
  const branch = ref.slice(firstColon + 1, secondColon)
  const pathPrefix = ref.slice(secondColon + 1)
  if (!projectId || !branch) {
    throw new Error(`Invalid GitLab folderRef "${ref}": projectId and branch must be non-empty`)
  }
  return { projectId, branch, pathPrefix }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface GitlabAdapterDeps {
  client: GitlabClient
  /**
   * Resolves the connected group/namespace (from the connection's credentials),
   * lazily at search time. When it yields a group, `searchRemote` scopes blob
   * search to it via `GET /groups/:group/search` whenever the request carries no
   * explicit `projectId`/`groupId` filter — so a federated `knowledge:search`
   * never falls through to the global `/search` endpoint. Omitted in unit tests
   * that exercise the explicit-filter path.
   */
  resolveDefaultGroupId?: () => Promise<string | undefined>
}

export function createGitlabAdapter(deps: GitlabAdapterDeps): KnowledgeSourceAdapter {
  const { client, resolveDefaultGroupId } = deps

  // Lazily cache per project — avoids redundant getProject calls within one adapter lifetime
  const projectNamespaceCache = new Map<string, string>()

  async function getNamespace(projectId: string): Promise<string | null> {
    if (projectNamespaceCache.has(projectId)) {
      return projectNamespaceCache.get(projectId) ?? null
    }
    try {
      const project = await client.getProject({ projectId })
      projectNamespaceCache.set(projectId, project.path_with_namespace)
      return project.path_with_namespace
    } catch {
      return null
    }
  }

  return {
    source: "gitlab",

    // -----------------------------------------------------------------------
    // listFolder — direct children only; reconciler drives BFS
    // -----------------------------------------------------------------------
    async listFolder(
      input: KnowledgeFolderListInput,
      _actor: KnowledgeActor,
    ): Promise<KnowledgeFolderListResult> {
      const { folderRef, cursor } = input
      const { projectId, branch, pathPrefix } = parseFolderRef(folderRef)

      const { items: treeEntries, nextCursor } = await client.listTree({
        projectId,
        ref: branch,
        path: pathPrefix,
        recursive: false,
        cursor,
      })

      const items: KnowledgeFolderItem[] = treeEntries.map((entry) => {
        const isFolder = entry.type === "tree"
        const itemExternalId = `${projectId}:${branch}:${entry.path}`
        const item: KnowledgeFolderItem = {
          kind: isFolder ? "folder" : "file",
          externalId: itemExternalId,
          name: entry.name,
          parentExternalId: folderRef,
        }
        if (!isFolder) {
          item.mimeType = mimeFromPath(entry.path)
          // etag = blob SHA for files only; not set for folders (tree SHA is not a file-change signal)
          item.etag = entry.id
        }
        return item
      })

      const result: KnowledgeFolderListResult = { items }
      if (nextCursor) result.nextCursor = nextCursor
      return result
    },

    // -----------------------------------------------------------------------
    // fetchRemoteContent — base64-decode, redact, build immutable permalink
    // -----------------------------------------------------------------------
    async fetchRemoteContent(
      input: { sourceEntityId: string },
      _actor: KnowledgeActor,
      _purpose?: string,
    ): Promise<{
      status: string
      text?: string
      url?: string
      title?: string
      modifiedAt?: string
    }> {
      const { sourceEntityId } = input
      let parsed: FolderRef
      try {
        parsed = parseFolderRef(sourceEntityId)
      } catch (_err) {
        return { status: "unavailable" }
      }
      const { projectId, branch, pathPrefix: filePath } = parsed

      let fileInfo: Awaited<ReturnType<GitlabClient["getFile"]>>
      try {
        fileInfo = await client.getFile({ projectId, path: filePath, ref: branch })
      } catch (err) {
        if (err instanceof GitlabHttpError && err.status === 404) {
          return { status: "unavailable" }
        }
        throw err
      }

      // Detect non-text: the files endpoint always returns base64 content.
      // If the file is binary, base64 decode will succeed but the text will be garbled;
      // we let the reconciler's MIME check handle it — we return "ok" with the decoded body.
      let text: string
      try {
        text = Buffer.from(fileInfo.content, "base64").toString("utf-8")
      } catch {
        return { status: "unsupported" }
      }

      // Apply secret redaction
      text = redactSecrets(text)

      // Build immutable permalink via last_commit_id + path_with_namespace
      const namespace = await getNamespace(projectId)
      let url: string
      if (namespace) {
        url = `https://gitlab.com/${namespace}/-/blob/${fileInfo.last_commit_id}/${filePath}`
      } else {
        // Non-immutable fallback
        url = `https://gitlab.com/projects/${projectId}/-/blob/${branch}/${filePath}`
      }

      return {
        status: "ok",
        text,
        title: basename(filePath),
        url,
        modifiedAt: undefined, // GitLab files API doesn't provide this directly
      }
    },

    // -----------------------------------------------------------------------
    // getRemoteMetadata — returns blob SHA as the external rev
    // -----------------------------------------------------------------------
    async getRemoteMetadata(
      input: { sourceEntityId: string },
      _actor: KnowledgeActor,
    ): Promise<{ url?: string; title?: string; modifiedAt?: string; rev?: string } | null> {
      let parsed: FolderRef
      try {
        parsed = parseFolderRef(input.sourceEntityId)
      } catch {
        return null
      }
      const { projectId, branch, pathPrefix: filePath } = parsed
      try {
        const fileInfo = await client.getFile({ projectId, path: filePath, ref: branch })
        const namespace = await getNamespace(projectId)
        const url = namespace
          ? `https://gitlab.com/${namespace}/-/blob/${fileInfo.last_commit_id}/${filePath}`
          : undefined
        return {
          url,
          title: basename(filePath),
          rev: fileInfo.blob_id,
        }
      } catch {
        return null
      }
    },

    // -----------------------------------------------------------------------
    // searchRemote — GitLab blob search; degrades gracefully when unavailable
    // -----------------------------------------------------------------------
    async searchRemote(
      input: {
        query: string
        limit: number
        cursors?: Record<string, string>
        filters?: Record<string, unknown>
      },
      _actor: KnowledgeActor,
    ): Promise<KnowledgeSourceSearchResult> {
      // Determine projectId/groupId scope from filters, falling back to the
      // connected group so a federated search never hits the global `/search`
      // endpoint (which is unscoped and usually unavailable on gitlab.com).
      const projectId = input.filters?.projectId as string | undefined
      const filterGroupId = input.filters?.groupId as string | undefined

      const start = Date.now()
      try {
        const groupId = filterGroupId ?? (projectId ? undefined : await resolveDefaultGroupId?.())
        const hits_raw = await client.search({
          // When a projectId filter is present, scope to it; otherwise scope to
          // the connected group (filter override or the injected default).
          groupId,
          projectId,
          scope: "blobs",
          query: input.query,
        })

        // Apply limit
        const limited = hits_raw.slice(0, input.limit)

        const hits: KnowledgeSearchHit[] = await Promise.all(
          limited.map(async (hit) => {
            const ref = hit.ref ?? "main"
            // Always build the valid `<projectId>:<branch>:<path>` triple — every
            // GitlabSearchHit carries `project_id` — so the hit round-trips through
            // `fetchRemoteContent`/`parseFolderRef` regardless of search scope.
            const sourceEntityId = `${hit.project_id}:${ref}:${hit.path}`
            // Resolve the project namespace for a real permalink; `hit.path` is the
            // in-repo file path, NOT the namespace, so it must not go in that slot.
            const namespace = await getNamespace(String(hit.project_id))
            const hitMapped: KnowledgeSearchHit = {
              source: "gitlab",
              sourceEntityId,
              title: hit.path,
              type: "file",
              snippet: hit.data,
              canFetchContent: true,
            }
            if (namespace) {
              hitMapped.url = `https://gitlab.com/${namespace}/-/blob/${ref}/${hit.path}`
            }
            return hitMapped
          }),
        )

        return {
          hits,
          status: {
            source: "gitlab",
            state: "complete",
            retryable: false,
            durationMs: Date.now() - start,
            hitCount: hits.length,
          },
        }
      } catch (err) {
        const durationMs = Date.now() - start

        if (err instanceof GitlabHttpError) {
          if (err.status === 400) {
            // Blob search unavailable (Advanced Search not enabled)
            return {
              hits: [],
              status: {
                source: "gitlab",
                state: "skipped",
                retryable: false,
                message: "GitLab code search requires Advanced Search on this group",
                durationMs,
                hitCount: 0,
              },
            }
          }
          if (err.status === 429) {
            return {
              hits: [],
              status: {
                source: "gitlab",
                state: "rate-limited",
                retryable: true,
                message: "GitLab rate limit reached. Try again shortly.",
                durationMs,
                hitCount: 0,
              },
            }
          }
          if (err.status === 401 || err.status === 403) {
            return {
              hits: [],
              status: {
                source: "gitlab",
                state: "unauthorized",
                retryable: false,
                message: "GitLab access denied. Please check your token.",
                durationMs,
                hitCount: 0,
              },
            }
          }
        }

        // Check if this is a "no connection" error (token fetch failure)
        const message = err instanceof Error ? err.message : "GitLab search failed"
        if (message.includes("No connected account")) {
          return {
            hits: [],
            status: {
              source: "gitlab",
              state: "skipped",
              retryable: false,
              message: "GitLab not connected for this organization",
              durationMs,
              hitCount: 0,
            },
          }
        }

        return {
          hits: [],
          status: {
            source: "gitlab",
            state: "error",
            retryable: true,
            message,
            durationMs,
            hitCount: 0,
          },
        }
      }
    },
  }
}

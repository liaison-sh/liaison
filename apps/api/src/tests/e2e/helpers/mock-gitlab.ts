// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"

/**
 * Mock GitLab REST v4 server for E2E tests.
 *
 * Routes mounted under /api/v4 mirroring the production endpoints the GitLab
 * sync path hits (`apps/api/src/apps/gitlab/gitlab-rest.ts` +
 * `apps/api/src/apps/gitlab/adapter.ts`):
 *   - GET /api/v4/projects/:id                                  — project meta
 *                                                                  (path_with_namespace
 *                                                                  for permalinks)
 *   - GET /api/v4/projects/:id/repository/tree                  — folder listing
 *                                                                  (one BFS level)
 *   - GET /api/v4/projects/:id/repository/files/:path?ref=      — file content
 *                                                                  (base64)
 *   - GET /api/v4/projects/:id/search | /groups/:id/search      — blob search
 *
 * Enough to sync ONE markdown manual into the knowledge base: a single tree
 * level containing one `.md` blob + the file content endpoint that serves it.
 *
 * Each `startMockGitlab(port)` boots an isolated Bun.serve instance with its
 * own fixture map + request log so parallel Playwright workers can't bleed
 * state across each other. Lifecycle mirrors `mock-drive.ts`.
 *
 * Auth: the production client sends `PRIVATE-TOKEN: <token>` (NOT a Bearer
 * Authorization header). The mock requires that header to be present and
 * non-empty, mirroring how mock-drive enforces a Bearer token.
 */

/** A single file (blob) inside a project's tree at `path`. */
export interface MockGitlabFile {
  /** In-repo path, e.g. "docs/manual.md". */
  path: string
  /** Blob SHA — surfaces as the tree entry `id` and the file `blob_id`. */
  blobId: string
  /** Raw (un-encoded) file text. The files endpoint serves it base64-encoded. */
  body: string
  /** Commit SHA the immutable permalink is built from. */
  lastCommitId?: string
}

export interface MockGitlabProject {
  /** Numeric or string id used as the `:id` URL path segment. */
  id: string
  /** `group/project` slug → drives `path_with_namespace` + permalinks. */
  pathWithNamespace: string
  defaultBranch?: string
  files: MockGitlabFile[]
}

export interface MockGitlabRequest {
  method: string
  path: string
  query: Record<string, string>
  privateToken: string | null
}

export interface MockGitlabHandle {
  url: string
  port: number
  requestLog: MockGitlabRequest[]
  setProject: (project: MockGitlabProject) => void
  resetFixtures: () => void
  resetRequestLog: () => void
  kill: () => Promise<void>
}

/**
 * Boot an isolated mock-GitLab server. Pass `0` (the default) to let the OS
 * assign a free port — the returned handle's `url` / `port` reflect the actual
 * bound port, so callers never need to hunt for a free one.
 */
export async function startMockGitlab(port = 0): Promise<MockGitlabHandle> {
  const projects = new Map<string, MockGitlabProject>()
  const requestLog: MockGitlabRequest[] = []

  const app = new Hono()

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url)
    const query: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      query[key] = value
    })
    requestLog.push({
      method: c.req.method,
      path: url.pathname,
      query,
      privateToken: c.req.header("private-token") ?? null,
    })
    const token = c.req.header("private-token") ?? ""
    if (token.length === 0) {
      return c.json({ message: "401 Unauthorized" }, 401)
    }
    return next()
  })

  // GET /api/v4/projects/:id — project metadata for permalink resolution.
  // Must be matched BEFORE the /repository routes below.
  app.get("/api/v4/projects/:id", (c) => {
    const project = projects.get(c.req.param("id"))
    if (!project) return c.json({ message: "404 Project Not Found" }, 404)
    return c.json({
      id: Number.isNaN(Number(project.id)) ? project.id : Number(project.id),
      path_with_namespace: project.pathWithNamespace,
      web_url: `http://localhost:${port}/${project.pathWithNamespace}`,
      default_branch: project.defaultBranch ?? "main",
    })
  })

  // GET /api/v4/projects/:id/repository/tree — direct children of `?path=`.
  // The adapter's `listFolder` is non-recursive; the reconciler drives BFS, so
  // we return only the entries whose parent directory equals the requested
  // path (top-level files when no `path`).
  app.get("/api/v4/projects/:id/repository/tree", (c) => {
    const project = projects.get(c.req.param("id"))
    if (!project) return c.json({ message: "404 Project Not Found" }, 404)
    const reqPath = c.req.query("path") ?? ""
    const prefix = reqPath ? `${reqPath.replace(/\/$/, "")}/` : ""

    const entries = project.files
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => {
        // direct child segment within the requested directory
        const rest = f.path.slice(prefix.length)
        const slash = rest.indexOf("/")
        if (slash === -1) {
          // a file directly in this directory
          return { id: f.blobId, name: rest, type: "blob" as const, path: f.path }
        }
        // a sub-directory — emit a single tree entry for it
        const dirName = rest.slice(0, slash)
        return {
          id: `tree-${dirName}`,
          name: dirName,
          type: "tree" as const,
          path: `${prefix}${dirName}`,
        }
      })

    // de-dupe sub-directory tree entries (multiple files can share a subdir)
    const seen = new Set<string>()
    const deduped = entries.filter((e) => {
      if (seen.has(e.path)) return false
      seen.add(e.path)
      return true
    })

    return c.json(deduped)
  })

  // GET /api/v4/projects/:id/repository/files/:path?ref= — file content (base64).
  // `:path` is URL-encoded by the client (e.g. `docs%2Fmanual.md`); Hono decodes
  // the param for us.
  app.get("/api/v4/projects/:id/repository/files/:path", (c) => {
    const project = projects.get(c.req.param("id"))
    if (!project) return c.json({ message: "404 Project Not Found" }, 404)
    const filePath = c.req.param("path")
    const file = project.files.find((f) => f.path === filePath)
    if (!file) return c.json({ message: "404 File Not Found" }, 404)

    return c.json({
      file_name: file.path.split("/").pop() ?? file.path,
      file_path: file.path,
      size: Buffer.byteLength(file.body, "utf-8"),
      content: Buffer.from(file.body, "utf-8").toString("base64"),
      content_sha256: file.blobId,
      ref: c.req.query("ref") ?? project.defaultBranch ?? "main",
      blob_id: file.blobId,
      commit_id: file.lastCommitId ?? "commit-0000",
      last_commit_id: file.lastCommitId ?? "commit-0000",
    })
  })

  // Blob search — project-scoped and group-scoped. Returns matching files'
  // bodies as hits. Kept minimal: a substring match against the file body/path.
  function searchProject(project: MockGitlabProject, scope: string, term: string) {
    if (scope !== "blobs") return []
    const needle = term.toLowerCase()
    return project.files
      .filter((f) => f.body.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle))
      .map((f) => ({
        basename: (f.path.split("/").pop() ?? f.path).replace(/\.[^.]+$/, ""),
        data: f.body,
        path: f.path,
        filename: f.path,
        id: f.blobId,
        ref: project.defaultBranch ?? "main",
        startline: 1,
        project_id: Number.isNaN(Number(project.id)) ? 0 : Number(project.id),
      }))
  }

  app.get("/api/v4/projects/:id/search", (c) => {
    const project = projects.get(c.req.param("id"))
    if (!project) return c.json({ message: "404 Project Not Found" }, 404)
    return c.json(
      searchProject(project, c.req.query("scope") ?? "blobs", c.req.query("search") ?? ""),
    )
  })

  app.get("/api/v4/groups/:id/search", (c) => {
    const scope = c.req.query("scope") ?? "blobs"
    const term = c.req.query("search") ?? ""
    const hits = [...projects.values()].flatMap((p) => searchProject(p, scope, term))
    return c.json(hits)
  })

  // GET /api/v4/groups/:id/projects — group project listing (gitlab_list_projects).
  app.get("/api/v4/groups/:id/projects", (c) => {
    return c.json(
      [...projects.values()].map((p) => ({
        id: Number.isNaN(Number(p.id)) ? p.id : Number(p.id),
        path_with_namespace: p.pathWithNamespace,
        web_url: `http://localhost:${port}/${p.pathWithNamespace}`,
        default_branch: p.defaultBranch ?? "main",
      })),
    )
  })

  const server = Bun.serve({ fetch: app.fetch, port })
  // Reflect the actually-bound port back into the closure so `web_url`
  // fallbacks (and the returned handle) carry the real port when `0` was passed.
  port = Number(server.port)

  return {
    url: `http://localhost:${port}`,
    port,
    requestLog,
    setProject: (project) => {
      projects.set(project.id, project)
    },
    resetFixtures: () => projects.clear(),
    resetRequestLog: () => {
      requestLog.length = 0
    },
    kill: async () => {
      server.stop(true)
    },
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Unit tests for the GitLab tool implementations (tools.ts).
 * HTTP is mocked via OutboundFetchTestAccess.setFetch; no DB needed.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import gitlabManifest from "./app.manifest.json"
import {
  type GitlabToolCtx,
  gitlabGetCommit,
  gitlabListCommits,
  gitlabListProjects,
  gitlabListReleases,
  gitlabReadFile,
  gitlabSearch,
  NOT_CONNECTED,
} from "./tools"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function stubFetch(
  fn: (url: string | URL, init?: RequestInit) => Response | Promise<Response>,
): void {
  OutboundFetchTestAccess.setFetch(fn as unknown as typeof fetch)
}

// RlsClient mock — tools don't use it for these tests
const mockTx = {} as GitlabToolCtx["tx"]

function makeCtx(creds: GitlabToolCtx["creds"]): GitlabToolCtx {
  return { tx: mockTx, orgId: "org-1", userId: "user-1", creds }
}

const validCreds = { token: "glpat-test-token-abc123", group: "acme" }

// ---------------------------------------------------------------------------
// not_connected — every tool returns NOT_CONNECTED when creds null
// ---------------------------------------------------------------------------

describe("tools — not_connected guard", () => {
  afterEach(() => OutboundFetchTestAccess.setFetch(null))

  it("gitlabListProjects returns NOT_CONNECTED and makes no HTTP", async () => {
    let httpCalled = false
    stubFetch(() => {
      httpCalled = true
      return jsonResponse([])
    })

    const result = await gitlabListProjects(makeCtx(null), {} as never)
    expect(result).toEqual(NOT_CONNECTED)
    expect(httpCalled).toBe(false)
  })

  it("gitlabListCommits returns NOT_CONNECTED and makes no HTTP", async () => {
    let httpCalled = false
    stubFetch(() => {
      httpCalled = true
      return jsonResponse([])
    })

    const result = await gitlabListCommits(makeCtx(null), { project: "123" })
    expect(result).toEqual(NOT_CONNECTED)
    expect(httpCalled).toBe(false)
  })

  it("gitlabReadFile returns NOT_CONNECTED and makes no HTTP", async () => {
    let httpCalled = false
    stubFetch(() => {
      httpCalled = true
      return jsonResponse({})
    })

    const result = await gitlabReadFile(makeCtx(null), { project: "123", path: "README.md" })
    expect(result).toEqual(NOT_CONNECTED)
    expect(httpCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// gitlabListCommits — params → right client call → compact result
// ---------------------------------------------------------------------------

describe("gitlabListCommits", () => {
  afterEach(() => OutboundFetchTestAccess.setFetch(null))

  it("maps params to client call and returns compact result", async () => {
    const commit = {
      id: "abc123",
      short_id: "abc123",
      title: "Fix bug",
      message: "Fix bug\n\nDetails",
      author_name: "Alice",
      authored_date: "2024-01-01T00:00:00Z",
      committed_date: "2024-01-01T00:00:00Z",
      web_url: "https://gitlab.com/acme/repo/-/commit/abc123",
      parent_ids: [],
    }
    stubFetch((url) => {
      expect(url.toString()).toContain("/repository/commits")
      return jsonResponse([commit], 200, { "x-next-page": "" })
    })

    const result = await gitlabListCommits(makeCtx(validCreds), {
      project: "acme/repo",
      ref: "main",
    })

    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.commits).toHaveLength(1)
    expect((result.commits[0] as { sha: string }).sha).toBe("abc123")
    expect((result.commits[0] as { author: string }).author).toBe("Alice")
  })
})

// ---------------------------------------------------------------------------
// gitlabReadFile — line range + boundary validation
// ---------------------------------------------------------------------------

describe("gitlabReadFile", () => {
  afterEach(() => OutboundFetchTestAccess.setFetch(null))

  const fileContent = "line1\nline2\nline3\nline4\nline5"
  const fileResponse = {
    content: btoa(fileContent),
    blob_id: "blobXYZ",
    last_commit_id: "commitXYZ",
    file_name: "README.md",
    file_path: "README.md",
    size: fileContent.length,
  }
  const projectResponse = {
    id: 42,
    path_with_namespace: "acme/repo",
    web_url: "https://gitlab.com/acme/repo",
    default_branch: "main",
  }

  // gitlabReadFile makes two calls: getFile (for content) + getProject (for the
  // permalink namespace). Route by URL so each call gets the right shape.
  function routeFileAndProject(url: string | URL): Response {
    const u = url.toString()
    if (u.includes("/repository/files/")) return jsonResponse(fileResponse)
    return jsonResponse(projectResponse)
  }

  it("returns correct line range when startLine/endLine given", async () => {
    stubFetch(routeFileAndProject)

    const result = await gitlabReadFile(makeCtx(validCreds), {
      project: "acme/repo",
      path: "README.md",
      startLine: 2,
      endLine: 4,
    })

    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.content).toBe("line2\nline3\nline4")
  })

  it("builds the permalink from resolved path_with_namespace, not a numeric project id", async () => {
    // Caller passes a numeric id; the URL must still use the namespace.
    stubFetch(routeFileAndProject)

    const result = await gitlabReadFile(makeCtx(validCreds), {
      project: "42",
      path: "README.md",
    })

    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.url).toBe("https://gitlab.com/acme/repo/-/blob/commitXYZ/README.md")
  })

  it("returns INVALID_PARAMS when startLine > endLine", async () => {
    stubFetch(() => jsonResponse(fileResponse))

    const result = await gitlabReadFile(makeCtx(validCreds), {
      project: "acme/repo",
      path: "README.md",
      startLine: 5,
      endLine: 2,
    })

    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error.code).toBe("INVALID_PARAMS")
  })

  it("returns INVALID_PARAMS when startLine > line count", async () => {
    stubFetch(() => jsonResponse(fileResponse))

    const result = await gitlabReadFile(makeCtx(validCreds), {
      project: "acme/repo",
      path: "README.md",
      startLine: 100,
    })

    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error.code).toBe("INVALID_PARAMS")
  })

  it("redacts glpat- secret from file content", async () => {
    const secretContent = "token: glpat-ABCDEFabcdef12345678\ncontent"
    stubFetch((url) => {
      if (url.toString().includes("/repository/files/")) {
        return jsonResponse({
          content: btoa(secretContent),
          blob_id: "b1",
          last_commit_id: "c1",
          file_name: "config.md",
          file_path: "config.md",
          size: secretContent.length,
        })
      }
      return jsonResponse(projectResponse)
    })

    const result = await gitlabReadFile(makeCtx(validCreds), {
      project: "acme/repo",
      path: "config.md",
    })

    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.content).not.toContain("glpat-")
    expect(result.content).toContain("[REDACTED]")
  })
})

// ---------------------------------------------------------------------------
// gitlabListReleases — embedded milestone issue_stats
// ---------------------------------------------------------------------------

describe("gitlabListReleases", () => {
  afterEach(() => OutboundFetchTestAccess.setFetch(null))

  it("exposes embedded milestone issue_stats", async () => {
    const releases = [
      {
        tag_name: "v1.0.0",
        name: "Version 1.0",
        description: "First release",
        created_at: "2024-01-01",
        released_at: "2024-01-01",
        author: { username: "alice" },
        milestones: [
          {
            id: 1,
            iid: 1,
            title: "v1.0",
            issue_stats: { total: 10, closed: 8 },
          },
        ],
        assets: { count: 3 },
      },
    ]
    stubFetch(() => jsonResponse(releases, 200, { "x-next-page": "" }))

    const result = await gitlabListReleases(makeCtx(validCreds), { project: "acme/repo" })

    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.releases).toHaveLength(1)
    const release = result.releases[0] as {
      tagName: string
      milestones: Array<{ issueStats: { total: number; closed: number } }>
    }
    expect(release.tagName).toBe("v1.0.0")
    expect(release.milestones[0].issueStats.total).toBe(10)
    expect(release.milestones[0].issueStats.closed).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// gitlabSearch — scope, query → results
// ---------------------------------------------------------------------------

describe("gitlabSearch", () => {
  afterEach(() => OutboundFetchTestAccess.setFetch(null))

  it("maps search results to compact output", async () => {
    const hits = [
      {
        basename: "readme",
        data: "some content",
        path: "docs/readme.md",
        filename: "readme.md",
        id: null,
        ref: "main",
        project_id: 123,
      },
    ]
    stubFetch((url) => {
      expect(url.toString()).toContain("scope=blobs")
      expect(url.toString()).toContain("search=hello")
      return jsonResponse(hits, 200, { "x-next-page": "" })
    })

    const result = await gitlabSearch(makeCtx(validCreds), {
      scope: "blobs",
      query: "hello",
    })

    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.results).toHaveLength(1)
    expect((result.results[0] as { path: string }).path).toBe("docs/readme.md")
  })
})

// ---------------------------------------------------------------------------
// Error transparency — GitlabHttpError → real detail, no token leak
// ---------------------------------------------------------------------------

describe("error transparency", () => {
  afterEach(() => OutboundFetchTestAccess.setFetch(null))

  it("403 → FORBIDDEN with real GitLab message in result", async () => {
    stubFetch(() => jsonResponse({ message: "Access denied to this resource" }, 403))

    const result = await gitlabListProjects(makeCtx(validCreds), {} as never)

    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error.code).toBe("FORBIDDEN")
    expect(result.error.message).toBe("Access denied to this resource")
  })

  it("error result contains no token substring", async () => {
    const secretToken = "glpat-super-secret-token-must-not-leak"
    stubFetch(() => jsonResponse({ message: "Internal server error" }, 500))

    const result = await gitlabListProjects(
      makeCtx({ token: secretToken, group: "acme" }),
      {} as never,
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(secretToken)
  })

  it("gitlabGetCommit 404 → NOT_FOUND error code", async () => {
    stubFetch(() => jsonResponse({ message: "Not found" }, 404))

    const result = await gitlabGetCommit(makeCtx(validCreds), {
      project: "acme/repo",
      sha: "nonexistent",
    })

    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error.code).toBe("NOT_FOUND")
  })
})

// ---------------------------------------------------------------------------
// Manifest self-consistency
// ---------------------------------------------------------------------------

describe("manifest self-consistency", () => {
  it("manifest has name='gitlab'", () => {
    expect(gitlabManifest.name).toBe("gitlab")
  })

  it("manifest has 13 tools", () => {
    const toolNames = Object.keys(gitlabManifest.tools)
    expect(toolNames).toHaveLength(13)
  })

  it("every tool has params field", () => {
    for (const [_name, tool] of Object.entries(gitlabManifest.tools)) {
      expect((tool as { params?: unknown }).params).toBeDefined()
    }
  })

  it("allowedDomains contains exact 'gitlab.com' AND '*.gitlab.com'", () => {
    const domains = (gitlabManifest.connections.gitlab as { allowedDomains: string[] })
      .allowedDomains
    expect(domains).toContain("gitlab.com")
    expect(domains).toContain("*.gitlab.com")
  })

  it("every manifest handler name appears as a function declaration in handlers.ts", async () => {
    // handlers.ts uses script-mode (no `export`) for QuickJS compat — read the
    // source text and grep for function declarations.
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const handlersPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "handlers.ts")
    const src = await fs.readFile(handlersPath, "utf-8")

    for (const tool of Object.values(gitlabManifest.tools)) {
      const handlerName = (tool as { handler: string }).handler
      expect(src).toContain(`async function ${handlerName}(`)
    }
  })

  it("every function in handlers.ts maps to a manifest handler (no dead exports)", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const handlersPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "handlers.ts")
    const src = await fs.readFile(handlersPath, "utf-8")

    const manifestHandlers = new Set(
      Object.values(gitlabManifest.tools).map((t) => (t as { handler: string }).handler),
    )

    // Extract all `async function <name>(` declarations
    const fnMatches = [...src.matchAll(/async function (\w+)\(/g)]
    for (const match of fnMatches) {
      const fnName = match[1]
      expect(manifestHandlers.has(fnName)).toBe(true)
    }
  })
})

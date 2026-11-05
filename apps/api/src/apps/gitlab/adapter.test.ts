// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Unit tests for the GitLab knowledge-source adapter.
 * Injects a stub GitlabClient — no HTTP.
 */
import { describe, expect, it } from "bun:test"
import { createGitlabAdapter, redactSecrets } from "./adapter"
import type { GitlabClient, GitlabTreeEntry } from "./gitlab-rest"
import { GitlabHttpError } from "./gitlab-rest"

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

function makeStubClient(overrides: Partial<GitlabClient> = {}): GitlabClient {
  return {
    getCurrentUser: async () => ({ id: 1, username: "stub-user" }),
    getProject: async ({ projectId }) => ({
      id: Number(projectId),
      path_with_namespace: `acme/project-${projectId}`,
      web_url: `https://gitlab.com/acme/project-${projectId}`,
      default_branch: "main",
    }),
    listTree: async ({
      projectId: _pid,
      ref: _ref,
      path: _path = "",
      recursive: _rec = false,
    }) => ({
      items: [],
      nextCursor: undefined,
    }),
    getFile: async ({ projectId: _pid, path, ref: _ref }) => ({
      content: btoa("hello world"),
      blob_id: "blob123",
      last_commit_id: "commit456",
      file_name: path.split("/").pop() ?? path,
      file_path: path,
      size: 11,
    }),
    listProjects: async () => [],
    listCommits: async () => [],
    getCommit: async ({ projectId: _pid, sha }) => ({
      id: sha,
      short_id: sha.slice(0, 8),
      title: "test commit",
      message: "test commit",
      author_name: "Test",
      authored_date: "2024-01-01",
      committed_date: "2024-01-01",
      web_url: `https://gitlab.com`,
      parent_ids: [],
    }),
    listMergeRequests: async () => [],
    getMergeRequest: async ({ projectId: _pid, iid }) => ({
      iid,
      title: "test MR",
      description: null,
      state: "opened",
      target_branch: "main",
      source_branch: "feature",
      author: { username: "alice", name: "Alice" },
      assignees: [],
      milestone: null,
      labels: [],
      created_at: "2024-01-01",
      updated_at: "2024-01-01",
      merged_at: null,
      web_url: "https://gitlab.com",
    }),
    listIssues: async () => [],
    listMilestones: async () => [],
    listLabels: async () => [],
    listReleases: async () => [],
    listTags: async () => [],
    search: async () => [],
    ...overrides,
  }
}

const mockActor = {
  orgId: "org-1",
  userId: "user-1",
  scopes: ["knowledge:sources:read"],
  dimensionGrants: {},
}

// ---------------------------------------------------------------------------
// listFolder tests
// ---------------------------------------------------------------------------

describe("GitlabAdapter.listFolder", () => {
  it("maps mixed tree entries: tree→folder (no etag), blob→file (etag=id)", async () => {
    const entries: GitlabTreeEntry[] = [
      { id: "sha-dir", name: "subdir", type: "tree", path: "docs/subdir" },
      { id: "sha-file", name: "readme.md", type: "blob", path: "docs/readme.md" },
    ]
    const client = makeStubClient({
      listTree: async () => ({ items: entries }),
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.listFolder!({ folderRef: "123:main:docs" }, mockActor)

    expect(result.items).toHaveLength(2)

    const folder = result.items.find((i) => i.kind === "folder")
    expect(folder).toBeDefined()
    expect(folder!.name).toBe("subdir")
    expect(folder!.externalId).toBe("123:main:docs/subdir")
    expect(folder!.parentExternalId).toBe("123:main:docs")
    expect(folder!.etag).toBeUndefined() // no etag on folders

    const file = result.items.find((i) => i.kind === "file")
    expect(file).toBeDefined()
    expect(file!.name).toBe("readme.md")
    expect(file!.externalId).toBe("123:main:docs/readme.md")
    expect(file!.parentExternalId).toBe("123:main:docs")
    expect(file!.etag).toBe("sha-file") // etag = blob SHA
    expect(file!.mimeType).toBe("text/markdown")
  })

  it("maps .md → text/markdown, unknown ext → application/octet-stream", async () => {
    const entries: GitlabTreeEntry[] = [
      { id: "s1", name: "manual.md", type: "blob", path: "docs/manual.md" },
      { id: "s2", name: "binary.exe", type: "blob", path: "docs/binary.exe" },
      { id: "s3", name: "data.yaml", type: "blob", path: "docs/data.yaml" },
      { id: "s4", name: "config.json", type: "blob", path: "docs/config.json" },
    ]
    const client = makeStubClient({ listTree: async () => ({ items: entries }) })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.listFolder!({ folderRef: "123:main:docs" }, mockActor)

    const find = (name: string) => result.items.find((i) => i.name === name)
    expect(find("manual.md")!.mimeType).toBe("text/markdown")
    expect(find("binary.exe")!.mimeType).toBe("application/octet-stream")
    expect(find("data.yaml")!.mimeType).toBe("application/yaml")
    expect(find("config.json")!.mimeType).toBe("application/json")
  })

  it("recursion contract: folder externalId round-trips as folderRef → listTree called with correct path", async () => {
    // When the reconciler passes a folder's externalId as folderRef,
    // listFolder must call client.listTree with path=<subdir>, recursive=false
    let capturedPath: string | undefined
    const client = makeStubClient({
      listTree: async ({ path, recursive }) => {
        capturedPath = path
        expect(recursive).toBe(false)
        return { items: [] }
      },
    })
    const adapter = createGitlabAdapter({ client })
    // The folder externalId from a parent listing would be "123:main:docs/subdir"
    await adapter.listFolder!({ folderRef: "123:main:docs/subdir" }, mockActor)
    expect(capturedPath).toBe("docs/subdir")
  })

  it("throws on malformed folderRef", async () => {
    const client = makeStubClient()
    const adapter = createGitlabAdapter({ client })
    await expect(
      adapter.listFolder!({ folderRef: "bad-ref-no-colons" }, mockActor),
    ).rejects.toThrow(/Invalid GitLab folderRef/)
  })
})

// ---------------------------------------------------------------------------
// fetchRemoteContent tests
// ---------------------------------------------------------------------------

describe("GitlabAdapter.fetchRemoteContent", () => {
  it("base64-decodes content and builds immutable permalink", async () => {
    const client = makeStubClient({
      getProject: async () => ({
        id: 123,
        path_with_namespace: "acme/myrepo",
        web_url: "https://gitlab.com/acme/myrepo",
        default_branch: "main",
      }),
      getFile: async () => ({
        content: btoa("# Hello World"),
        blob_id: "blob-abc",
        last_commit_id: "commitXYZ",
        file_name: "readme.md",
        file_path: "docs/readme.md",
        size: 13,
      }),
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.fetchRemoteContent!(
      { sourceEntityId: "123:main:docs/readme.md" },
      mockActor,
    )

    expect(result.status).toBe("ok")
    expect(result.text).toBe("# Hello World")
    // URL must contain last_commit_id AND path_with_namespace
    expect(result.url).toContain("commitXYZ")
    expect(result.url).toContain("acme/myrepo")
    expect(result.title).toBe("readme.md")
  })

  it("redacts glpat-… secret from body", async () => {
    const secretBody = "Token: glpat-ABCDEFabcdef12345678\nsome content"
    const client = makeStubClient({
      getFile: async () => ({
        content: btoa(secretBody),
        blob_id: "b1",
        last_commit_id: "c1",
        file_name: "config.md",
        file_path: "config.md",
        size: secretBody.length,
      }),
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.fetchRemoteContent!(
      { sourceEntityId: "123:main:config.md" },
      mockActor,
    )

    expect(result.status).toBe("ok")
    expect(result.text).not.toContain("glpat-")
    expect(result.text).toContain("[REDACTED]")
  })

  it("redacts PEM private key from body", async () => {
    const pemBody = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
    const client = makeStubClient({
      getFile: async () => ({
        content: btoa(pemBody),
        blob_id: "b2",
        last_commit_id: "c2",
        file_name: "key.pem",
        file_path: "key.pem",
        size: pemBody.length,
      }),
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.fetchRemoteContent!(
      { sourceEntityId: "123:main:key.pem" },
      mockActor,
    )

    expect(result.status).toBe("ok")
    expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY")
    expect(result.text).toContain("[REDACTED]")
  })

  it("returns unavailable on 404", async () => {
    const client = makeStubClient({
      getFile: async () => {
        throw new GitlabHttpError(404, "Not found", "NOT_FOUND")
      },
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.fetchRemoteContent!(
      { sourceEntityId: "123:main:missing.md" },
      mockActor,
    )
    expect(result.status).toBe("unavailable")
  })

  it("uses non-immutable fallback URL when namespace unavailable", async () => {
    const client = makeStubClient({
      getProject: async () => {
        throw new GitlabHttpError(403, "Forbidden", "FORBIDDEN")
      },
      getFile: async () => ({
        content: btoa("content"),
        blob_id: "b3",
        last_commit_id: "c3",
        file_name: "doc.md",
        file_path: "doc.md",
        size: 7,
      }),
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.fetchRemoteContent!(
      { sourceEntityId: "999:main:doc.md" },
      mockActor,
    )
    expect(result.status).toBe("ok")
    expect(result.url).toContain("projects/999")
    expect(result.url).toContain("main")
  })
})

// ---------------------------------------------------------------------------
// searchRemote tests
// ---------------------------------------------------------------------------

describe("GitlabAdapter.searchRemote", () => {
  it("maps search hits to KnowledgeSearchHit[] with state=complete, valid triple + namespaced URL", async () => {
    const client = makeStubClient({
      // stub getProject resolves project_id 123 → "acme/project-123"
      search: async () => [
        {
          basename: "readme",
          data: "some content snippet",
          path: "docs/readme.md",
          filename: "readme.md",
          id: null,
          ref: "main",
          project_id: 123,
        },
      ],
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.searchRemote({ query: "hello", limit: 10 }, mockActor)

    expect(result.status.state).toBe("complete")
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].source).toBe("gitlab")
    expect(result.hits[0].title).toBe("docs/readme.md")
    expect(result.hits[0].canFetchContent).toBe(true)
    // sourceEntityId must be the valid `<projectId>:<branch>:<path>` triple so it
    // round-trips through fetchRemoteContent/parseFolderRef — NOT bare hit.path.
    expect(result.hits[0].sourceEntityId).toBe("123:main:docs/readme.md")
    // URL must use the resolved path_with_namespace in the namespace slot, with
    // the file path appearing only after `/-/blob/<ref>/` — never as the namespace.
    expect(result.hits[0].url).toBe(
      "https://gitlab.com/acme/project-123/-/blob/main/docs/readme.md",
    )
  })

  it("scopes blob search to the connected group when no projectId/groupId filter is given", async () => {
    let capturedGroupId: string | number | undefined
    let capturedProjectId: string | number | undefined
    const client = makeStubClient({
      search: async ({ groupId, projectId }) => {
        capturedGroupId = groupId
        capturedProjectId = projectId
        return []
      },
    })
    const adapter = createGitlabAdapter({
      client,
      resolveDefaultGroupId: async () => "acme",
    })
    await adapter.searchRemote({ query: "hello", limit: 10 }, mockActor)
    // The connected group is used; the global /search endpoint is never hit.
    expect(capturedGroupId).toBe("acme")
    expect(capturedProjectId).toBeUndefined()
  })

  it("an explicit projectId filter takes precedence over the default group", async () => {
    let capturedGroupId: string | number | undefined
    let capturedProjectId: string | number | undefined
    const client = makeStubClient({
      search: async ({ groupId, projectId }) => {
        capturedGroupId = groupId
        capturedProjectId = projectId
        return []
      },
    })
    const adapter = createGitlabAdapter({
      client,
      resolveDefaultGroupId: async () => "acme",
    })
    await adapter.searchRemote(
      { query: "hello", limit: 10, filters: { projectId: "777" } },
      mockActor,
    )
    expect(capturedProjectId).toBe("777")
    expect(capturedGroupId).toBeUndefined()
  })

  it("respects limit — truncates to input.limit hits", async () => {
    const manyHits = Array.from({ length: 20 }, (_, i) => ({
      basename: `file${i}`,
      data: "content",
      path: `docs/file${i}.md`,
      filename: `file${i}.md`,
      id: null,
      ref: "main",
      project_id: 123,
    }))
    const client = makeStubClient({ search: async () => manyHits })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.searchRemote({ query: "x", limit: 5 }, mockActor)

    expect(result.hits).toHaveLength(5)
  })

  it("returns skipped (not error) when blob search unavailable (400)", async () => {
    const client = makeStubClient({
      search: async () => {
        throw new GitlabHttpError(400, "scope not supported", undefined, "scope not supported")
      },
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.searchRemote({ query: "x", limit: 10 }, mockActor)

    expect(result.status.state).toBe("skipped")
    expect(result.status.retryable).toBe(false)
    expect(result.hits).toHaveLength(0)
  })

  it("returns rate-limited on 429", async () => {
    const client = makeStubClient({
      search: async () => {
        throw new GitlabHttpError(429, "Rate limited", "RATE_LIMITED")
      },
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.searchRemote({ query: "x", limit: 10 }, mockActor)

    expect(result.status.state).toBe("rate-limited")
    expect(result.status.retryable).toBe(true)
  })

  it("returns unauthorized on 401", async () => {
    const client = makeStubClient({
      search: async () => {
        throw new GitlabHttpError(401, "Unauthorized", "AUTH_REVOKED")
      },
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.searchRemote({ query: "x", limit: 10 }, mockActor)

    expect(result.status.state).toBe("unauthorized")
  })

  it("returns skipped when no connection (no connected account error)", async () => {
    const client = makeStubClient({
      search: async () => {
        throw new Error('No connected account for connection "gitlab"')
      },
    })
    const adapter = createGitlabAdapter({ client })
    const result = await adapter.searchRemote({ query: "x", limit: 10 }, mockActor)

    expect(result.status.state).toBe("skipped")
  })
})

// ---------------------------------------------------------------------------
// Secret redaction unit tests
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
  it("redacts GitLab PAT (glpat-)", () => {
    const text = "Token: glpat-ABCDEFabcdef12345678 in config"
    expect(redactSecrets(text)).toContain("[REDACTED]")
    expect(redactSecrets(text)).not.toContain("glpat-")
  })

  it("redacts AWS access key (AKIA)", () => {
    const text = "key=AKIAIOSFODNN7EXAMPLE"
    expect(redactSecrets(text)).toContain("[REDACTED]")
    expect(redactSecrets(text)).not.toContain("AKIA")
  })

  it("redacts PEM private key", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
    expect(redactSecrets(text)).toContain("[REDACTED]")
    expect(redactSecrets(text)).not.toContain("BEGIN RSA PRIVATE KEY")
  })

  it("does not modify clean text", () => {
    const text = "# Documentation\nThis is a normal markdown file with no secrets."
    expect(redactSecrets(text)).toBe(text)
  })
})

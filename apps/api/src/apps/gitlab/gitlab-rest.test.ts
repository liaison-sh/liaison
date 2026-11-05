// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Unit tests for GitlabClient (gitlab-rest.ts).
 * HTTP is mocked via the OutboundFetchTestAccess.setFetch seam.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { GitlabHttpError, makeGitlabFetchers } from "./gitlab-rest"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = "glpat-test-secret-token-12345"
const BASE = "https://gitlab.com/api/v4"

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function stubFetch(fn: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  OutboundFetchTestAccess.setFetch(fn as unknown as typeof fetch)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitlabClient", () => {
  afterEach(() => {
    OutboundFetchTestAccess.setFetch(null)
  })

  // -------------------------------------------------------------------------
  // listProjects — large-org payload + pagination
  // -------------------------------------------------------------------------

  describe("listProjects", () => {
    it("uses simple=true + include_subgroups + per_page=50 and aggregates all pages", async () => {
      const urls: string[] = []
      let call = 0
      stubFetch((url) => {
        urls.push(url.toString())
        call++
        if (call === 1) {
          return jsonResponse(
            [{ id: 1, path_with_namespace: "g/a", default_branch: "main" }],
            200,
            { "x-next-page": "2" },
          )
        }
        return jsonResponse([{ id: 2, path_with_namespace: "g/b", default_branch: "dev" }])
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const projects = await client.listProjects({ groupId: "g" })

      // lightweight payload + small page size so a 100+ repo org never times out
      expect(urls[0]).toContain("/groups/g/projects")
      expect(urls[0]).toContain("simple=true")
      expect(urls[0]).toContain("include_subgroups=true")
      expect(urls[0]).toContain("per_page=50")
      // all pages collected via x-next-page
      expect(urls[1]).toContain("page=2")
      expect(projects.map((p) => p.id)).toEqual([1, 2])
    })
  })

  // -------------------------------------------------------------------------
  // Auth header + path encoding
  // -------------------------------------------------------------------------

  describe("auth header + path encoding", () => {
    it("sends PRIVATE-TOKEN header with the exact token value", async () => {
      let capturedHeaders: Record<string, string> = {}
      stubFetch((_url, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {}
        return jsonResponse({
          id: 1,
          path_with_namespace: "acme/proj",
          web_url: "https://gitlab.com/acme/proj",
          default_branch: "main",
        })
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      await client.getProject({ projectId: 1 })

      expect(capturedHeaders["PRIVATE-TOKEN"]).toBe(TEST_TOKEN)
    })

    it("URL-encodes a file path with slashes and spaces", async () => {
      let capturedUrl = ""
      stubFetch((url) => {
        capturedUrl = url.toString()
        return jsonResponse({
          content: btoa("hello"),
          blob_id: "abc",
          last_commit_id: "def",
          file_name: "my file.md",
          file_path: "docs/my file.md",
          size: 5,
        })
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      await client.getFile({ projectId: 1, path: "docs/my file.md", ref: "main" })

      // "docs/my file.md" should be URL-encoded as "docs%2Fmy%20file.md"
      expect(capturedUrl).toContain("docs%2Fmy%20file.md")
    })
  })

  // -------------------------------------------------------------------------
  // Pagination — keyset (listTree)
  // -------------------------------------------------------------------------

  describe("keyset pagination (listTree)", () => {
    it("follows Link rel=next and stops when absent", async () => {
      const page1 = [{ id: "sha1", name: "a.md", type: "blob" as const, path: "docs/a.md" }]
      const page2 = [{ id: "sha2", name: "b.md", type: "blob" as const, path: "docs/b.md" }]

      let callCount = 0
      stubFetch((_url) => {
        callCount++
        if (callCount === 1) {
          // First page — return Link: next header
          return new Response(JSON.stringify(page1), {
            status: 200,
            headers: {
              "content-type": "application/json",
              link: `<${BASE}/projects/1/repository/tree?page=2>; rel="next"`,
            },
          })
        }
        // Second page — no next link
        return jsonResponse(page2)
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      // First call gets page 1 + nextCursor
      const result1 = await client.listTree({ projectId: 1, ref: "main", path: "docs" })
      expect(result1.items).toHaveLength(1)
      expect(result1.nextCursor).toBeDefined()

      // Following the cursor returns page 2
      stubFetch((url) => {
        expect(url.toString()).toContain("page=2")
        return jsonResponse(page2)
      })
      const result2 = await client.listTree({
        projectId: 1,
        ref: "main",
        path: "docs",
        cursor: result1.nextCursor,
      })
      expect(result2.items).toHaveLength(1)
      expect(result2.nextCursor).toBeUndefined()
    })

    it("does not depend on x-total header (keyset path)", async () => {
      stubFetch(() => {
        // No x-total header at all
        return new Response(
          JSON.stringify([{ id: "sha1", name: "a.md", type: "blob", path: "a.md" }]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
            // x-total intentionally absent
          },
        )
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const result = await client.listTree({ projectId: 1, ref: "main" })
      expect(result.items).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Pagination — offset (listCommits)
  // -------------------------------------------------------------------------

  describe("offset pagination (listCommits)", () => {
    it("follows x-next-page and stops when absent", async () => {
      const commit1 = {
        id: "abc",
        short_id: "abc",
        title: "c1",
        message: "c1",
        author_name: "A",
        authored_date: "2024-01-01",
        committed_date: "2024-01-01",
        web_url: "https://gitlab.com",
        parent_ids: [],
      }
      const commit2 = {
        id: "def",
        short_id: "def",
        title: "c2",
        message: "c2",
        author_name: "B",
        authored_date: "2024-01-02",
        committed_date: "2024-01-02",
        web_url: "https://gitlab.com",
        parent_ids: [],
      }

      let callCount = 0
      stubFetch((_url, _init) => {
        callCount++
        if (callCount === 1) {
          return new Response(JSON.stringify([commit1]), {
            status: 200,
            headers: { "content-type": "application/json", "x-next-page": "2" },
          })
        }
        return new Response(JSON.stringify([commit2]), {
          status: 200,
          headers: { "content-type": "application/json", "x-next-page": "" },
        })
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const commits = await client.listCommits({ projectId: 1 })
      expect(commits).toHaveLength(2)
      expect(commits[0].id).toBe("abc")
      expect(commits[1].id).toBe("def")
      expect(callCount).toBe(2)
    })

    it("does not depend on x-total header", async () => {
      stubFetch(() => {
        return new Response(
          JSON.stringify([
            {
              id: "x",
              short_id: "x",
              title: "t",
              message: "m",
              author_name: "A",
              authored_date: "2024-01-01",
              committed_date: "2024-01-01",
              web_url: "https://gitlab.com",
              parent_ids: [],
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
            // x-total and x-next-page intentionally absent
          },
        )
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const commits = await client.listCommits({ projectId: 1 })
      expect(commits).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Commit / MR diff endpoints (dedicated paths, not query params)
  // -------------------------------------------------------------------------

  describe("getCommit withDiff", () => {
    it("fetches the dedicated /diff endpoint and attaches diffs (no with_diffs query param)", async () => {
      const commitMeta = {
        id: "sha1",
        short_id: "sha1",
        title: "t",
        message: "m",
        author_name: "A",
        authored_date: "2024-01-01",
        committed_date: "2024-01-01",
        web_url: "https://gitlab.com",
        parent_ids: [],
      }
      const diffEntries = [{ old_path: "a.txt", new_path: "a.txt", diff: "@@ -1 +1 @@" }]

      const calledUrls: string[] = []
      stubFetch((url) => {
        const u = url.toString()
        calledUrls.push(u)
        if (u.endsWith("/diff")) return jsonResponse(diffEntries)
        return jsonResponse(commitMeta)
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const commit = await client.getCommit({ projectId: 1, sha: "sha1", withDiff: true })

      // The base commit call must NOT carry with_diffs; the diff comes from /diff.
      expect(calledUrls.some((u) => u.includes("with_diffs"))).toBe(false)
      expect(calledUrls.some((u) => u.endsWith("/repository/commits/sha1/diff"))).toBe(true)
      expect(commit.diffs).toEqual(diffEntries)
    })

    it("does NOT call /diff when withDiff is false", async () => {
      const calledUrls: string[] = []
      stubFetch((url) => {
        calledUrls.push(url.toString())
        return jsonResponse({
          id: "sha1",
          short_id: "sha1",
          title: "t",
          message: "m",
          author_name: "A",
          authored_date: "2024-01-01",
          committed_date: "2024-01-01",
          web_url: "https://gitlab.com",
          parent_ids: [],
        })
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const commit = await client.getCommit({ projectId: 1, sha: "sha1" })
      expect(calledUrls.some((u) => u.endsWith("/diff"))).toBe(false)
      expect(commit.diffs).toBeUndefined()
    })
  })

  describe("getMergeRequest withChanges", () => {
    it("fetches the dedicated /diffs endpoint and attaches changes (no with_changes query param)", async () => {
      const mrMeta = {
        iid: 5,
        title: "t",
        description: null,
        state: "opened",
        target_branch: "main",
        source_branch: "feat",
        author: { username: "a", name: "A" },
        assignees: [],
        milestone: null,
        labels: [],
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
        merged_at: null,
        web_url: "https://gitlab.com",
      }
      const diffEntries = [{ old_path: "x.md", new_path: "x.md", diff: "@@ -1 +1 @@" }]

      const calledUrls: string[] = []
      stubFetch((url) => {
        const u = url.toString()
        calledUrls.push(u)
        if (u.includes("/diffs")) return jsonResponse(diffEntries, 200, { "x-next-page": "" })
        return jsonResponse(mrMeta)
      })

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const mr = await client.getMergeRequest({ projectId: 1, iid: 5, withChanges: true })

      expect(calledUrls.some((u) => u.includes("with_changes"))).toBe(false)
      expect(calledUrls.some((u) => u.includes("/merge_requests/5/diffs"))).toBe(true)
      expect(mr.changes).toEqual(diffEntries)
    })
  })

  // -------------------------------------------------------------------------
  // HTTP error mapping
  // -------------------------------------------------------------------------

  describe("HTTP error mapping", () => {
    it("maps 401 → AUTH_REVOKED", async () => {
      stubFetch(() => jsonResponse({ message: "Unauthorized" }, 401))

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const err = await client.getProject({ projectId: 1 }).catch((e) => e)
      expect(err).toBeInstanceOf(GitlabHttpError)
      expect((err as GitlabHttpError).status).toBe(401)
      expect((err as GitlabHttpError).code).toBe("AUTH_REVOKED")
    })

    it("maps 403 → FORBIDDEN (distinct from 401)", async () => {
      stubFetch(() => jsonResponse({ message: "Forbidden" }, 403))

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const err = await client.getProject({ projectId: 1 }).catch((e) => e)
      expect(err).toBeInstanceOf(GitlabHttpError)
      expect((err as GitlabHttpError).status).toBe(403)
      expect((err as GitlabHttpError).code).toBe("FORBIDDEN")
      // Must be different from 401 code
      expect((err as GitlabHttpError).code).not.toBe("AUTH_REVOKED")
    })

    it("maps 404 → NOT_FOUND", async () => {
      stubFetch(() => jsonResponse({ message: "Not found" }, 404))

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const err = await client.getProject({ projectId: 1 }).catch((e) => e)
      expect(err).toBeInstanceOf(GitlabHttpError)
      expect((err as GitlabHttpError).status).toBe(404)
      expect((err as GitlabHttpError).code).toBe("NOT_FOUND")
    })

    it("maps 429 → RATE_LIMITED with retryAfter", async () => {
      stubFetch(
        () =>
          new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
            status: 429,
            headers: { "content-type": "application/json", "Retry-After": "30" },
          }),
      )

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const err = await client.getProject({ projectId: 1 }).catch((e) => e)
      expect(err).toBeInstanceOf(GitlabHttpError)
      expect((err as GitlabHttpError).status).toBe(429)
      expect((err as GitlabHttpError).code).toBe("RATE_LIMITED")
      expect((err as GitlabHttpError).retryAfter).toBe(30)
    })

    it("surfaces gitlabMessage from 500 response body", async () => {
      stubFetch(() => jsonResponse({ message: "Internal server error happened" }, 500))

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const err = await client.getProject({ projectId: 1 }).catch((e) => e)
      expect(err).toBeInstanceOf(GitlabHttpError)
      expect((err as GitlabHttpError).status).toBe(500)
      expect((err as GitlabHttpError).gitlabMessage).toBe("Internal server error happened")
    })
  })

  // -------------------------------------------------------------------------
  // Host pinning
  // -------------------------------------------------------------------------

  describe("host pinning", () => {
    it("rejects a Link rel=next redirect to an off-gitlab host via onHopValidate", async () => {
      // Serve a first page that redirects (via Link header) to an evil host.
      // onHopValidate must reject the next URL from the Link header before following it.
      const page1 = [{ id: "sha1", name: "a.md", type: "blob" as const, path: "docs/a.md" }]
      stubFetch(
        () =>
          new Response(JSON.stringify(page1), {
            status: 200,
            headers: {
              "content-type": "application/json",
              // Forge a Link rel=next pointing at a non-gitlab host
              link: `<https://evil.example.com/steal?page=2>; rel="next"`,
            },
          }),
      )

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const result1 = await client.listTree({ projectId: 1, ref: "main", path: "docs" })
      // The first page succeeds
      expect(result1.items).toHaveLength(1)
      // The nextCursor points to the evil URL
      expect(result1.nextCursor).toBeDefined()
      expect(result1.nextCursor).toContain("evil.example.com")

      // Now follow the cursor — onHopValidate must reject it
      const err = await client
        .listTree({ projectId: 1, ref: "main", path: "docs", cursor: result1.nextCursor })
        .catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/gitlab\.com/)
    })
  })

  // -------------------------------------------------------------------------
  // No token leak
  // -------------------------------------------------------------------------

  describe("no token leak", () => {
    it("GitlabHttpError message and gitlabMessage contain no token substring", async () => {
      const secretToken = "glpat-super-secret-token-abc123"
      stubFetch(() => jsonResponse({ message: "some error" }, 401))

      const client = makeGitlabFetchers(async () => secretToken)
      const err = (await client.getProject({ projectId: 1 }).catch((e) => e)) as GitlabHttpError

      expect(err.message).not.toContain(secretToken)
      if (err.gitlabMessage) {
        expect(err.gitlabMessage).not.toContain(secretToken)
      }
      // The error itself shouldn't have token in serialized form
      const serialized = JSON.stringify(err)
      expect(serialized).not.toContain(secretToken)
    })
  })

  // -------------------------------------------------------------------------
  // Size cap
  // -------------------------------------------------------------------------

  describe("size cap", () => {
    it("throws a 413 GitlabHttpError on an oversized success body (cap fires, no OOM)", async () => {
      // A VALID-JSON body larger than the 10 MB cap. With the success-path read
      // routed through readBodyWithSizeCap, the cap must fire BEFORE JSON.parse —
      // so the error is the typed 413 cap error, not an incidental parse error.
      const bigBody = JSON.stringify({ blob: "x".repeat(11 * 1024 * 1024) })
      stubFetch(
        () =>
          new Response(bigBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      )

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const err = await client.getProject({ projectId: 1 }).catch((e) => e)
      expect(err).toBeInstanceOf(GitlabHttpError)
      expect((err as GitlabHttpError).status).toBe(413)
      expect((err as GitlabHttpError).message).toMatch(/cap/i)
    })

    it("getFile (the large-blob hot path) also enforces the cap", async () => {
      const bigBody = JSON.stringify({ content: "x".repeat(11 * 1024 * 1024) })
      stubFetch(
        () =>
          new Response(bigBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      )

      const client = makeGitlabFetchers(async () => TEST_TOKEN)
      const err = await client
        .getFile({ projectId: 1, path: "big.bin", ref: "main" })
        .catch((e) => e)
      expect(err).toBeInstanceOf(GitlabHttpError)
      expect((err as GitlabHttpError).status).toBe(413)
    })
  })
})

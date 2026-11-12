// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The GitLab app over a fake ctx (test-ctx.ts): the tools' answers and
// refusals, the credential going through ctx.fetch auth only, the knowledge
// source's pages, cursor and identities, provisioning verify, the manifest.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { base64Bytes, redactSecrets, utf8Text } from "./client"
import * as handlers from "./handlers"
import { FILES_PER_RUN, parseFolderRef, syncGitlabFolder } from "./knowledge"
import { verifyGitlab } from "./provisioning"
import { asCtx, fakeCtx, fileAnswer, json } from "./test-ctx"
import {
  gitlabGetCommit,
  gitlabListIssues,
  gitlabListProjects,
  gitlabReadFile,
  gitlabSearch,
} from "./tools"

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
const AUTH = { connection: "gitlab", scheme: "bearer", fields: ["token"] }

describe("manifest", () => {
  it("is version 1.1.0, newer than the last in-tree release (1.0.2)", () => {
    expect(MANIFEST.version).toBe("1.1.0")
  })

  it("exports every handler it names", () => {
    const names = [
      ...Object.values(MANIFEST.tools as Record<string, { handler: string }>).map((t) => t.handler),
      ...Object.values(MANIFEST.knowledgeSources as Record<string, { handler: string }>).map(
        (k) => k.handler,
      ),
      MANIFEST.provisioning.handler,
      MANIFEST.provisioning.verify,
    ]
    expect(names.length).toBe(16)
    for (const name of names) expect(typeof (handlers as Record<string, unknown>)[name]).toBe("function")
  })

  it("never lets app code read the token: the group is the only readable field", () => {
    const fields = MANIFEST.connections.gitlab.credentialFields as Array<{
      name: string
      type: string
      readable?: boolean
    }>
    expect(fields.filter((f) => f.readable).map((f) => f.name)).toEqual(["group"])
    expect(fields.find((f) => f.name === "token")?.type).toBe("password")
    expect(MANIFEST.connections.gitlab.limits).toEqual({ concurrency: 4, perSecond: 10, burst: 20 })
  })
})

describe("tools", () => {
  it("lists the connected group's projects, the token added by the host", async () => {
    const ctx = fakeCtx({
      routes: {
        "/groups/acme/projects?per_page=50&include_subgroups=true&simple=true": json([
          { id: 7, path_with_namespace: "acme/manuals", web_url: "https://gitlab.com/acme/manuals", default_branch: "main" },
        ]),
      },
    })
    expect(await gitlabListProjects({}, asCtx(ctx))).toEqual({
      projects: [{ id: 7, path: "acme/manuals", url: "https://gitlab.com/acme/manuals", defaultBranch: "main" }],
    })
    expect(ctx.calls.map((c) => c.auth)).toEqual([AUTH])
  })

  it("answers not_connected without any call when there is no connection", async () => {
    for (const settings of [
      "throws" as const,
      { values: {}, missing: ["token", "group"] },
    ]) {
      const ctx = fakeCtx({ settings })
      expect(await gitlabListProjects({}, asCtx(ctx))).toEqual({
        error: { code: "not_connected", message: "No GitLab connection for this organization." },
      })
      expect(ctx.calls).toEqual([])
    }
  })

  it("keeps GitLab's typed refusals", async () => {
    const ctx = fakeCtx({
      routes: { "/projects/9/issues?per_page=100": json({ message: "401 Unauthorized" }, {}, 401) },
    })
    expect(await gitlabListIssues({ project: "9" }, asCtx(ctx))).toEqual({
      error: { code: "AUTH_REVOKED", message: "401 Unauthorized" },
    })
  })

  it("follows x-next-page and says truncated past its page cap", async () => {
    const page = (n: number) => json([{ iid: n, title: `#${n}`, author: { username: "a" }, assignees: [] }], { "x-next-page": String(n + 1) })
    const routes: Record<string, ReturnType<typeof json>> = { "/projects/9/issues?per_page=100": page(1) }
    for (let n = 2; n <= 11; n++) routes[`/projects/9/issues?per_page=100&page=${n}`] = page(n)
    const out = (await gitlabListIssues({ project: "9" }, asCtx(fakeCtx({ routes })))) as {
      issues: unknown[]
      truncated?: boolean
    }
    expect(out.issues.length).toBe(10)
    expect(out.truncated).toBe(true)
  })

  it("reads a file as UTF-8, redacts secrets, cuts the line range, links the commit", async () => {
    const text = "line 1 é\nkey glpat-abcdefghijklmnopqrstuvwx\nline 3\n"
    const ctx = fakeCtx({
      routes: {
        "/projects/acme%2Fmanuals/repository/files/docs%2Fa.md?ref=main": fileAnswer(text, "b1", "c1"),
        "/projects/acme%2Fmanuals": json({ path_with_namespace: "acme/manuals" }),
      },
    })
    expect(
      await gitlabReadFile(
        { project: "acme/manuals", path: "docs/a.md", ref: "main", startLine: 1, endLine: 2 },
        asCtx(ctx),
      ),
    ).toEqual({
      content: "line 1 é\nkey [REDACTED]",
      url: "https://gitlab.com/acme/manuals/-/blob/c1/docs/a.md",
      ref: "c1",
    })
  })

  it("gets a commit with its diff from the diff endpoint", async () => {
    const ctx = fakeCtx({
      routes: {
        "/projects/9/repository/commits/abc": json({ id: "abc", short_id: "ab", title: "t", message: "m", author_name: "x", committed_date: "d", web_url: "u", parent_ids: [] }),
        "/projects/9/repository/commits/abc/diff?per_page=100": json([{ old_path: "a", new_path: "a", diff: "+1" }]),
      },
    })
    const out = (await gitlabGetCommit({ project: "9", sha: "abc", withDiff: true }, asCtx(ctx))) as {
      commit: { diffs: unknown[] }
    }
    expect(out.commit.diffs).toEqual([{ old_path: "a", new_path: "a", diff: "+1" }])
  })

  it("searches the connected group unless a project is named", async () => {
    const ctx = fakeCtx({
      routes: {
        "/groups/acme/search?scope=issues&search=crash&per_page=100": json([
          { iid: 3, title: "crash", state: "opened", author: { username: "a" }, assignees: [], labels: [] },
        ]),
      },
    })
    const out = (await gitlabSearch({ scope: "issues", query: "crash" }, asCtx(ctx))) as {
      results: Array<{ iid: number; title: string }>
    }
    expect(out.results[0]).toMatchObject({ iid: 3, title: "crash" })
  })
})

describe("text helpers", () => {
  it("decodes base64 UTF-8 without Buffer or atob", () => {
    const text = "Ça marche — 日本 🎉"
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    expect(utf8Text(base64Bytes(b64))).toBe(text)
    expect(utf8Text([0xff, 0x41])).toBe("�A")
  })

  it("redacts high-confidence secrets only", () => {
    expect(redactSecrets("AKIAABCDEFGHIJKLMNOP and plain text")).toBe("[REDACTED] and plain text")
  })
})

describe("knowledge source `folder`", () => {
  const TREE =
    "/projects/7/repository/tree?ref=HEAD1&recursive=true&per_page=100&pagination=keyset&path=docs"
  const NEXT = "https://gitlab.com/api/v4/projects/7/repository/tree?page_token=p2"
  const input = (cursor: unknown) => ({
    sourceId: "s1",
    kind: "folder",
    config: { ref: "7:main:docs" },
    cursor: cursor as never,
  })
  function routes(extraFiles = 0) {
    const page1 = [
      { id: "t1", name: "guides", type: "tree", path: "docs/guides" },
      { id: "f1", name: "intro.md", type: "blob", path: "docs/intro.md" },
      { id: "f2", name: "setup.md", type: "blob", path: "docs/guides/setup.md" },
      { id: "f3", name: "logo.png", type: "blob", path: "docs/img/logo.png" },
    ]
    for (let i = 0; i < extraFiles; i++) {
      page1.push({ id: `x${i}`, name: `n${i}.txt`, type: "blob", path: `docs/notes/n${i}.txt` })
    }
    const r: Record<string, ReturnType<typeof json>> = {
      "/projects/7/repository/branches/main": json({ commit: { id: "HEAD1" } }),
      "/projects/7": json({ path_with_namespace: "acme/manuals" }),
      [TREE]: json(page1, { link: `<${NEXT}>; rel="next"` }),
      [NEXT]: json([{ id: "f4", name: "faq.yaml", type: "blob", path: "docs/guides/deep/faq.yaml" }]),
    }
    for (const e of [...page1, { path: "docs/guides/deep/faq.yaml", id: "f4" }]) {
      r[`/projects/7/repository/files/${encodeURIComponent(e.path)}?ref=HEAD1`] = fileAnswer(
        `# ${e.path}`,
        `blob-${e.id}`,
        "C9",
      )
    }
    return r
  }

  it("parses a folder ref; an empty path is the whole branch", () => {
    expect(parseFolderRef("acme/manuals:main:")).toEqual({ project: "acme/manuals", branch: "main", path: "" })
    expect(parseFolderRef("7:release/1.0:docs/")).toEqual({ project: "7", branch: "release/1.0", path: "docs" })
    expect(() => parseFolderRef("7:main")).toThrow(/expected/)
  })

  it("syncs a pass page by page with the connector's own identities and folders", async () => {
    const ctx = fakeCtx({ routes: routes() })
    const first = await syncGitlabFolder(input(null), asCtx(ctx))
    expect(first.done).toBe(false)
    expect(first.documents?.upsert).toEqual([
      {
        externalId: "7:main:docs/intro.md",
        title: "intro.md",
        body: "# docs/intro.md",
        mimeType: "text/markdown",
        rev: "blob-f1",
        url: "https://gitlab.com/acme/manuals/-/blob/C9/docs/intro.md",
      },
      {
        externalId: "7:main:docs/guides/setup.md",
        title: "setup.md",
        body: "# docs/guides/setup.md",
        mimeType: "text/markdown",
        rev: "blob-f2",
        url: "https://gitlab.com/acme/manuals/-/blob/C9/docs/guides/setup.md",
        folderId: "7:main:docs/guides",
      },
    ])
    // A folder holding only a binary file is kept too; the png is not read.
    expect(first.folders?.upsert).toEqual([
      { externalId: "7:main:docs/guides", name: "guides", parentExternalId: null },
      { externalId: "7:main:docs/img", name: "img", parentExternalId: null },
    ])
    expect(ctx.calls.some((c) => c.url.includes("logo.png"))).toBe(false)
    expect(first.nextCursor).toEqual({
      head: "HEAD1",
      pass: { namespace: "acme/manuals", page: NEXT, done: 0 },
    })

    const last = await syncGitlabFolder(input(first.nextCursor), asCtx(ctx))
    expect(last).toMatchObject({ done: true, prune: true, nextCursor: { head: "HEAD1" } })
    expect(last.documents?.upsert?.[0]).toMatchObject({
      externalId: "7:main:docs/guides/deep/faq.yaml",
      mimeType: "application/yaml",
      folderId: "7:main:docs/guides/deep",
    })
    expect(last.folders?.upsert).toEqual([
      { externalId: "7:main:docs/guides", name: "guides", parentExternalId: null },
      { externalId: "7:main:docs/guides/deep", name: "deep", parentExternalId: "7:main:docs/guides" },
    ])
    for (const c of ctx.calls) expect(c.auth).toEqual(AUTH)
  })

  it(`reads at most ${FILES_PER_RUN} files a run and resumes inside the page`, async () => {
    const ctx = fakeCtx({ routes: routes(FILES_PER_RUN + 5) })
    const first = await syncGitlabFolder(input(null), asCtx(ctx))
    expect(first.documents?.upsert?.length).toBe(FILES_PER_RUN)
    expect(first.done).toBe(false)
    const cursor = first.nextCursor as { pass: { page: string | null; done: number } }
    expect(cursor.pass.page).toBeNull()
    const second = await syncGitlabFolder(input(first.nextCursor), asCtx(ctx))
    // 2 + 30 text files on page 1: 25 then 7, each read once.
    expect(second.documents?.upsert?.length).toBe(7)
    const ids = [...(first.documents?.upsert ?? []), ...(second.documents?.upsert ?? [])].map(
      (d) => d.externalId,
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("ends a pass at once, without pruning, while the branch has not moved", async () => {
    const ctx = fakeCtx({ routes: routes() })
    const out = await syncGitlabFolder(input({ head: "HEAD1" }), asCtx(ctx))
    expect(out).toEqual({ done: true, nextCursor: { head: "HEAD1" } })
    expect(ctx.calls.map((c) => c.url)).toEqual([
      "https://gitlab.com/api/v4/projects/7/repository/branches/main",
    ])
  })

  it("skips a file deleted since the listing and fails the page on any other error", async () => {
    const r = routes()
    r["/projects/7/repository/files/docs%2Fintro.md?ref=HEAD1"] = json({ message: "404 File Not Found" }, {}, 404)
    const out = await syncGitlabFolder(input(null), asCtx(fakeCtx({ routes: r })))
    expect(out.documents?.upsert?.map((d) => d.externalId)).toEqual(["7:main:docs/guides/setup.md"])
    r["/projects/7/repository/files/docs%2Fintro.md?ref=HEAD1"] = json({ message: "boom" }, {}, 500)
    await expect(syncGitlabFolder(input(null), asCtx(fakeCtx({ routes: r })))).rejects.toThrow(
      "GitLab HTTP 500",
    )
  })
})

describe("provisioning verify", () => {
  it("passes with the token owner and the group, through the connection's credential", async () => {
    const ctx = fakeCtx({
      routes: { "/user": json({ username: "reader" }), "/groups/acme?with_projects=false": json({ full_path: "acme" }) },
    })
    expect(await verifyGitlab({}, asCtx(ctx))).toEqual({ ok: true, problems: [], identity: "reader @ acme" })
    expect(ctx.calls.map((c) => c.auth)).toEqual([AUTH, AUTH])
  })

  it("fails with the typed reason", async () => {
    const ctx = fakeCtx({ routes: { "/user": json({ message: "401 Unauthorized" }, {}, 401) } })
    expect(await verifyGitlab({}, asCtx(ctx))).toEqual({
      ok: false,
      problems: ["AUTH_REVOKED: 401 Unauthorized"],
    })
    expect(await verifyGitlab({}, asCtx(fakeCtx({ settings: "throws" })))).toMatchObject({
      ok: false,
      problems: ["not_connected: No GitLab connection for this organization."],
    })
  })
})

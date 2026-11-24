// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Page history routes and the autosave PATCH, through the HTTP API with real tokens.
 *
 * - History is the edit right's: a viewer gets the same 404 as an unknown id on every
 *   version route, with no title in the answer (edge 12).
 * - A stored page link with its title (`@[Title](knowledge:document:id)`, as agents
 *   wrote them) leaves the server without the title (K-R18).
 * - Unapplied texts: one row per session and base, never one session over another's.
 * - A restore is a new version; a verified page restored to another text needs review.
 * - Autosave: the session comes from the query only; its saves coalesce.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { sql } from "drizzle-orm"
import { app } from "~/app"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(120_000)

let orgId: string
let editor: minimal.Session
let viewer: minimal.Session

const SCOPES = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
]

beforeAll(async () => {
  await acquireTestLock()
  initializedOrgRuntimes.clear()
  orgId = (await createTestOrg()).id
  const e = await minimal.person(orgId, { name: "Editor" })
  const v = await minimal.person(orgId, { name: "Viewer" })
  for (const s of SCOPES) {
    await minimal.grantScope(e.id, s)
    await minimal.grantScope(v.id, s)
  }
  editor = await minimal.sessionOf(e)
  viewer = await minimal.sessionOf(v)
})
afterAll(releaseTestLock)

async function call(
  who: minimal.Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: { data?: unknown } }> {
  const res = await app.request(`/api/knowledge${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.bearer}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, text, json: text ? JSON.parse(text) : {} }
}

interface Doc {
  id: string
  revision: number
  title: string
  body: string
  reviewStatus: string
}

async function page(input: Record<string, unknown> = {}): Promise<Doc> {
  const res = await call(editor, "POST", "/documents", {
    title: "Handbook",
    body: "start",
    documentScope: "organization",
    orgAccess: "viewer",
    ...input,
  })
  expect(res.status).toBe(201)
  return res.json.data as Doc
}

async function current(id: string): Promise<Doc> {
  return (await call(editor, "GET", `/documents/${id}`)).json.data as Doc
}

async function patch(id: string, body: string, query = ""): Promise<Doc> {
  const doc = await current(id)
  const res = await call(editor, "PATCH", `/documents/${id}${query}`, {
    revision: doc.revision,
    body,
  })
  expect(res.status).toBe(200)
  return res.json.data as Doc
}

async function rows(id: string) {
  return extractRows<{ kind: string; body: string; session_id: string | null }>(
    await withPrivilegedDb(orgId, "test-rows", (tx) =>
      tx.execute(sql`
        SELECT kind, body, session_id::text AS session_id FROM ${knowledgeRel("document_versions")}
         WHERE document_id = ${id}::uuid ORDER BY created_at, id`),
    ),
  )
}

describe("version routes", () => {
  it("an editor lists, reads and restores; a viewer gets 404 everywhere and no title", async () => {
    const doc = await page({ title: "Secret plan title" })
    await patch(doc.id, "second")
    const list = await call(editor, "GET", `/documents/${doc.id}/versions`)
    expect(list.status).toBe(200)
    const items = list.json.data as { id: string; kind: string; title: string }[]
    expect(items.map((v) => v.kind)).toEqual(["edit", "baseline"])
    expect(items[0]).not.toHaveProperty("body")
    const baseline = items[1]?.id ?? ""
    const one = await call(editor, "GET", `/documents/${doc.id}/versions/${baseline}`)
    expect((one.json.data as { body: string }).body).toBe("start")

    const unknownId = crypto.randomUUID()
    const unknown = await call(viewer, "GET", `/documents/${unknownId}/versions`)
    for (const [method, path, body] of [
      ["GET", `/documents/${doc.id}/versions`, undefined],
      ["GET", `/documents/${doc.id}/versions/${baseline}`, undefined],
      ["POST", `/documents/${doc.id}/versions/${baseline}/restore`, { revision: 1 }],
      ["POST", `/documents/${doc.id}/versions`, { title: "x", body: "x", baseRevision: 1 }],
    ] as const) {
      const res = await call(viewer, method, path, body)
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
      expect(res.text).not.toContain("Secret plan")
      expect(res.text).not.toContain("start")
    }
    expect(unknown.status).toBe(404)
    // The viewer still reads the page itself.
    expect((await call(viewer, "GET", `/documents/${doc.id}`)).status).toBe(200)
  })

  it("a stored link title never leaves the server, in the list or a version", async () => {
    const doc = await page()
    const target = crypto.randomUUID()
    await patch(doc.id, "other") // a baseline and an edit, rewritten below as K2a's rows may be
    await withPrivilegedDb(orgId, "test-seed-raw", (tx) =>
      tx.execute(sql`
        UPDATE ${knowledgeRel("document_versions")} v
           SET title = ${`About @[Secret](knowledge:document:${target})`},
               body = ${`See @[Secret](knowledge:document:${target}) and [Secret too](knowledge:document:${target}).`}
         WHERE v.document_id = ${doc.id}::uuid`),
    )
    const list = await call(editor, "GET", `/documents/${doc.id}/versions`)
    expect(list.text).not.toContain("Secret")
    for (const v of list.json.data as { id: string }[]) {
      const one = await call(editor, "GET", `/documents/${doc.id}/versions/${v.id}`)
      expect(one.text).not.toContain("Secret")
      expect((one.json.data as { body: string }).body).toBe(
        `See [](knowledge:document:${target}) and [](knowledge:document:${target}).`,
      )
    }
  })

  it("a restore is a new version and asks for a review of a verified page", async () => {
    const doc = await page({ verifyNow: true })
    await patch(doc.id, "changed")
    await call(editor, "POST", `/documents/${doc.id}/verify`, {
      revision: (await current(doc.id)).revision,
    })
    expect((await current(doc.id)).reviewStatus).toBe("verified")
    const items = (await call(editor, "GET", `/documents/${doc.id}/versions`)).json.data as {
      id: string
      kind: string
    }[]
    const baseline = items.find((v) => v.kind === "baseline")?.id ?? ""
    const res = await call(editor, "POST", `/documents/${doc.id}/versions/${baseline}/restore`, {
      revision: (await current(doc.id)).revision,
    })
    expect(res.status).toBe(200)
    const after = await current(doc.id)
    expect(after.body).toBe("start")
    expect(after.reviewStatus).toBe("needs_review")
    expect((await rows(doc.id)).map((r) => r.kind)).toEqual(["baseline", "edit", "restore"])
  })

  it("a restore at an old revision is a conflict", async () => {
    const doc = await page()
    await patch(doc.id, "two")
    const items = (await call(editor, "GET", `/documents/${doc.id}/versions`)).json.data as {
      id: string
    }[]
    const res = await call(
      editor,
      "POST",
      `/documents/${doc.id}/versions/${items[0]?.id}/restore`,
      {
        revision: doc.revision,
      },
    )
    expect(res.status).toBe(409)
  })

  it("two sessions keep two unapplied texts on one base; one session, one", async () => {
    const doc = await page()
    const a = crypto.randomUUID()
    const b = crypto.randomUUID()
    const post = (session: string, body: string) =>
      call(editor, "POST", `/documents/${doc.id}/versions`, {
        title: "Handbook",
        body,
        baseRevision: doc.revision,
        session,
      })
    expect((await post(a, "tab A 1")).status).toBe(201)
    expect((await post(b, "tab B")).status).toBe(201)
    expect((await post(a, "tab A 2")).status).toBe(201)
    const unapplied = (await rows(doc.id)).filter((r) => r.kind === "unapplied")
    expect(unapplied.map((r) => [r.session_id, r.body])).toEqual([
      [a, "tab A 2"],
      [b, "tab B"],
    ])
    // The page itself is untouched.
    expect((await current(doc.id)).body).toBe("start")
  })

  it("an unapplied text over 1 MB is refused", async () => {
    const doc = await page()
    const res = await call(editor, "POST", `/documents/${doc.id}/versions`, {
      title: "Handbook",
      body: "x".repeat(1_000_001),
      baseRevision: doc.revision,
    })
    expect(res.status).toBe(400)
  })
})

describe("autosave PATCH", () => {
  it("one session's saves are one version; the session comes from the query only", async () => {
    const doc = await page()
    const s = crypto.randomUUID()
    for (const body of ["a", "ab", "abc"]) await patch(doc.id, body, `?autosave=1&session=${s}`)
    expect((await rows(doc.id)).map((r) => [r.kind, r.body, r.session_id])).toEqual([
      ["baseline", "start", null],
      ["edit", "abc", s],
    ])
    // A session in the body is not read.
    const other = await page()
    const cur = await current(other.id)
    const res = await call(editor, "PATCH", `/documents/${other.id}`, {
      revision: cur.revision,
      body: "x",
      session: s,
    })
    expect([200, 400]).toContain(res.status)
    const r = await rows(other.id)
    expect(r.every((v) => v.session_id === null)).toBe(true)
  })

  it("fresh=1 opens a new row for the same session", async () => {
    const doc = await page()
    const s = crypto.randomUUID()
    await patch(doc.id, "mine", `?autosave=1&session=${s}`)
    await patch(doc.id, "mine again", `?autosave=1&session=${s}&fresh=1`)
    expect((await rows(doc.id)).map((r) => r.body)).toEqual(["start", "mine", "mine again"])
  })

  it("an autosave of the stored text keeps the revision", async () => {
    const doc = await page()
    const saved = await patch(doc.id, "same", `?autosave=1&session=${crypto.randomUUID()}`)
    const again = await patch(doc.id, "same", `?autosave=1&session=${crypto.randomUUID()}`)
    expect(again.revision).toBe(saved.revision)
  })
})

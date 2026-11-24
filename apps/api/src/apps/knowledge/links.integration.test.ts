// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Page links (S13, S14) on a real database, through the HTTP API, the agent tools and
 * the search document builder.
 *
 * - A page link is stored as `[](knowledge:document:<id>)`, the id and nothing else.
 *   An agent's `@[Title](knowledge:document:id)` and any hand-written label are dropped
 *   on write, so a reader who cannot open the linked page never receives its title:
 *   not in the page, its history, its search document, a tool answer, a resolve, a
 *   backlink list or a picker.
 * - `document_links` follows each save; backlinks list only pages the reader may read.
 * - Renaming a page renames every link to it without touching the linking pages.
 * - The backfill normalises bodies, summaries and history stored before, in batches,
 *   idempotently, without a revision, an event or a review change, and has a dry run.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { sql } from "drizzle-orm"
import { app } from "~/app"
import { backfillPageLinks } from "~/apps/knowledge/links"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { registerKnowledgeSearchEnrichment } from "~/apps/knowledge/search-enrichment"
import { md5 } from "~/apps/knowledge/versions"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { planEntityDocument } from "~/modules/search/indexer"
import { seedDocumentVersion } from "~/seed/factories/knowledge/document-version"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(120_000)

const SCOPES = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
]

let orgId: string
let aliceId: string
let bobId: string
let alice: minimal.Session
let bob: minimal.Session

beforeAll(async () => {
  await acquireTestLock()
  initializedOrgRuntimes.clear()
  registerKnowledgeSearchEnrichment()
  orgId = (await createTestOrg()).id
  const a = await minimal.person(orgId, { name: "Alice" })
  const b = await minimal.person(orgId, { name: "Bob" })
  for (const s of SCOPES) {
    await minimal.grantScope(a.id, s)
    await minimal.grantScope(b.id, s)
  }
  // Alice may also move pages to the Trash.
  await minimal.grantScope(a.id, "knowledge:documents:archive")
  aliceId = a.id
  bobId = b.id
  alice = await minimal.sessionOf(a)
  bob = await minimal.sessionOf(b)
})
afterAll(releaseTestLock)

async function call(
  who: minimal.Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; data: unknown }> {
  const res = await app.request(`/api/knowledge${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.bearer}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return {
    status: res.status,
    text,
    data: text ? (JSON.parse(text) as { data?: unknown }).data : null,
  }
}

interface Doc {
  id: string
  revision: number
  title: string
  body: string
  summary: string | null
}

async function page(who: minimal.Session, input: Record<string, unknown> = {}): Promise<Doc> {
  const res = await call(who, "POST", "/documents", {
    title: "Page",
    body: "text",
    documentScope: "organization",
    orgAccess: "editor",
    ...input,
  })
  expect(res.status).toBe(201)
  return res.data as Doc
}

async function patch(who: minimal.Session, id: string, fields: Record<string, unknown>) {
  const doc = (await call(who, "GET", `/documents/${id}`)).data as Doc
  const res = await call(who, "PATCH", `/documents/${id}`, { revision: doc.revision, ...fields })
  expect(res.status).toBe(200)
  return res.data as Doc
}

async function actorOf(userId: string) {
  const perms = await withPrivilegedDb(orgId, "test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    orgId,
    userId,
    scopes: [...perms.scopes, ...SCOPES],
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  }
}

async function tool<T>(userId: string, toolName: string, params: Record<string, unknown>) {
  const res = await executeTool<T>({
    toolName,
    orgId,
    actor: await actorOf(userId),
    params,
    threadId: await minimal.thread(orgId, userId, { title: toolName }),
    origin: "in-app-agent",
    stepBundleId: null,
  } as never)
  return res.data as T
}

interface StoredDoc {
  body: string
  summary: string | null
  revision: number
  updated_at: string
  review_status: string
  links_indexed_at: string | null
}
async function stored(id: string): Promise<StoredDoc> {
  const [row] = extractRows<StoredDoc>(
    await withPrivilegedDb(orgId, "test-stored", (tx) =>
      tx.execute(sql`
        SELECT body, summary, revision, updated_at::text AS updated_at, review_status,
               links_indexed_at::text AS links_indexed_at
          FROM ${knowledgeRel("documents")} WHERE id = ${id}::uuid`),
    ),
  )
  if (!row) throw new Error("no such page")
  return row
}

async function linkTargets(sourceId: string): Promise<string[]> {
  return extractRows<{ t: string }>(
    await withPrivilegedDb(orgId, "test-links", (tx) =>
      tx.execute(sql`
        SELECT target_document_id::text AS t FROM ${knowledgeRel("document_links")}
         WHERE source_document_id = ${sourceId}::uuid ORDER BY 1`),
    ),
  ).map((r) => r.t)
}

interface VersionRow {
  id: string
  kind: string
  title: string
  body: string
  body_md5: string
}
async function versionRows(id: string): Promise<VersionRow[]> {
  return extractRows<VersionRow>(
    await withPrivilegedDb(orgId, "test-versions", (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, kind, title, body, body_md5
          FROM ${knowledgeRel("document_versions")} WHERE document_id = ${id}::uuid
         ORDER BY created_at, id`),
    ),
  )
}

const labelled = (title: string, id: string) => `@[${title}](knowledge:document:${id})`
const token = (id: string) => `[](knowledge:document:${id})`

describe("a reader without access to the linked page gets no title", () => {
  it("agent writes `@[Secret](knowledge:document:x)`: no 'Secret' in GET, versions, search, tool get, resolve", async () => {
    const secret = await page(alice, { title: "Secret plan Zephyr", orgAccess: "none" })
    const shared = await page(alice, { title: "Shared notes", body: "intro" })
    const current = (await call(alice, "GET", `/documents/${shared.id}`)).data as Doc
    // The agent pastes the mention tag it was handed, in the body and the summary.
    await tool(aliceId, "knowledge:update", {
      id: shared.id,
      revision: current.revision,
      body: `See ${labelled("Secret plan Zephyr", secret.id)} today.`,
      summary: `About ${labelled("Secret plan Zephyr", secret.id)}`,
    })

    const s = await stored(shared.id)
    expect(s.body).toBe(`See ${token(secret.id)} today.`)
    expect(s.summary).toBe(`About ${token(secret.id)}`)
    expect(await linkTargets(shared.id)).toEqual([secret.id])

    const get = await call(bob, "GET", `/documents/${shared.id}`)
    expect(get.status).toBe(200)
    expect(get.text).not.toContain("Zephyr")
    const list = await call(bob, "GET", `/documents/${shared.id}/versions`)
    expect(list.status).toBe(200)
    expect(list.text).not.toContain("Zephyr")
    for (const v of list.data as { id: string }[]) {
      const one = await call(bob, "GET", `/documents/${shared.id}/versions/${v.id}`)
      expect(one.text).not.toContain("Zephyr")
    }
    for (const v of await versionRows(shared.id)) expect(v.body).not.toContain("Zephyr")

    const plan = await planEntityDocument({
      action: "upsert",
      orgId,
      app: "knowledge",
      entityType: "document",
      entityId: shared.id,
    })
    expect(plan && "doc" in plan).toBe(true)
    expect(JSON.stringify(plan)).not.toContain("Zephyr")

    const bobGet = await tool<{ document?: { links?: unknown[] } }>(bobId, "knowledge:get", {
      id: shared.id,
    })
    expect(JSON.stringify(bobGet)).not.toContain("Zephyr")
    expect(bobGet.document?.links).toEqual([])
    const aliceGet = await tool<{ document?: { links?: unknown[] } }>(aliceId, "knowledge:get", {
      id: shared.id,
    })
    expect(aliceGet.document?.links).toEqual([{ id: secret.id, title: "Secret plan Zephyr" }])

    const bobResolve = await call(bob, "POST", "/documents/resolve", { ids: [secret.id] })
    expect(bobResolve.status).toBe(200)
    expect(bobResolve.data).toEqual([])
    const aliceResolve = await call(alice, "POST", "/documents/resolve", {
      ids: [secret.id, shared.id, crypto.randomUUID()],
    })
    expect(aliceResolve.data).toEqual([
      { id: secret.id, title: "Secret plan Zephyr" },
      { id: shared.id, title: "Shared notes" },
    ])
  })

  it("a link label typed by hand is dropped too, code is left alone, self-links are not recorded", async () => {
    const target = await page(alice, { title: "Target" })
    const self = await page(alice, { title: "Self" })
    const body = [
      `Read [the target](knowledge:document:${target.id}) and ${token(self.id)}.`,
      `Inline \`${labelled("Kept", target.id)}\` stays.`,
      "```",
      labelled("Also kept", target.id),
      "```",
    ].join("\n")
    await patch(alice, self.id, { body })
    const s = await stored(self.id)
    expect(s.body).toBe(
      [
        `Read ${token(target.id)} and ${token(self.id)}.`,
        `Inline \`${labelled("Kept", target.id)}\` stays.`,
        "```",
        labelled("Also kept", target.id),
        "```",
      ].join("\n"),
    )
    expect(await linkTargets(self.id)).toEqual([target.id])
    // A canonical body is stored byte for byte, and removing the link removes its row.
    const canonical = `a ${token(target.id)} b\r\n`
    await patch(alice, self.id, { body: canonical })
    expect((await stored(self.id)).body).toBe(canonical)
    await patch(alice, self.id, { body: "no links" })
    expect(await linkTargets(self.id)).toEqual([])
  })

  it("a label with any brackets, escapes, code, a title or another syntax never reaches a reader", async () => {
    const secret = await page(alice, { title: "Q3 [draft] Zephyr", orgAccess: "none" })
    const other = await page(alice, { title: "Q3 Zephyr part two", orgAccess: "none" })
    const shared = await page(alice, { title: "Shared hostile", body: "intro" })
    const id = secret.id
    const body = [
      `See @[Q3 [draft] Zephyr](knowledge:document:${id}) now.`,
      `Also @[Q3 [draft Zephyr](knowledge:document:${id}) and [Q3 draft] Zephyr]](knowledge:document:${id}).`,
      `Escaped [Q3 \\[draft\\] Zephyr](knowledge:document:${id}), code [Q3 \`Zephyr]\`](knowledge:document:${id}).`,
      `Titled [Zephyr](knowledge:document:${id} "Q3 Zephyr"), <knowledge:document:${id}>.`,
      `HTML <a href="knowledge:document:${id}">Q3 [Zephyr]</a>, ![Zephyr](knowledge:document:${id}).`,
      `Reference [Q3 Zephyr][z] and [Zephyr two].`,
      "",
      `[z]: knowledge:document:${id} "Zephyr"`,
      `[Zephyr two]: <knowledge:document:${other.id}>`,
    ].join("\n")
    await patch(alice, shared.id, { body })
    const s = await stored(shared.id)
    expect(s.body).not.toContain("Zephyr")
    expect(s.body).toContain(`See ${token(id)} now.`)
    expect(await linkTargets(shared.id)).toEqual([id, other.id].sort())

    const get = await call(bob, "GET", `/documents/${shared.id}`)
    expect(get.status).toBe(200)
    expect(get.text).not.toContain("Zephyr")
    const plan = await planEntityDocument({
      action: "upsert",
      orgId,
      app: "knowledge",
      entityType: "document",
      entityId: shared.id,
    })
    expect(JSON.stringify(plan)).not.toContain("Zephyr")
    const bobGet = await tool<{ document?: { links?: unknown[] } }>(bobId, "knowledge:get", {
      id: shared.id,
    })
    expect(JSON.stringify(bobGet)).not.toContain("Zephyr")

    // A text an earlier release stored as it was written leaves without the labels too.
    await withPrivilegedDb(orgId, "test-raw-hostile", (tx) =>
      tx.execute(sql`UPDATE ${knowledgeRel("documents")} SET body = ${body}
                      WHERE id = ${shared.id}::uuid`),
    )
    const raw = await call(bob, "GET", `/documents/${shared.id}`)
    expect(raw.text).not.toContain("Zephyr")
  })

  it("resolve and the picker apply the read check, not only row security", async () => {
    // A personal page Bob created and then handed to Alice: row security still shows it
    // to its creator, the read check does not.
    const mark = `Orion${crypto.randomUUID().slice(0, 6)}`
    const handed = await page(bob, { title: `${mark} handed`, documentScope: "personal" })
    await withPrivilegedDb(orgId, "test-hand-over", (tx) =>
      tx.execute(sql`UPDATE ${knowledgeRel("documents")} SET owner_user_id = ${aliceId}::uuid
                      WHERE id = ${handed.id}::uuid`),
    )
    const seen = await withRlsContext(
      { actorType: "user", orgId, userId: bobId, scopes: SCOPES, dimensionGrants: {} },
      (tx) =>
        tx.execute(sql`SELECT id FROM ${knowledgeRel("documents")} WHERE id = ${handed.id}::uuid`),
    )
    expect(extractRows(seen)).toHaveLength(1)
    expect((await call(bob, "GET", `/documents/${handed.id}`)).status).toBe(404)
    expect((await call(bob, "POST", "/documents/resolve", { ids: [handed.id] })).data).toEqual([])
    const pick = await call(bob, "GET", `/documents/pick?q=${mark}`)
    expect(pick.status).toBe(200)
    expect(pick.data).toEqual([])
    expect((await call(alice, "POST", "/documents/resolve", { ids: [handed.id] })).data).toEqual([
      { id: handed.id, title: `${mark} handed` },
    ])
  })

  it("a page created with a link records it; resolve drops pages in the Trash", async () => {
    const target = await page(alice, { title: "Archived target" })
    const created = await page(bob, { title: "New", body: labelled("Archived target", target.id) })
    expect((await stored(created.id)).body).toBe(token(target.id))
    expect(await linkTargets(created.id)).toEqual([target.id])
    expect((await call(alice, "POST", `/documents/${target.id}/archive`)).status).toBe(200)
    expect((await call(alice, "POST", "/documents/resolve", { ids: [target.id] })).data).toEqual([])
    // The link row stays: a restored page is linked again.
    expect(await linkTargets(created.id)).toEqual([target.id])
  })

  it("resolve takes at most 200 ids", async () => {
    const ids = Array.from({ length: 201 }, () => crypto.randomUUID())
    expect((await call(alice, "POST", "/documents/resolve", { ids })).status).toBe(400)
  })
})

describe("backlinks", () => {
  it("list the pages linking here that the reader may read, never another one", async () => {
    const target = await page(alice, { title: "Return procedure" })
    const open = await page(alice, { title: "Open source page", body: token(target.id) })
    const hidden = await page(alice, {
      title: "Hidden Quasar source",
      orgAccess: "none",
      body: token(target.id),
    })
    const forAlice = await call(alice, "GET", `/documents/${target.id}/backlinks`)
    const aliceItems = (forAlice.data as { backlinks: { kind: string; entityId: string }[] })
      .backlinks
    expect(
      aliceItems
        .filter((b) => b.kind === "page")
        .map((b) => b.entityId)
        .sort(),
    ).toEqual([open.id, hidden.id].sort())
    const forBob = await call(bob, "GET", `/documents/${target.id}/backlinks`)
    expect(forBob.status).toBe(200)
    expect(forBob.text).not.toContain("Quasar")
    expect(forBob.text).not.toContain(hidden.id)
    const bobItems = (
      forBob.data as { backlinks: { kind: string; entityId: string; title: string }[] }
    ).backlinks
    expect(bobItems.filter((b) => b.kind === "page")).toEqual([
      expect.objectContaining({
        kind: "page",
        app: "knowledge",
        entityType: "document",
        entityId: open.id,
        title: "Open source page",
      }),
    ])
    // A page one cannot read has no backlinks to ask for: the same 404 as an unknown id.
    const secret = await page(alice, { title: "Secret target", orgAccess: "none" })
    expect((await call(bob, "GET", `/documents/${secret.id}/backlinks`)).status).toBe(404)
  })

  it("renaming the target changes what resolve answers, the linking page is untouched", async () => {
    const target = await page(alice, { title: "Old name" })
    const source = await page(alice, { title: "Source", body: `x ${token(target.id)}` })
    const before = await stored(source.id)
    await patch(alice, target.id, { title: "New name" })
    expect((await call(bob, "POST", "/documents/resolve", { ids: [target.id] })).data).toEqual([
      { id: target.id, title: "New name" },
    ])
    expect(await stored(source.id)).toEqual(before)
  })
})

describe("the page picker", () => {
  it("finds a page just created by its title, only among pages the writer may read", async () => {
    const mark = `Nebula${crypto.randomUUID().slice(0, 6)}`
    const visible = await page(alice, { title: `${mark} visible` })
    const hidden = await page(alice, { title: `${mark} hidden`, orgAccess: "none" })
    const forAlice = await call(alice, "GET", `/documents/pick?q=${mark}`)
    expect(forAlice.status).toBe(200)
    expect((forAlice.data as { id: string }[]).map((p) => p.id).sort()).toEqual(
      [visible.id, hidden.id].sort(),
    )
    const forBob = await call(bob, "GET", `/documents/pick?q=${mark}`)
    expect(forBob.data).toEqual([{ id: visible.id, title: `${mark} visible` }])
    expect(forBob.text).not.toContain("hidden")
    // LIKE wildcards in the query are plain characters.
    expect((await call(alice, "GET", "/documents/pick?q=%25%25%25_")).data).toEqual([])
  })
})

describe("the backfill of texts stored before", () => {
  /** A page as an earlier release left it: a raw label in body, summary and history. */
  async function seedRaw(secretId: string) {
    const doc = await page(alice, { title: "Old page", body: "placeholder" })
    const rawBody = `Before ${labelled("Secret plan Zephyr", secretId)} and \`${labelled("In code", secretId)}\`.`
    const rawSummary = `Sum ${labelled("Secret plan Zephyr", secretId)}`
    await withPrivilegedDb(orgId, "test-seed-raw", async (tx) => {
      await tx.execute(sql`
        UPDATE ${knowledgeRel("documents")}
           SET body = ${rawBody}, summary = ${rawSummary}, links_indexed_at = NULL,
               review_status = 'verified'
         WHERE id = ${doc.id}::uuid`)
      await tx.execute(sql`DELETE FROM ${knowledgeRel("document_links")}
                            WHERE source_document_id = ${doc.id}::uuid`)
    })
    const versions = [
      ["baseline", "Old page", `older ${labelled("Secret plan Zephyr", secretId)}`],
      [
        "unapplied",
        `T ${labelled("Secret plan Zephyr", secretId)}`,
        `u ${labelled("Secret plan Zephyr", secretId)}`,
      ],
      ["edit", "Old page", rawBody],
    ] as const
    for (const [kind, title, body] of versions) {
      await seedDocumentVersion({ orgId, documentId: doc.id, kind, title, body, authorId: aliceId })
    }
    return { doc, rawBody, rawSummary }
  }

  it("dry run counts and writes nothing; the run removes every title, idempotently", async () => {
    const secret = await page(alice, { title: "Secret plan Zephyr", orgAccess: "none" })
    const { doc, rawBody } = await seedRaw(secret.id)
    const before = await stored(doc.id)
    const versionsBefore = await versionRows(doc.id)
    // Before the backfill, reads already leave without the title.
    const get = await call(bob, "GET", `/documents/${doc.id}`)
    expect(get.status).toBe(200)
    expect(get.text).not.toContain("Zephyr")
    expect((get.data as Doc).summary).toBe(`Sum ${token(secret.id)}`)

    const dry = await backfillPageLinks({ orgId, dryRun: true })
    expect(dry).toMatchObject({ dryRun: true, documentsChanged: 1, versionsChanged: 3 })
    expect(await stored(doc.id)).toEqual(before)
    expect(await versionRows(doc.id)).toEqual(versionsBefore)

    const run = await backfillPageLinks({ orgId })
    expect(run).toMatchObject({ dryRun: false, documentsChanged: 1, versionsChanged: 3 })
    const after = await stored(doc.id)
    const expectedBody = `Before ${token(secret.id)} and \`${labelled("In code", secret.id)}\`.`
    expect(after.body).toBe(expectedBody)
    expect(after.summary).toBe(`Sum ${token(secret.id)}`)
    // Only the tokens changed: no revision, no new timestamp, review status kept.
    expect(after.revision).toBe(before.revision)
    expect(after.updated_at).toBe(before.updated_at)
    expect(after.review_status).toBe("verified")
    expect(after.links_indexed_at).not.toBeNull()
    expect(await linkTargets(doc.id)).toEqual([secret.id])
    const versionsAfter = await versionRows(doc.id)
    expect(versionsAfter.map((v) => v.id)).toEqual(versionsBefore.map((v) => v.id))
    for (const v of versionsAfter) {
      expect(`${v.title} ${v.body}`).not.toContain("Zephyr")
      expect(v.body_md5).toBe(md5(v.body))
    }
    expect(versionsAfter.at(-1)?.body).toBe(expectedBody)
    expect(rawBody).toContain("Zephyr")

    // A second run finds nothing to do.
    expect(await backfillPageLinks({ orgId })).toMatchObject({
      documentsChanged: 0,
      versionsChanged: 0,
    })

    // The next save adds its own version and no baseline: history already holds the text.
    await patch(alice, doc.id, { body: "next text" })
    const next = await versionRows(doc.id)
    expect(next.map((v) => v.kind)).toEqual([...versionsAfter.map((v) => v.kind), "edit"])
  })

  it("takes only pages whose text or history holds a page link", async () => {
    const secret = await page(alice, { title: "Secret plan Zephyr", orgAccess: "none" })
    const { doc } = await seedRaw(secret.id)
    const plain = await page(alice, { title: "No links", body: "just text" })
    await withPrivilegedDb(orgId, "test-unindexed", (tx) =>
      tx.execute(sql`UPDATE ${knowledgeRel("documents")} SET links_indexed_at = NULL
                      WHERE id = ${plain.id}::uuid`),
    )
    const dry = await backfillPageLinks({ orgId, dryRun: true })
    expect(dry.documents).toBe(1)
    await backfillPageLinks({ orgId })
    expect((await stored(doc.id)).links_indexed_at).not.toBeNull()
    expect((await stored(plain.id)).links_indexed_at).toBeNull()
    // Its next save marks it done, as for any page the backfill has not reached.
    await patch(alice, plain.id, { body: "more text" })
    expect((await stored(plain.id)).links_indexed_at).not.toBeNull()
  })

  it("a page saved before the backfill reached it is normalised by that save, history too", async () => {
    const secret = await page(alice, { title: "Secret plan Zephyr", orgAccess: "none" })
    const { doc } = await seedRaw(secret.id)
    const kindsBefore = (await versionRows(doc.id)).map((v) => v.kind)
    await patch(alice, doc.id, { title: "Old page renamed" })
    const after = await versionRows(doc.id)
    // No baseline: the stored text, without its labels, is the newest row's text.
    expect(after.map((v) => v.kind)).toEqual([...kindsBefore, "edit"])
    for (const v of after) expect(`${v.title} ${v.body}`).not.toContain("Zephyr")
    const s = await stored(doc.id)
    expect(s.body).not.toContain("Zephyr")
    expect(s.summary).not.toContain("Zephyr")
    expect(s.links_indexed_at).not.toBeNull()
    expect(await linkTargets(doc.id)).toEqual([secret.id])
  })

  it("an unapplied text posted with a label is stored without it", async () => {
    const secret = await page(alice, { title: "Secret plan Zephyr", orgAccess: "none" })
    const doc = await page(alice, { title: "Conflicted" })
    const res = await call(alice, "POST", `/documents/${doc.id}/versions`, {
      title: "Conflicted",
      body: `mine ${labelled("Secret plan Zephyr", secret.id)}`,
      baseRevision: 1,
    })
    expect(res.status).toBe(201)
    const rows = await versionRows(doc.id)
    expect(rows.at(-1)).toMatchObject({ kind: "unapplied", body: `mine ${token(secret.id)}` })
    expect(rows.at(-1)?.body_md5).toBe(md5(`mine ${token(secret.id)}`))
  })
})

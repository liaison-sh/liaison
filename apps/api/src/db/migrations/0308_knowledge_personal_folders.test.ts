// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0308: which Knowledge folders stay personal. One organization per shape, the
// statement of the migration run on it as it runs on a live database (before
// the triggers exist), then the revert its header gives. Everything happens in
// one transaction that is rolled back, so no other test sees it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import postgres from "postgres"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import { superuserUrlForTestDb } from "~/tests/route-test-setup"

const FILE = new URL("./0308_knowledge_personal_folders.sql", import.meta.url).pathname

function text(): string {
  return readFileSync(FILE, "utf8")
}

function ruleSql(): string {
  const statement = text()
    .split("--> statement-breakpoint")
    .find((s) => s.includes("WITH RECURSIVE tree AS") && s.includes("previous_owner_user_id ="))
  if (!statement) throw new Error("0308: the reclassification statement is not in the file")
  return statement
}

function revertSql(): string {
  const lines = text().split("\n")
  const from = lines.findIndex((l) => l.startsWith("-- UPDATE app_knowledge.collections"))
  const body: string[] = []
  for (const line of lines.slice(from)) {
    body.push(line.replace(/^-- ?/, ""))
    if (line.trimEnd().endsWith(";")) break
  }
  return body.join("\n")
}

const url = superuserUrlForTestDb()
const sql = postgres(url ?? "", { max: 1, onnotice: () => {} })
type Tx = postgres.ReservedSql

let tx: Tx

beforeAll(async () => {
  expect(url).not.toBeNull()
  tx = await sql.reserve()
})

afterAll(async () => {
  tx.release()
  await sql.end()
})

const run = (statement: string) => tx.unsafe(statement)
const insert = (table: string, row: Record<string, RowValue>) => run(insertSql(table, row))

interface Org {
  id: string
  a: string
  b: string
  role: string
}

async function org(): Promise<Org> {
  const o = { id: randomUUID(), a: randomUUID(), b: randomUUID(), role: randomUUID() }
  await insert("kernel.organizations", {
    id: o.id,
    name: "Mig0308",
    slug: `mig0308-${o.id.slice(0, 13)}`,
  })
  for (const [id, name] of [
    [o.a, "a"],
    [o.b, "b"],
  ] as const) {
    await insert("kernel.users", {
      id,
      org_id: o.id,
      email: `${name}-${o.id.slice(0, 13)}@mig0308.test`,
      name,
      status: "active",
      password_hash: "h",
      auth_version: 1,
      permission_version: 1,
    })
  }
  return o
}

async function folder(
  o: Org,
  owner: string | null,
  opts: { parent?: string; archived?: boolean } = {},
): Promise<string> {
  const id = randomUUID()
  await insert("app_knowledge.collections", {
    id,
    org_id: o.id,
    name: "Mig0308 folder",
    owner_user_id: owner,
    parent_collection_id: opts.parent ?? null,
    archived_at: opts.archived ? { raw: "now()" } : null,
    updated_at: { raw: "'2026-01-02T03:04:05Z'::timestamptz" },
  })
  return id
}

async function page(
  o: Org,
  inFolder: string,
  opts: {
    by?: string
    owner?: string | null
    access?: "none" | "viewer" | "editor"
    scope?: "organization" | "personal"
    archived?: boolean
  } = {},
): Promise<string> {
  const id = randomUUID()
  const personal = opts.scope === "personal"
  await insert("app_knowledge.documents", {
    id,
    org_id: o.id,
    title: "Mig0308 page",
    body: "body",
    document_scope: opts.scope ?? "organization",
    owner_user_id: opts.owner === undefined ? o.a : opts.owner,
    created_by: opts.by ?? o.a,
    org_access: opts.access ?? "none",
    sensitivity: personal ? null : "internal",
    participant_ids: personal ? { raw: `'["${o.a}"]'::jsonb` } : null,
    required_scopes: { raw: "'{}'::text[]" },
    revision: 1,
    archived_at: opts.archived ? { raw: "now()" } : null,
  })
  await file(o, inFolder, "document", id)
  return id
}

async function file(
  o: Org,
  inFolder: string,
  type: "document" | "source_link",
  target: string,
): Promise<void> {
  await insert("app_knowledge.collection_memberships", {
    org_id: o.id,
    collection_id: inFolder,
    target_type: type,
    target_id: target,
  })
}

async function grant(o: Org, doc: string, kind: "user" | "role", grantee: string): Promise<void> {
  await insert("kernel.resource_grants", {
    org_id: o.id,
    resource_type: "knowledge.document",
    resource_id: doc,
    grantee_kind: kind,
    grantee,
    role: "viewer",
  })
}

async function sourceLink(o: Org, inFolder: string): Promise<void> {
  const identity = randomUUID()
  const id = randomUUID()
  await insert("app_knowledge.source_identities", {
    id: identity,
    org_id: o.id,
    source: "google-drive",
    external_id: `f-${identity}`,
  })
  await insert("app_knowledge.source_links", {
    id,
    org_id: o.id,
    source_identity_id: identity,
    source: "google-drive",
    external_id: `f-${identity}`,
    title: "Mig0308 link",
    owner_user_id: o.a,
  })
  await file(o, inFolder, "source_link", id)
}

async function syncedRoot(o: Org, root: string, owner: string | null): Promise<string> {
  const id = randomUUID()
  await insert("app_knowledge.synced_sources", {
    id,
    org_id: o.id,
    app_name: "google-drive",
    folder_ref: `ref-${id}`,
    display_name: "Mig0308 source",
    root_collection_id: root,
    owner_user_id: owner,
    default_sensitivity: owner ? null : "internal",
    created_by: o.a,
  })
  return id
}

interface Expected {
  owner: string | null
  previous: string | null
}

/** folder id -> what the rule must leave. */
const expected = new Map<string, Expected & { shape: string }>()
const reverted = new Map<string, string | null>()

function kept(shape: string, id: string, owner: string | null): void {
  expected.set(id, { shape, owner, previous: null })
  reverted.set(id, owner)
}
function shared(shape: string, id: string, previous: string | null, archived = false): void {
  expected.set(id, { shape, owner: null, previous })
  reverted.set(id, archived ? null : previous)
}

async function seedShapes(): Promise<void> {
  {
    const o = await org()
    const f = await folder(o, o.a)
    await page(o, f)
    await page(o, f, { scope: "personal" })
    await page(o, f, { owner: null })
    kept("all mine, private", f, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    const child = await folder(o, o.a, { parent: f })
    await page(o, child)
    await page(o, f, { access: "editor" })
    shared("one page everyone can read", f, o.a)
    shared("one page everyone can read: its subfolder", child, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    await grant(o, await page(o, f), "role", o.role)
    shared("a page granted to a role", f, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    await grant(o, await page(o, f), "user", o.b)
    shared("a page granted to another person", f, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    await grant(o, await page(o, f), "user", o.a)
    kept("a page granted to its owner only", f, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    await page(o, f)
    await page(o, f, { owner: o.b })
    shared("a page created by the owner, owned by another", f, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    await page(o, f)
    await page(o, f, { by: o.b })
    shared("a page created by another, owned by the owner", f, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    await page(o, f)
    await sourceLink(o, f)
    shared("a source link, which any reader sees", f, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    const child = await folder(o, o.a, { parent: f })
    const archived = await folder(o, o.a, { parent: f, archived: true })
    shared("an empty tree", f, o.a)
    shared("an empty tree: its subfolder", child, o.a)
    shared("an empty tree: its archived subfolder", archived, o.a, true)
  }
  {
    const o = await org()
    const top = await folder(o, null)
    const mine = await folder(o, o.a, { parent: top })
    await page(o, mine)
    expected.set(top, { shape: "a shared top", owner: null, previous: null })
    reverted.set(top, null)
    shared("my private subfolder of a shared top", mine, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    const theirs = await folder(o, o.b, { parent: f })
    await page(o, f)
    shared("my tree holding a folder of another person", f, o.a)
    shared("the folder of another person in my tree", theirs, o.b)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    const theirs = await folder(o, o.b, { parent: f, archived: true })
    await page(o, f)
    kept("an archived folder of another person does not count", f, o.a)
    kept("an archived folder of another person follows its tree", theirs, o.b)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    await page(o, f, { archived: true })
    shared("only archived pages", f, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    const archived = await folder(o, o.a, { parent: f, archived: true })
    await page(o, archived)
    kept("a private page in an archived subfolder", f, o.a)
    kept("the archived subfolder of a kept tree", archived, o.a)
  }
  {
    const o = await org()
    const empty = await folder(o, o.a)
    await syncedRoot(o, empty, o.a)
    kept("a personal synced root, empty", empty, o.a)
    const full = await folder(o, o.a)
    const child = await folder(o, o.a, { parent: full })
    await syncedRoot(o, full, o.a)
    await page(o, child, { access: "editor" })
    kept("a personal synced root, full", full, o.a)
    kept("a folder under a personal synced root", child, o.a)
  }
  {
    const o = await org()
    const f = await folder(o, o.a)
    await page(o, f)
    const root = await folder(o, null, { parent: f })
    const under = await folder(o, null, { parent: root })
    await syncedRoot(o, root, null)
    await page(o, under, { access: "editor" })
    kept("my folder holding the organization's synced root", f, o.a)
    expected.set(root, { shape: "the organization's synced root", owner: null, previous: null })
    reverted.set(root, null)
    expected.set(under, { shape: "under it", owner: null, previous: null })
    reverted.set(under, null)
  }
}

async function state(): Promise<Map<string, Expected & { updatedAt: string }>> {
  const ids = [...expected.keys()]
  const rows = (await tx.unsafe(
    `SELECT id::text AS id, owner_user_id::text AS owner, previous_owner_user_id::text AS previous,
            updated_at FROM app_knowledge.collections WHERE id = ANY($1::uuid[])`,
    [ids],
  )) as unknown as Array<Expected & { id: string; updated_at: Date }>
  return new Map(
    rows.map((r) => [
      r.id,
      { owner: r.owner, previous: r.previous, updatedAt: new Date(r.updated_at).toISOString() },
    ]),
  )
}

/** Run `fn` on a database that is at the moment of the migration: before its triggers. */
async function atMigrationTime(fn: () => Promise<void>): Promise<void> {
  await run("BEGIN")
  try {
    await run("DROP TRIGGER collections_owner_lost ON app_knowledge.collections")
    expected.clear()
    reverted.clear()
    await seedShapes()
    await fn()
  } finally {
    await run("ROLLBACK")
  }
}

function expectRule(got: Map<string, Expected & { updatedAt: string }>): void {
  for (const [id, want] of expected) {
    const row = got.get(id)
    expect({ shape: want.shape, owner: row?.owner, previous: row?.previous }).toEqual(want)
    expect(row?.updatedAt).toBe("2026-01-02T03:04:05.000Z")
  }
}

describe("0308 personal folders: the rule", () => {
  it("keeps personal only what its owner alone can read, and shares the rest", async () => {
    await atMigrationTime(async () => {
      await run(ruleSql())
      expectRule(await state())
    })
  })

  it("changes nothing when it runs twice", async () => {
    await atMigrationTime(async () => {
      await run(ruleSql())
      await run(ruleSql())
      expectRule(await state())
    })
  })

  it("runs the same as liaison_admin, the role the file takes", async () => {
    expect(text()).toContain("SET LOCAL ROLE liaison_admin;")
    await atMigrationTime(async () => {
      await run("SET LOCAL ROLE liaison_admin")
      await run(ruleSql())
      await run("RESET ROLE")
      expectRule(await state())
    })
  })

  it("leaves a personal folder made after the migration alone if the file is replayed", async () => {
    await run("BEGIN")
    try {
      const o = await org()
      const f = await folder(o, o.a)
      for (const statement of text().split("--> statement-breakpoint")) await run(statement)
      const [row] = (await tx.unsafe(
        "SELECT owner_user_id::text AS owner, archived_at, name FROM app_knowledge.collections WHERE id = $1",
        [f],
      )) as unknown as Array<{ owner: string; archived_at: Date | null; name: string }>
      expect(row).toEqual({ owner: o.a, archived_at: null, name: "Mig0308 folder" })
    } finally {
      await run("ROLLBACK")
    }
  })

  it("is undone by the revert in its header, but for a folder re-assigned meanwhile", async () => {
    await atMigrationTime(async () => {
      await run(ruleSql())
      const [taken] = [...expected].filter(([, e]) => e.shape === "only archived pages")
      const takenId = taken?.[0] ?? ""
      await tx.unsafe(
        `UPDATE app_knowledge.collections SET owner_user_id =
           (SELECT u.id FROM kernel.users u WHERE u.org_id = collections.org_id AND u.name = 'b')
          WHERE id = $1`,
        [takenId],
      )
      const before = await state()
      await run(revertSql())
      const got = await state()
      for (const [id, owner] of reverted) {
        const shape = expected.get(id)?.shape
        if (id === takenId) {
          expect({ shape, ...got.get(id) }).toEqual({ shape, ...before.get(id) } as never)
          continue
        }
        expect({ shape, owner: got.get(id)?.owner }).toEqual({ shape, owner })
      }
    })
  })
})

describe("0308 personal folders: a lost owner", () => {
  async function inTx(fn: () => Promise<void>): Promise<void> {
    await run("BEGIN")
    try {
      await fn()
    } finally {
      await run("ROLLBACK")
    }
  }
  async function row(id: string) {
    const [r] = (await tx.unsafe(
      "SELECT name, description, owner_user_id AS owner, archived_at IS NOT NULL AS archived FROM app_knowledge.collections WHERE id = $1",
      [id],
    )) as unknown as Array<Record<string, unknown>>
    return r
  }
  const tombstone = { name: "Deleted folder", description: null, owner: null, archived: true }

  it("archives and renames the folder, whoever clears the owner", async () => {
    await inTx(async () => {
      const o = await org()
      const f = await folder(o, o.a)
      await run(`UPDATE app_knowledge.collections SET description = 'secret' WHERE id = '${f}'`)
      await run(`UPDATE app_knowledge.collections SET owner_user_id = NULL WHERE id = '${f}'`)
      expect(await row(f)).toEqual(tombstone)
    })
  })

  it("does the same when the user row is deleted (the foreign key clears the owner)", async () => {
    await inTx(async () => {
      const o = await org()
      const f = await folder(o, o.a)
      await run(`DELETE FROM kernel.users WHERE id = '${o.a}'`)
      expect(await row(f)).toEqual(tombstone)
    })
  })

  it("leaves a folder re-pointed to another person as it is", async () => {
    await inTx(async () => {
      const o = await org()
      const f = await folder(o, o.a)
      await run(`UPDATE app_knowledge.collections SET owner_user_id = '${o.b}' WHERE id = '${f}'`)
      expect(await row(f)).toEqual({
        name: "Mig0308 folder",
        description: null,
        owner: o.b,
        archived: false,
      })
    })
  })

  it("archives a personal source and drops what names it", async () => {
    await inTx(async () => {
      const o = await org()
      const f = await folder(o, o.a)
      const s = await syncedRoot(o, f, o.a)
      await run(`UPDATE app_knowledge.synced_sources SET owner_user_id = NULL WHERE id = '${s}'`)
      const [r] = (await tx.unsafe(
        "SELECT display_name, folder_ref, archived_at IS NOT NULL AS archived, default_sensitivity FROM app_knowledge.synced_sources WHERE id = $1",
        [s],
      )) as unknown as Array<Record<string, unknown>>
      expect(r).toEqual({
        display_name: "Deleted source",
        folder_ref: `deleted:${s}`,
        archived: true,
        default_sensitivity: "restricted",
      })
    })
  })
})

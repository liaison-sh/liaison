// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Page history (migration 0310, versions.ts) on a real database, under row security.
 *
 * - One session of one person keeps one row for 10 minutes; another session, an agent
 *   write, `fresh` or the 10 minutes each open a new row; no text ever stored is lost.
 * - The version and the revision compare-and-swap are one statement: a failed swap
 *   writes no row, a failed version insert fails the save.
 * - History is readable only with the edit right (`app_knowledge.can_edit_document`,
 *   which must agree with the service's own write check).
 * - The Trash clock never survives an un-archive or a re-archive by SQL that does not
 *   know it (the previous release, the sync).
 * - A verified page stays verified unless its text really changed.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  assertCanWriteDocumentRow,
  createKnowledgeDocument,
  type KnowledgeActor,
  type KnowledgeDocumentRow,
  KnowledgeError,
  knowledgeActorFromContext,
  loadKnowledgeDocument,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { saveUnapplied, VERSIONS_PER_PAGE } from "~/apps/knowledge/versions"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { bridgeKnowledgeActorInput } from "~/modules/apps/sandbox/bridge/shared"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(120_000)

const READ = "knowledge:documents:read"
const CREATE = "knowledge:documents:create"
const UPDATE = "knowledge:documents:update"
const ARCHIVE = "knowledge:documents:archive"
const WRITER = [READ, CREATE, UPDATE]

let orgId: string
let alice: string
let bob: string

beforeAll(async () => {
  await acquireTestLock()
  initializedOrgRuntimes.clear()
  orgId = (await createTestOrg()).id
  alice = (await minimal.person(orgId, { name: "Alice" })).id
  bob = (await minimal.person(orgId, { name: "Bob" })).id
})
afterAll(releaseTestLock)

function ctx(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", orgId, userId, scopes, dimensionGrants: {}, roles: [] } as UserContext
}
function actor(userId: string, scopes: string[], extra: Partial<KnowledgeActor> = {}) {
  return { ...knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} }), ...extra }
}
const K = () => sql.raw(schemaRef("app_knowledge"))

async function create(
  userId: string,
  input: Record<string, unknown> = {},
  scopes = WRITER,
): Promise<KnowledgeDocumentRow> {
  return withRlsContext(ctx(userId, scopes), (tx) =>
    createKnowledgeDocument(
      tx,
      { title: "Page", body: "first", documentScope: "organization", ...input } as never,
      actor(userId, scopes),
      [],
    ),
  )
}

async function save(
  userId: string,
  id: string,
  patch: Record<string, unknown>,
  opts: { session?: string; fresh?: boolean; author?: KnowledgeActor["author"] } = {},
  scopes = WRITER,
): Promise<KnowledgeDocumentRow> {
  return withRlsContext(ctx(userId, scopes), async (tx) => {
    const row = await loadKnowledgeDocument(tx, id, actor(userId, scopes))
    if (!row) throw new Error("not readable")
    return updateKnowledgeDocument(
      tx,
      { id, revision: row.revision, ...patch } as never,
      actor(userId, scopes, opts.author ? { author: opts.author } : {}),
      [],
      opts.session ? { session: { id: opts.session, fresh: opts.fresh } } : {},
    )
  })
}

interface VersionRow {
  kind: string
  title: string
  body: string
  author_type: string
  author_id: string | null
  agent_id: string | null
  session_id: string | null
}
async function versions(documentId: string): Promise<VersionRow[]> {
  return extractRows<VersionRow>(
    await withPrivilegedDb(orgId, "test-versions", (tx) =>
      tx.execute(sql`
        SELECT kind, title, body, author_type, author_id::text AS author_id,
               agent_id::text AS agent_id, session_id::text AS session_id
          FROM ${K()}.document_versions WHERE document_id = ${documentId}::uuid
         ORDER BY created_at, id`),
    ),
  )
}
/** Why a statement was refused: the database's own message, under the driver's wrapper. */
function refusal(err: Error): string {
  return (err.cause as Error | undefined)?.message ?? err.message
}

/** The migration login, for DDL on tables the runtime roles do not own. */
async function asOwner(statement: string): Promise<void> {
  const url =
    process.env.MIGRATION_DATABASE_URL ??
    `${(process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432").replace(/\/$/, "")}/${new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")}`
  const owner = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await owner.unsafe(statement)
  } finally {
    await owner.end()
  }
}

async function privileged(statement: ReturnType<typeof sql>) {
  return withPrivilegedDb(orgId, "test-privileged", (tx) => tx.execute(statement))
}

describe("one version per author session", () => {
  it("10 saves by one session make one row; an agent write in between makes its own, in order", async () => {
    const doc = await create(alice)
    const s = crypto.randomUUID()
    for (let i = 1; i <= 5; i++) await save(alice, doc.id, { body: `text ${i}` }, { session: s })
    await save(alice, doc.id, { body: "agent text" }, { author: { type: "agent", agentId: null } })
    for (let i = 6; i <= 10; i++) await save(alice, doc.id, { body: `text ${i}` }, { session: s })
    const rows = await versions(doc.id)
    // The baseline holds the text the page was created with.
    expect(rows.map((r) => [r.kind, r.body])).toEqual([
      ["baseline", "first"],
      ["edit", "text 5"],
      ["agent", "agent text"],
      ["edit", "text 10"],
    ])
  })

  it("10 saves in one session within 10 minutes are one row; past 10 minutes a new one", async () => {
    const doc = await create(alice)
    const s = crypto.randomUUID()
    for (let i = 1; i <= 10; i++) await save(alice, doc.id, { body: `t${i}` }, { session: s })
    expect((await versions(doc.id)).map((r) => r.kind)).toEqual(["baseline", "edit"])
    await privileged(sql`
      UPDATE ${K()}.document_versions SET started_at = now() - interval '11 minutes'
       WHERE document_id = ${doc.id}::uuid AND kind = 'edit'`)
    await save(alice, doc.id, { body: "t11" }, { session: s })
    expect((await versions(doc.id)).map((r) => r.body)).toEqual(["first", "t10", "t11"])
  })

  it("one person, two sessions saving in turn: every text ever stored is in a row", async () => {
    const doc = await create(alice)
    const a = crypto.randomUUID()
    const b = crypto.randomUUID()
    const stored: string[] = ["first"]
    for (let i = 1; i <= 4; i++) {
      const text = `${i % 2 ? "A" : "B"}${i}`
      await save(alice, doc.id, { body: text }, { session: i % 2 ? a : b })
      stored.push(text)
    }
    const rows = await versions(doc.id)
    expect(rows.map((r) => r.body)).toEqual(stored)
    expect(rows.slice(1).map((r) => r.session_id)).toEqual([a, b, a, b])
  })

  it("a save without a session is always its own row", async () => {
    const doc = await create(alice)
    await save(alice, doc.id, { body: "x1" })
    await save(alice, doc.id, { body: "x2" })
    expect((await versions(doc.id)).map((r) => r.body)).toEqual(["first", "x1", "x2"])
  })

  it("the same session with fresh opens a new row; the row before keeps its text", async () => {
    const doc = await create(alice)
    const s = crypto.randomUUID()
    await save(alice, doc.id, { body: "mine 1" }, { session: s })
    await save(alice, doc.id, { body: "mine 2" }, { session: s, fresh: true })
    await save(alice, doc.id, { body: "mine 3" }, { session: s })
    expect((await versions(doc.id)).map((r) => r.body)).toEqual(["first", "mine 1", "mine 3"])
  })

  it("a text written by SQL that history does not hold gets a baseline before the next save", async () => {
    const doc = await create(alice)
    await save(alice, doc.id, { body: "one" })
    await privileged(sql`
      UPDATE ${K()}.documents SET body = 'written elsewhere', revision = revision + 1
       WHERE id = ${doc.id}::uuid`)
    await save(alice, doc.id, { body: "two" })
    const rows = await versions(doc.id)
    expect(rows.map((r) => [r.kind, r.body])).toEqual([
      ["baseline", "first"],
      ["edit", "one"],
      ["baseline", "written elsewhere"],
      ["edit", "two"],
    ])
  })

  it("no version for a change of settings only", async () => {
    const doc = await create(alice)
    await save(alice, doc.id, { reviewDueAt: new Date(Date.now() + 86_400_000).toISOString() })
    await save(alice, doc.id, { title: "Page" }) // same title
    expect(await versions(doc.id)).toEqual([])
  })

  it(`keeps ${VERSIONS_PER_PAGE} rows; the next one drops the oldest`, async () => {
    const doc = await create(alice)
    // 199 old rows a day apart, then the page's current text an hour ago.
    const day = 86_400_000
    const old = Array.from({ length: VERSIONS_PER_PAGE - 1 }, (_, i) => ({
      text: `old ${i + 1}`,
      at: new Date(Date.now() - (300 - (i + 1)) * day).toISOString(),
    }))
    old.push({ text: "first", at: new Date(Date.now() - 3_600_000).toISOString() })
    await privileged(
      sql.raw(
        insertSql(
          `${schemaRef("app_knowledge")}.document_versions`,
          old.map((o) => ({
            org_id: orgId,
            document_id: doc.id,
            kind: "edit",
            title: "Page",
            body: o.text,
            body_md5: { raw: `md5('${o.text}')` },
            revision: 1,
            author_type: "user",
            author_id: alice,
            created_at: o.at,
            started_at: o.at,
            required_scopes: { raw: "'{}'::text[]" },
          })),
        ),
      ),
    )
    expect((await versions(doc.id)).length).toBe(VERSIONS_PER_PAGE)
    await save(alice, doc.id, { body: "newest" })
    const rows = await versions(doc.id)
    expect(rows.length).toBe(VERSIONS_PER_PAGE)
    expect(rows[0]?.body).toBe("old 2")
    expect(rows.at(-1)?.body).toBe("newest")
  })

  it("an agent looping 300 writes keeps the person's text and the conflict text", async () => {
    const doc = await create(alice)
    await save(alice, doc.id, { body: "the person's text" }, { session: crypto.randomUUID() })
    const base = (await loadAsAlice(doc.id)).revision
    await withRlsContext(ctx(bob, WRITER), (tx) =>
      saveUnapplied(tx, {
        orgId,
        documentId: doc.id,
        title: "Page",
        body: "bob's conflict text",
        baseRevision: base,
        session: crypto.randomUUID(),
        authorId: bob,
      }),
    )
    const agentId = crypto.randomUUID()
    for (let i = 1; i <= 300; i++) {
      await save(alice, doc.id, { body: `agent ${i}` }, { author: { type: "agent", agentId } })
    }
    const rows = await versions(doc.id)
    expect(rows.length).toBe(VERSIONS_PER_PAGE)
    expect(rows.find((r) => r.body === "the person's text")).toMatchObject({
      kind: "edit",
      author_type: "user",
    })
    expect(rows.find((r) => r.body === "bob's conflict text")?.kind).toBe("unapplied")
    expect(rows.at(-1)?.body).toBe("agent 300")
    // The cap took the agent's oldest rows: its newest 198 are left.
    expect(rows.filter((r) => r.kind === "agent").map((r) => r.body)[0]).toBe("agent 103")
  })

  it("past a year a version goes, even an author's newest; an unapplied text stays", async () => {
    const doc = await create(alice)
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString()
    await privileged(
      sql.raw(
        insertSql(
          `${schemaRef("app_knowledge")}.document_versions`,
          [
            { kind: "edit", body: "bob's old edit", author_id: bob },
            { kind: "unapplied", body: "bob's old conflict text", author_id: bob },
          ].map((r) => ({
            org_id: orgId,
            document_id: doc.id,
            kind: r.kind,
            title: "Page",
            body: r.body,
            body_md5: { raw: `md5('${r.body.replace(/'/g, "''")}')` },
            revision: 1,
            base_revision: 1,
            author_type: "user",
            author_id: r.author_id,
            created_at: old,
            updated_at: old,
            started_at: old,
            required_scopes: { raw: "'{}'::text[]" },
          })),
        ),
      ),
    )
    await save(alice, doc.id, { body: "today" })
    const bodies = (await versions(doc.id)).map((r) => r.body)
    expect(bodies).toContain("bob's old conflict text")
    expect(bodies).not.toContain("bob's old edit")
    expect(bodies).toContain("today")
  })
})

describe("the version and the compare-and-swap are one write", () => {
  it("two concurrent saves at one revision: one version, one conflict, no orphan row", async () => {
    const doc = await create(alice)
    await save(alice, doc.id, { body: "base" })
    const before = await versions(doc.id)
    let releaseFirst: () => void = () => {}
    const firstHolds = new Promise<void>((r) => {
      releaseFirst = r
    })
    let firstWrote: () => void = () => {}
    const firstWroteP = new Promise<void>((r) => {
      firstWrote = r
    })
    const revision = (await loadAsAlice(doc.id)).revision
    const first = withRlsContext(ctx(alice, WRITER), async (tx) => {
      const out = await updateKnowledgeDocument(
        tx,
        { id: doc.id, revision, body: "first writer" } as never,
        actor(alice, WRITER),
        [],
      )
      firstWrote()
      await firstHolds
      return out
    })
    await firstWroteP
    const second = withRlsContext(ctx(bob, WRITER), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: doc.id, revision, body: "second writer" } as never,
        actor(bob, WRITER),
        [],
      ),
    )
    await Bun.sleep(300) // the second waits on the first's row lock
    releaseFirst()
    const [a, b] = await Promise.allSettled([first, second])
    expect(a.status).toBe("fulfilled")
    expect(b.status).toBe("rejected")
    expect(((b as PromiseRejectedResult).reason as KnowledgeError).code).toBe("REVISION_CONFLICT")
    const after = await versions(doc.id)
    expect(after.length).toBe(before.length + 1)
    expect(after.at(-1)?.body).toBe("first writer")
    expect(after.some((r) => r.body === "second writer")).toBe(false)
  })

  it("a version that cannot be stored fails the save", async () => {
    const doc = await create(alice)
    await asOwner(`
      CREATE OR REPLACE FUNCTION ${schemaRef("app_knowledge")}.test_refuse_version() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('test.refuse_version', true) = 'on' THEN RAISE EXCEPTION 'refused'; END IF;
        RETURN NEW; END $$`)
    await asOwner(`
      CREATE TRIGGER test_refuse_version BEFORE INSERT OR UPDATE ON ${schemaRef("app_knowledge")}.document_versions
      FOR EACH ROW EXECUTE FUNCTION ${schemaRef("app_knowledge")}.test_refuse_version()`)
    try {
      // The baseline is refused too, and the whole save with it.
      const refused = await withRlsContext(ctx(alice, WRITER), async (tx) => {
        await tx.execute(sql`SELECT set_config('test.refuse_version', 'on', true)`)
        return updateKnowledgeDocument(
          tx,
          { id: doc.id, revision: doc.revision, body: "never" } as never,
          actor(alice, WRITER),
          [],
        )
      }).then(
        () => null,
        (err: Error) => err,
      )
      expect(refused ? refusal(refused) : "").toContain("refused")
      expect((await loadAsAlice(doc.id)).body).toBe("first")
    } finally {
      await asOwner(
        `DROP TRIGGER test_refuse_version ON ${schemaRef("app_knowledge")}.document_versions`,
      )
      await asOwner(`DROP FUNCTION ${schemaRef("app_knowledge")}.test_refuse_version()`)
    }
  })
})

async function loadAsAlice(id: string): Promise<KnowledgeDocumentRow> {
  const row = await withRlsContext(ctx(alice, WRITER), (tx) =>
    loadKnowledgeDocument(tx, id, actor(alice, WRITER)),
  )
  if (!row) throw new Error("gone")
  return row
}

async function readableVersions(userId: string, scopes: string[], documentId: string) {
  return withRlsContext(ctx(userId, scopes), async (tx) =>
    extractRows<{ n: number }>(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM ${K()}.document_versions
         WHERE document_id = ${documentId}::uuid`),
    ),
  ).then((r) => r[0]?.n ?? 0)
}

describe("history is read with the edit right only", () => {
  it("a viewer selects no row, an editor all; once the edit right is gone, none", async () => {
    const doc = await create(alice, { orgAccess: "editor" })
    await save(bob, doc.id, { body: "bob" })
    await save(alice, doc.id, { body: "alice" })
    expect(await readableVersions(bob, WRITER, doc.id)).toBe(3)
    expect(await readableVersions(bob, [READ], doc.id)).toBe(0)
    await privileged(
      sql`UPDATE ${K()}.documents SET org_access = 'viewer' WHERE id = ${doc.id}::uuid`,
    )
    expect(await readableVersions(bob, WRITER, doc.id)).toBe(0)
    expect(await readableVersions(alice, WRITER, doc.id)).toBe(3)
  })

  it("nobody writes a version of a page they cannot edit", async () => {
    const doc = await create(alice, { orgAccess: "viewer" })
    const refused = await withRlsContext(ctx(bob, WRITER), (tx) =>
      tx.execute(
        sql.raw(
          insertSql(`${schemaRef("app_knowledge")}.document_versions`, {
            org_id: orgId,
            document_id: doc.id,
            kind: "edit",
            title: "x",
            body: "x",
            body_md5: "x",
            author_type: "user",
            author_id: bob,
            required_scopes: { raw: "'{}'::text[]" },
          }),
        ),
      ),
    ).then(
      () => null,
      (err: Error) => err,
    )
    expect(refused ? refusal(refused) : "").toMatch(/row-level security/)
  })

  it("can_edit_document answers as the service's write check, over the access matrix", async () => {
    // An edit scope is one bare word (the form row security checks exactly).
    const EXACT = "test-exact-edit"
    const docs: { id: string; grant: "viewer" | "editor" | null }[] = []
    const personal = await create(alice, { documentScope: "personal" })
    docs.push({ id: personal.id, grant: null })
    for (const orgAccess of ["none", "viewer", "editor"] as const)
      for (const editScope of [null, EXACT])
        for (const grant of [null, "viewer", "editor"] as const)
          for (const archived of [false, true]) {
            const d = await create(alice, { orgAccess, editScope, sensitivity: "internal" })
            if (grant)
              await privileged(
                sql.raw(
                  insertSql(`${schemaRef("kernel")}.resource_grants`, {
                    org_id: orgId,
                    resource_type: "knowledge.document",
                    resource_id: d.id,
                    grantee_kind: "user",
                    grantee: bob,
                    role: grant,
                    created_by: alice,
                  }),
                ),
              )
            if (archived)
              await privileged(
                sql`UPDATE ${K()}.documents SET archived_at = now() WHERE id = ${d.id}::uuid`,
              )
            docs.push({ id: d.id, grant })
          }
    const rows = new Map<string, KnowledgeDocumentRow>()
    for (const d of docs) {
      const row = await withRlsContext(ctx(alice, [...WRITER, ARCHIVE]), (tx) =>
        loadKnowledgeDocument(
          tx,
          d.id,
          actor(alice, [...WRITER, ARCHIVE], { includeArchived: true }),
        ),
      )
      if (row) rows.set(d.id, row)
    }
    expect(rows.size).toBe(docs.length)
    let compared = 0
    for (const scopes of [
      [],
      [READ],
      [READ, UPDATE],
      [READ, UPDATE, ARCHIVE],
      [READ, UPDATE, EXACT],
    ]) {
      const answers = await withRlsContext(ctx(bob, scopes), async (tx) =>
        extractRows<{ id: string; can: boolean }>(
          await tx.execute(sql`
            SELECT id::text AS id, ${K()}.can_edit_document(id::uuid) AS can
              FROM unnest(${`{${docs.map((d) => d.id).join(",")}}`}::uuid[]) AS id`),
        ),
      )
      for (const a of answers) {
        const d = docs.find((x) => x.id === a.id)
        const row = rows.get(a.id)
        if (!d || !row) throw new Error("missing")
        let expected = true
        try {
          assertCanWriteDocumentRow(
            row,
            actor(bob, scopes, { includeArchived: scopes.includes(ARCHIVE) }),
            d.grant,
          )
        } catch (err) {
          if (!(err instanceof KnowledgeError)) throw err
          expected = false
        }
        expect({ id: a.id, scopes, can: a.can }).toEqual({ id: a.id, scopes, can: expected })
        compared++
      }
    }
    expect(compared).toBe(docs.length * 5)
  })
})

describe("page links (row security only; K4 writes them)", () => {
  const link = (source: string) =>
    sql.raw(
      insertSql(`${schemaRef("app_knowledge")}.document_links`, {
        org_id: orgId,
        source_document_id: source,
        target_document_id: crypto.randomUUID(),
      }),
    )
  const attempt = (userId: string, scopes: string[], source: string) =>
    withRlsContext(ctx(userId, scopes), (tx) => tx.execute(link(source))).then(
      () => "ok",
      (err: Error) => refusal(err),
    )

  it("a create-only person records the links of a page they created, of no other", async () => {
    const createOnly = [READ, CREATE]
    const mine = await create(bob, { orgAccess: "editor" }, createOnly)
    expect(await attempt(bob, createOnly, mine.id)).toBe("ok")
    const theirs = await create(alice, { orgAccess: "editor" })
    expect(await attempt(bob, createOnly, theirs.id)).toMatch(/row-level security/)
    // With the edit right, links of another's page too.
    expect(await attempt(bob, WRITER, theirs.id)).toBe("ok")
  })

  it("links of a page one cannot read are not listed", async () => {
    const hidden = await create(alice, { orgAccess: "none" })
    expect(await attempt(alice, WRITER, hidden.id)).toBe("ok")
    const seen = await withRlsContext(ctx(bob, WRITER), async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(sql`
          SELECT count(*)::int AS n FROM ${K()}.document_links
           WHERE source_document_id = ${hidden.id}::uuid`),
      ),
    )
    expect(seen[0]?.n).toBe(0)
  })
})

describe("who wrote it", () => {
  it("an agent's update through the tool is an agent version, never coalesced", async () => {
    const doc = await create(alice)
    const perms = await withPrivilegedDb(orgId, "test-perms", (tx) =>
      loadEffectivePermissions(tx, alice, orgId),
    )
    const actorCtx = {
      actorType: "user",
      orgId,
      userId: alice,
      scopes: [...perms.scopes, ...WRITER],
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    }
    for (const body of ["agent 1", "agent 2"]) {
      const revision = (await loadAsAlice(doc.id)).revision
      const res = await executeTool<{ id?: string; error?: unknown }>({
        toolName: "knowledge:update",
        orgId,
        actor: actorCtx,
        params: { id: doc.id, revision, body },
        threadId: await minimal.thread(orgId, alice, { title: body }),
        origin: "in-app-agent",
        stepBundleId: null,
      } as never)
      expect((res.data as { id?: string }).id).toBe(doc.id)
    }
    const rows = await versions(doc.id)
    expect(rows.map((r) => [r.kind, r.author_type, r.author_id, r.body])).toEqual([
      ["baseline", "user", alice, "first"],
      ["agent", "agent", alice, "agent 1"],
      ["agent", "agent", alice, "agent 2"],
    ])
  })

  it("the bridge marks agent, MCP and approved writes as the agent's, with its id", () => {
    const base = {
      orgId,
      userId: alice,
      callerScopes: WRITER,
      inheritedActor: ctx(alice, WRITER),
    }
    expect(bridgeKnowledgeActorInput(base).author).toBeUndefined()
    expect(
      bridgeKnowledgeActorInput({ ...base, bridgeOptions: { origin: "human-ui" } }).author,
    ).toBeUndefined()
    const agentId = crypto.randomUUID()
    expect(
      bridgeKnowledgeActorInput({ ...base, auditActorType: "agent", bridgeActingAgentId: agentId })
        .author,
    ).toEqual({ type: "agent", agentId })
    expect(bridgeKnowledgeActorInput({ ...base, auditActorType: "mcp" }).author).toEqual({
      type: "agent",
      agentId: null,
    })
    expect(
      bridgeKnowledgeActorInput({ ...base, approvalContext: { approvalRequestId: "x" } }).author,
    ).toEqual({ type: "agent", agentId: null })
  })

  it("an agent author's id is stored", async () => {
    const doc = await create(alice)
    const agentId = crypto.randomUUID()
    await save(alice, doc.id, { body: "by agent" }, { author: { type: "agent", agentId } })
    const rows = await versions(doc.id)
    expect(rows.at(-1)).toMatchObject({ kind: "agent", author_type: "agent", agent_id: agentId })
  })
})

describe("review status follows real text changes only", () => {
  async function verified(): Promise<KnowledgeDocumentRow> {
    return create(alice, { verifyNow: true })
  }
  async function review(id: string) {
    const [row] = extractRows<{ review_status: string; review_reason: string | null }>(
      await privileged(sql`
        SELECT review_status, review_reason FROM ${K()}.documents WHERE id = ${id}::uuid`),
    )
    return row
  }

  it("a reviewDueAt-only patch keeps a page verified", async () => {
    const doc = await verified()
    expect((await review(doc.id))?.review_status).toBe("verified")
    await save(alice, doc.id, { reviewDueAt: new Date(Date.now() + 86_400_000).toISOString() })
    expect((await review(doc.id))?.review_status).toBe("verified")
  })

  it("re-sending the same title and body keeps a page verified", async () => {
    const doc = await verified()
    await save(alice, doc.id, { title: doc.title, body: doc.body, summary: doc.summary })
    expect((await review(doc.id))?.review_status).toBe("verified")
  })

  it("changing the body resets it, with the reason", async () => {
    const doc = await verified()
    await save(alice, doc.id, { body: "changed" })
    expect(await review(doc.id)).toEqual({
      review_status: "needs_review",
      review_reason: "content_changed",
    })
  })
})

describe("the Trash clock (documents_trash_guard)", () => {
  async function trashed(): Promise<string> {
    const doc = await create(alice)
    // As Trash will: archived and the clock started in one write.
    await privileged(sql`
      UPDATE ${K()}.documents SET archived_at = now(), trashed_at = now(), trashed_by = ${alice}::uuid
       WHERE id = ${doc.id}::uuid`)
    return doc.id
  }
  async function clock(id: string) {
    const [row] = extractRows<{
      archived: boolean
      trashed_at: string | null
      trashed_by: string | null
    }>(
      await privileged(sql`
        SELECT archived_at IS NOT NULL AS archived, trashed_at::text AS trashed_at,
               trashed_by::text AS trashed_by
          FROM ${K()}.documents WHERE id = ${id}::uuid`),
    )
    return row
  }

  it("a page trashed in one write keeps its clock", async () => {
    const id = await trashed()
    expect(await clock(id)).toMatchObject({ archived: true, trashed_by: alice })
    expect((await clock(id))?.trashed_at).not.toBeNull()
  })

  it("the previous release's restore clears it, and its re-archive starts none", async () => {
    const id = await trashed()
    // restoreKnowledgeDocument before Trash, verbatim.
    await withRlsContext(ctx(alice, [...WRITER, ARCHIVE]), (tx) =>
      tx.execute(sql`
        UPDATE ${knowledgeRel("documents")}
        SET archived_at = NULL, updated_by = ${alice}::uuid, updated_at = now()
        WHERE id = ${id}::uuid
          AND org_id = ${orgId}::uuid
          AND archived_at IS NOT NULL
        RETURNING id`),
    )
    expect(await clock(id)).toEqual({ archived: false, trashed_at: null, trashed_by: null })
    // archiveKnowledgeDocument before Trash, verbatim.
    await withRlsContext(ctx(alice, [...WRITER, ARCHIVE]), (tx) =>
      tx.execute(sql`
        UPDATE ${knowledgeRel("documents")}
        SET archived_at = now(), updated_by = ${alice}::uuid, updated_at = now()
        WHERE id = ${id}::uuid
          AND org_id = ${orgId}::uuid
          AND archived_at IS NULL
        RETURNING id`),
    )
    expect(await clock(id)).toEqual({ archived: true, trashed_at: null, trashed_by: null })
  })

  it("an archive by SQL that does not know the clock, of a page with an old one, starts none", async () => {
    const id = await trashed()
    // A raw un-archive that somehow kept the clock (no trigger then), then old code re-archives.
    // A raw write with the trigger asleep (session_replication_role = replica).
    await asOwner(`
      BEGIN;
      SET LOCAL session_replication_role = replica;
      UPDATE ${schemaRef("app_knowledge")}.documents SET archived_at = NULL WHERE id = '${id}';
      COMMIT;`)
    expect((await clock(id))?.trashed_at).not.toBeNull()
    await privileged(sql`UPDATE ${K()}.documents SET archived_at = now() WHERE id = ${id}::uuid`)
    expect(await clock(id)).toEqual({ archived: true, trashed_at: null, trashed_by: null })
  })

  it("a re-sync's un-archive clears it", async () => {
    const id = await trashed()
    // sync-reconciler's revive of an archived row sets archived_at alone.
    await privileged(sql`UPDATE ${K()}.documents SET archived_at = NULL WHERE id = ${id}::uuid`)
    expect(await clock(id)).toEqual({ archived: false, trashed_at: null, trashed_by: null })
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Trash (S19, D3, D4, A21, A23) on a real database, through the HTTP API and the job.
 *
 * - Moving a page to Trash starts its 30-day clock; restoring stops it. A page archived
 *   before Trash existed is listed as kept and never deleted automatically.
 * - The purge rule (K-R1) holds against the previous release's SQL, a re-sync and a
 *   missing trigger, and is checked again on the locked row: a restore that commits
 *   first wins.
 * - Synced pages never go to Trash.
 * - Delete for good: the edit right first (else the not-found of an unknown id), then
 *   the admin scope (K-R19).
 * - A purge leaves no row naming the page; one left rolls it back and raises an alert;
 *   the index entry and objects are checked after the commit (K-R12).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { app } from "~/app"
import manifest from "~/apps/knowledge/app.manifest.json"
import {
  checkTrashResidue,
  runTrashPurge,
  TRASH_DAYS,
  type TrashResidueJobPayload,
} from "~/apps/knowledge/trash"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { getDiagErrorState } from "~/lib/error-tracker"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { extendFullMemberRole, FULL_MEMBER_ROLE_NAME } from "~/modules/apps/runtime"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(120_000)

const READ = "knowledge:documents:read"
const CREATE = "knowledge:documents:create"
const UPDATE = "knowledge:documents:update"
const ARCHIVE = "knowledge:documents:archive"
const ADMIN = "knowledge:documents:admin"
const DAY = 24 * 60 * 60 * 1000

let orgId: string
let editor: minimal.Session
let other: minimal.Session
let viewer: minimal.Session
let admin: minimal.Session
let editorId: string
let otherId: string
let viewerId: string

const K = () => sql.raw(schemaRef("app_knowledge"))
const KS = () => sql.raw(schemaRef("kernel"))

async function personWith(name: string, scopes: string[]) {
  const p = await minimal.person(orgId, { name })
  for (const s of scopes) await minimal.grantScope(p.id, s)
  return { id: p.id, session: await minimal.sessionOf(p) }
}

beforeAll(async () => {
  await acquireTestLock()
  initializedOrgRuntimes.clear()
  orgId = (await createTestOrg()).id
  const e = await personWith("Editor", [READ, CREATE, UPDATE, ARCHIVE])
  const o = await personWith("Other", [READ, CREATE, UPDATE, ARCHIVE])
  const v = await personWith("Viewer", [READ, ARCHIVE])
  const a = await personWith("Admin", [READ, CREATE, UPDATE, ARCHIVE, ADMIN])
  editor = e.session
  editorId = e.id
  other = o.session
  otherId = o.id
  viewer = v.session
  viewerId = v.id
  admin = a.session
})
afterAll(releaseTestLock)

async function call(
  who: minimal.Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<{
  status: number
  text: string
  json: { data?: unknown; error?: { message: string } }
}> {
  const res = await app.request(`/api/knowledge${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.bearer}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, text, json: text ? JSON.parse(text) : {} }
}

async function page(who = editor, input: Record<string, unknown> = {}): Promise<string> {
  const res = await call(who, "POST", "/documents", {
    title: "Handbook",
    body: "start",
    documentScope: "organization",
    orgAccess: "editor",
    ...input,
  })
  expect(res.status).toBe(201)
  return (res.json.data as { id: string }).id
}

async function trash(id: string, who = editor): Promise<void> {
  const res = await call(who, "POST", `/documents/${id}/trash`)
  expect(res.status).toBe(200)
}

async function privileged(statement: ReturnType<typeof sql>) {
  return withPrivilegedDb(orgId, "test-trash", (tx) => tx.execute(statement))
}

interface Clock {
  exists: boolean
  archived: boolean
  trashed_at: string | null
  trashed_by: string | null
}
async function clock(id: string): Promise<Clock> {
  const [row] = extractRows<Omit<Clock, "exists">>(
    await privileged(sql`
      SELECT archived_at IS NOT NULL AS archived, trashed_at::text AS trashed_at,
             trashed_by::text AS trashed_by
        FROM ${K()}.documents WHERE id = ${id}::uuid`),
  )
  return row
    ? { exists: true, ...row }
    : { exists: false, archived: false, trashed_at: null, trashed_by: null }
}

/** The migration login, for writes the runtime roles cannot make (trigger asleep, DDL). */
function ownerUrl(): string {
  return (
    process.env.MIGRATION_DATABASE_URL ??
    `${(process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432").replace(/\/$/, "")}/${new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")}`
  )
}
async function asOwner(statement: string): Promise<void> {
  const owner = postgres(ownerUrl(), { max: 1, onnotice: () => {} })
  try {
    await owner.unsafe(statement)
  } finally {
    await owner.end()
  }
}
const KN = () => schemaRef("app_knowledge")

/** restoreKnowledgeDocument before Trash, verbatim, under the editor's row view. */
async function oldRestore(id: string): Promise<void> {
  const { withRlsContext } = await import("~/db/rls")
  await withRlsContext(
    {
      actorType: "user",
      orgId,
      userId: editorId,
      scopes: [READ, CREATE, UPDATE, ARCHIVE],
      dimensionGrants: {},
      roles: [],
    } as never,
    (tx) =>
      tx.execute(sql`
        UPDATE ${K()}.documents
        SET archived_at = NULL, updated_by = ${editorId}::uuid, updated_at = now()
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NOT NULL
        RETURNING id`),
  )
}
/** archiveKnowledgeDocument before Trash, verbatim. */
async function oldArchive(id: string): Promise<void> {
  const { withRlsContext } = await import("~/db/rls")
  await withRlsContext(
    {
      actorType: "user",
      orgId,
      userId: editorId,
      scopes: [READ, CREATE, UPDATE, ARCHIVE],
      dimensionGrants: {},
      roles: [],
    } as never,
    (tx) =>
      tx.execute(sql`
        UPDATE ${K()}.documents
        SET archived_at = now(), updated_by = ${editorId}::uuid, updated_at = now()
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NULL
        RETURNING id`),
  )
}

const later = (days: number, ms = 0) => ({ now: new Date(Date.now() + days * DAY + ms) })

interface Entry {
  id: string
  daysLeft: number | null
  trashedAt: string | null
  trashedBy: string | null
}
async function trashList(who = editor): Promise<Entry[]> {
  const res = await call(who, "GET", "/trash")
  expect(res.status).toBe(200)
  return res.json.data as Entry[]
}

/** A shared folder holding the page (as the folder tree files it). */
async function folderWith(name: string, ...ids: string[]): Promise<string> {
  const [folder] = extractRows<{ id: string }>(
    await privileged(sql`
      INSERT INTO ${K()}.collections (org_id, name) VALUES (${orgId}::uuid, ${name})
      RETURNING id::text AS id`),
  )
  for (const id of ids) {
    await privileged(sql`
      INSERT INTO ${K()}.collection_memberships (org_id, collection_id, target_type, target_id)
      VALUES (${orgId}::uuid, ${folder?.id}::uuid, 'document', ${id}::uuid)`)
  }
  return folder?.id ?? ""
}

async function syncedSource(): Promise<string> {
  const [folder] = extractRows<{ id: string }>(
    await privileged(sql`
      INSERT INTO ${K()}.collections (org_id, name) VALUES (${orgId}::uuid, 'Drive root')
      RETURNING id::text AS id`),
  )
  const [src] = extractRows<{ id: string }>(
    await privileged(sql`
      INSERT INTO ${K()}.synced_sources
        (org_id, app_name, folder_ref, display_name, root_collection_id, created_by, default_sensitivity)
      VALUES (${orgId}::uuid, 'google-drive', ${`f-${crypto.randomUUID()}`}, 'Drive',
              ${folder?.id}::uuid, ${editorId}::uuid, 'internal')
      RETURNING id::text AS id`),
  )
  return src?.id ?? ""
}

describe("Move to trash and restore", () => {
  it("moving to Trash starts the clock, lists it with 30 days, and restoring stops it", async () => {
    const id = await page()
    await trash(id)
    const c = await clock(id)
    expect(c).toMatchObject({ archived: true, trashed_by: editorId })
    expect(c.trashed_at).not.toBeNull()
    const entry = (await trashList()).find((e) => e.id === id)
    expect(entry).toMatchObject({ daysLeft: TRASH_DAYS, trashedBy: editorId })
    const one = await call(editor, "GET", `/trash/${id}`)
    expect(one.status).toBe(200)
    expect(await call(editor, "POST", `/documents/${id}/restore`)).toMatchObject({ status: 200 })
    expect(await clock(id)).toEqual({
      exists: true,
      archived: false,
      trashed_at: null,
      trashed_by: null,
    })
    expect((await trashList()).some((e) => e.id === id)).toBe(false)
  })

  it("archived before Trash: listed with no days, survives a purge run 400 days later", async () => {
    const id = await page()
    await oldArchive(id)
    const entry = (await trashList()).find((e) => e.id === id)
    expect(entry).toMatchObject({ daysLeft: null, trashedAt: null, trashedBy: null })
    await runTrashPurge({ ...later(400), schedule: async () => {} })
    expect((await clock(id)).exists).toBe(true)
  })

  it("viewer sees nothing in Trash and is refused with a message", async () => {
    const id = await page(editor, { orgAccess: "viewer" })
    expect((await call(viewer, "POST", `/documents/${id}/trash`)).status).toBe(404)
    await trash(id)
    expect((await trashList(viewer)).some((e) => e.id === id)).toBe(false)
    const one = await call(viewer, "GET", `/trash/${id}`)
    expect(one.status).toBe(404)
    const refused = await call(viewer, "POST", `/documents/${id}/restore`)
    expect(refused.status).toBe(404)
    expect(refused.json.error?.message).toBeTruthy()
    expect((await clock(id)).archived).toBe(true)
  })

  it("restored page is searchable again and in its folder", async () => {
    const id = await page()
    const folderId = await folderWith("Policies", id)
    await trash(id)
    await call(editor, "POST", `/documents/${id}/restore`)
    const events = extractRows<{ action: string }>(
      await privileged(sql`
        SELECT payload->>'action' AS action FROM ${KS()}.pending_events
         WHERE org_id = ${orgId}::uuid AND payload->>'entityId' = ${id}
           AND payload->>'app' = 'knowledge' AND payload->>'entity' = 'document'
         ORDER BY seq`),
    )
    // archive drops it from the index, restore upserts it again (search/indexer.ts).
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["archive", "restore"]))
    expect(events.map((e) => e.action).lastIndexOf("restore")).toBeGreaterThan(
      events.map((e) => e.action).lastIndexOf("archive"),
    )
    const [m] = extractRows<{ n: number }>(
      await privileged(sql`
        SELECT count(*)::int AS n FROM ${K()}.collection_memberships
         WHERE target_id = ${id}::uuid AND collection_id = ${folderId}::uuid`),
    )
    expect(m?.n).toBe(1)
  })
})

describe("the purge rule against other writers (K-R1), each at +31 days", () => {
  const purge31 = () => runTrashPurge({ ...later(31), schedule: async () => {} })

  it("trashed, then un-archived by the previous release's restore: still there", async () => {
    const id = await page()
    await trash(id)
    await oldRestore(id)
    await purge31()
    expect(await clock(id)).toMatchObject({ exists: true, archived: false })
  })

  it("then re-archived by the previous release: still there, listed with no days", async () => {
    const id = await page()
    await trash(id)
    await oldRestore(id)
    await oldArchive(id)
    await purge31()
    expect(await clock(id)).toMatchObject({ exists: true, archived: true, trashed_at: null })
    expect((await trashList()).find((e) => e.id === id)?.daysLeft).toBeNull()
  })

  it("trashed, then un-archived by a re-sync's SQL: still there", async () => {
    const id = await page()
    await trash(id)
    await privileged(sql`UPDATE ${K()}.documents SET archived_at = NULL, updated_at = now()
                          WHERE id = ${id}::uuid`)
    await purge31()
    expect(await clock(id)).toMatchObject({ exists: true, archived: false })
  })

  it("the same three with the trigger asleep: still there (the rule alone)", async () => {
    const restored = await page()
    const rearchived = await page()
    const resynced = await page()
    for (const id of [restored, rearchived, resynced]) await trash(id)
    const replica = (stmt: string) =>
      asOwner(`BEGIN; SET LOCAL session_replication_role = replica; ${stmt}; COMMIT;`)
    await replica(`UPDATE ${KN()}.documents SET archived_at = NULL WHERE id = '${restored}'`)
    await replica(`UPDATE ${KN()}.documents SET archived_at = NULL WHERE id = '${rearchived}'`)
    // Old re-archive a second later: archived_at is newer than the stale clock.
    await replica(
      `UPDATE ${KN()}.documents SET archived_at = now() + interval '1 second' WHERE id = '${rearchived}'`,
    )
    await replica(`UPDATE ${KN()}.documents SET archived_at = NULL WHERE id = '${resynced}'`)
    expect((await clock(restored)).trashed_at).not.toBeNull()
    expect((await clock(rearchived)).trashed_at).not.toBeNull()
    await purge31()
    for (const id of [restored, rearchived, resynced]) expect((await clock(id)).exists).toBe(true)
  })

  it("a restore committing between the job's select and its delete wins", async () => {
    const id = await page()
    await trash(id)
    const owner = postgres(ownerUrl(), { max: 1, onnotice: () => {} })
    let commit: () => void = () => {}
    let restoring: Promise<unknown> = Promise.resolve()
    try {
      const report = await runTrashPurge({
        ...later(31),
        schedule: async () => {},
        afterSelect: async (_org, ids) => {
          if (!ids.includes(id)) return
          // The restore holds the row while the purge reaches for it, then commits.
          let updated: () => void = () => {}
          const ready = new Promise<void>((r) => {
            updated = r
          })
          restoring = owner.begin(async (t) => {
            // The trigger asleep: the stale clock stays, so only the rule re-checked on
            // the locked row can see the page left Trash.
            await t.unsafe("SET LOCAL session_replication_role = replica")
            await t.unsafe(`UPDATE ${KN()}.documents SET archived_at = NULL WHERE id = '${id}'`)
            updated()
            await new Promise<void>((r) => {
              commit = r
            })
          })
          await ready
          setTimeout(() => commit(), 300)
        },
      })
      await restoring
      expect(report.purged).not.toContain(id)
      expect(await clock(id)).toMatchObject({ exists: true, archived: false })
    } finally {
      commit()
      await restoring.catch(() => {})
      await owner.end()
    }
  })

  it("30 days and 1 s in Trash is purged, 29 days is kept", async () => {
    const old = await page()
    const young = await page()
    await trash(old)
    await trash(young)
    await privileged(sql`
      UPDATE ${K()}.documents
         SET archived_at = archived_at - interval '30 days 1 second',
             trashed_at = trashed_at - interval '30 days 1 second'
       WHERE id = ${old}::uuid`)
    await privileged(sql`
      UPDATE ${K()}.documents
         SET archived_at = archived_at - interval '29 days',
             trashed_at = trashed_at - interval '29 days'
       WHERE id = ${young}::uuid`)
    expect((await trashList()).find((e) => e.id === young)?.daysLeft).toBe(1)
    const report = await runTrashPurge({ schedule: async () => {} })
    expect(report.purged).toContain(old)
    expect((await clock(old)).exists).toBe(false)
    expect((await clock(young)).exists).toBe(true)
  })

  it("agent archive starts the clock", async () => {
    const id = await page(editor, { orgAccess: "none" })
    const perms = await withPrivilegedDb(orgId, "test-perms", (tx) =>
      loadEffectivePermissions(tx, editorId, orgId),
    )
    const res = await executeTool<{ id?: string; archivedAt?: string | null }>({
      toolName: "knowledge:archive",
      orgId,
      actor: {
        actorType: "user",
        orgId,
        userId: editorId,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
        roles: perms.roles,
      },
      params: { id },
      threadId: await minimal.thread(orgId, editorId, { title: "tidy" }),
      origin: "in-app-agent",
      stepBundleId: null,
      approvalContext: { approvalId: crypto.randomUUID(), approvedBy: editorId },
    } as never)
    expect((res.data as { id?: string })?.id ?? id).toBe(id)
    const c = await clock(id)
    expect(c).toMatchObject({ archived: true, trashed_by: editorId })
    expect(c.trashed_at).not.toBeNull()
  })
})

describe("synced pages never go to Trash (edge 6, A21)", () => {
  async function syncedPage(): Promise<string> {
    const id = await page()
    const src = await syncedSource()
    const [identity] = extractRows<{ id: string }>(
      await privileged(sql`
        INSERT INTO ${K()}.source_identities (org_id, source, external_id)
        VALUES (${orgId}::uuid, 'google-drive', ${`file-${id}`}) RETURNING id::text AS id`),
    )
    await privileged(sql`UPDATE ${K()}.documents
                            SET synced_source_id = ${src}::uuid, source_identity_id = ${identity?.id}::uuid, revision = 0
                          WHERE id = ${id}::uuid`)
    return id
  }

  it("trash is refused by the route and the tool; the page is untouched", async () => {
    const id = await syncedPage()
    const route = await call(editor, "POST", `/documents/${id}/trash`)
    expect(route.status).toBe(400)
    expect(route.json.error?.message).toMatch(/synced/i)
    const legacy = await call(editor, "POST", `/documents/${id}/archive`)
    expect(legacy.status).toBe(400)
    const perms = await withPrivilegedDb(orgId, "test-perms", (tx) =>
      loadEffectivePermissions(tx, editorId, orgId),
    )
    const tool = await executeTool({
      toolName: "knowledge:archive",
      orgId,
      actor: {
        actorType: "user",
        orgId,
        userId: editorId,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
        roles: perms.roles,
      },
      params: { id },
      threadId: await minimal.thread(orgId, editorId, { title: "synced" }),
      origin: "in-app-agent",
      stepBundleId: null,
      approvalContext: { approvalId: crypto.randomUUID(), approvedBy: editorId },
    } as never).catch((err: Error) => ({ error: err.message }))
    expect(JSON.stringify(tool)).toMatch(/synced/i)
    expect(await clock(id)).toMatchObject({ exists: true, archived: false, trashed_at: null })
  })

  it("a synced page archived by the previous release is not in Trash and not purged", async () => {
    const id = await syncedPage()
    // Even a clock planted with the trigger asleep does not make it purgeable.
    await asOwner(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE ${KN()}.documents SET archived_at = now() - interval '40 days',
             trashed_at = now() - interval '40 days' WHERE id = '${id}'; COMMIT;`)
    expect((await trashList()).some((e) => e.id === id)).toBe(false)
    await runTrashPurge({ schedule: async () => {} })
    expect((await clock(id)).exists).toBe(true)
    const del = await call(admin, "DELETE", `/documents/${id}`)
    expect(del.status).not.toBe(200)
    expect((await clock(id)).exists).toBe(true)
  })
})

describe("delete for good (A23, K-R19)", () => {
  it("admin, another person's private page in Trash: 404 like an unknown id, row stays", async () => {
    const id = await page(other, { orgAccess: "none" })
    await trash(id, other)
    const res = await call(admin, "DELETE", `/documents/${id}`)
    const unknown = await call(admin, "DELETE", `/documents/${crypto.randomUUID()}`)
    expect(res.status).toBe(404)
    expect(res.text).toBe(unknown.text)
    expect((await clock(id)).exists).toBe(true)
  })

  it("admin, another person's page shared to read only, in Trash: 404 like an unknown id", async () => {
    const id = await page(other, { orgAccess: "viewer" })
    await trash(id, other)
    const res = await call(admin, "DELETE", `/documents/${id}`)
    const unknown = await call(admin, "DELETE", `/documents/${crypto.randomUUID()}`)
    expect(res.status).toBe(404)
    expect(res.text).toBe(unknown.text)
    expect((await clock(id)).exists).toBe(true)
  })

  it("a restore committing while the delete waits for the row wins: nothing deleted", async () => {
    const id = await page()
    await trash(id)
    const { deleteForGood } = await import("~/apps/knowledge/trash")
    const owner = postgres(ownerUrl(), { max: 1, onnotice: () => {} })
    let commit: () => void = () => {}
    let updated: () => void = () => {}
    const ready = new Promise<void>((r) => {
      updated = r
    })
    const restoring = owner.begin(async (t) => {
      // A restore that does not know the clock (trigger asleep): the rule re-checked
      // on the locked row is all that stands between it and the delete.
      await t.unsafe("SET LOCAL session_replication_role = replica")
      await t.unsafe(`UPDATE ${KN()}.documents SET archived_at = NULL WHERE id = '${id}'`)
      updated()
      await new Promise<void>((r) => {
        commit = r
      })
    })
    try {
      await ready
      setTimeout(() => commit(), 300)
      expect(await deleteForGood(orgId, id, editorId)).toBe(false)
      await restoring
      expect(await clock(id)).toMatchObject({ exists: true, archived: false })
    } finally {
      commit()
      await restoring.catch(() => {})
      await owner.end()
    }
  })

  it("admin who can edit it: deleted", async () => {
    const id = await page()
    await trash(id)
    const res = await call(admin, "DELETE", `/documents/${id}`)
    expect(res.status).toBe(200)
    expect((await clock(id)).exists).toBe(false)
  })

  it("member without admin: refused with a message, row stays", async () => {
    const id = await page()
    await trash(id)
    const res = await call(editor, "DELETE", `/documents/${id}`)
    expect(res.status).toBe(403)
    expect(res.json.error?.message).toMatch(/administrator/i)
    expect((await clock(id)).exists).toBe(true)
  })

  it("a page not in Trash, or archived before Trash, is refused until it is trashed", async () => {
    const live = await page()
    const live404 = await call(admin, "DELETE", `/documents/${live}`)
    expect(live404.status).toBe(400)
    const kept = await page()
    await oldArchive(kept)
    const res = await call(admin, "DELETE", `/documents/${kept}`)
    expect(res.status).toBe(400)
    expect(res.json.error?.message).toMatch(/restore it and move it to Trash/i)
    expect((await clock(kept)).exists).toBe(true)
    await call(admin, "POST", `/documents/${kept}/restore`)
    await trash(kept, admin)
    expect((await call(admin, "DELETE", `/documents/${kept}`)).status).toBe(200)
    expect((await clock(kept)).exists).toBe(false)
  })
})

/** Every row naming the page, by table; the purge leaves all at 0. */
async function residue(id: string): Promise<Record<string, number>> {
  const [row] = extractRows<Record<string, number>>(
    await privileged(sql`
      SELECT
        (SELECT count(*)::int FROM ${K()}.documents WHERE id = ${id}::uuid) AS documents,
        (SELECT count(*)::int FROM ${K()}.document_versions WHERE document_id = ${id}::uuid) AS versions,
        (SELECT count(*)::int FROM ${K()}.document_links
          WHERE source_document_id = ${id}::uuid OR target_document_id = ${id}::uuid) AS links,
        (SELECT count(*)::int FROM ${K()}.collection_memberships WHERE target_id = ${id}::uuid) AS memberships,
        (SELECT count(*)::int FROM ${K()}.taggings WHERE target_id = ${id}::uuid) AS taggings,
        (SELECT count(*)::int FROM ${K()}.collections WHERE index_document_id = ${id}::uuid) AS folder_pages,
        (SELECT count(*)::int FROM ${KS()}.resource_grants WHERE resource_id = ${id}::uuid) AS shares,
        (SELECT count(*)::int FROM ${KS()}.thread_references WHERE entity_id = ${id}) AS thread_refs,
        (SELECT count(*)::int FROM ${KS()}.attention_events WHERE entity_id = ${id}) AS attention,
        (SELECT count(*)::int FROM ${KS()}.files WHERE entity_id = ${id}) AS files`),
  )
  return row ?? {}
}

describe("the purge removes everything (S19, K-R12)", () => {
  it("leaves 0 rows for a page with versions, files, links, shares, tags and two folders; objects queued", async () => {
    const id = await page()
    const f1 = { id: await folderWith("One", id) }
    await folderWith("Two", id)
    const neighbour = await page()
    const doc = (await call(editor, "GET", `/documents/${id}`)).json.data as { revision: number }
    await call(editor, "PATCH", `/documents/${id}`, { revision: doc.revision, body: "second" })
    const [file] = extractRows<{ id: string }>(
      await privileged(sql`
        INSERT INTO ${KS()}.files (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, thumbnail_key)
        VALUES (${orgId}::uuid, 'knowledge', 'document', ${id}, 'shot.png', 'image/png', 10,
                ${`${orgId}/trash-test/${id}.png`}, ${`${orgId}/trash-test/${id}.thumb.png`})
        RETURNING id::text AS id`),
    )
    const [tag] = extractRows<{ id: string }>(
      await privileged(sql`
        INSERT INTO ${K()}.tags (org_id, name, normalized_name)
        VALUES (${orgId}::uuid, ${`t-${id}`}, ${`t-${id}`}) RETURNING id::text AS id`),
    )
    const thread = await minimal.thread(orgId, editorId, { title: "refs" })
    await privileged(sql`
      INSERT INTO ${K()}.taggings (org_id, tag_id, target_type, target_id)
      VALUES (${orgId}::uuid, ${tag?.id}::uuid, 'document', ${id}::uuid)`)
    await privileged(sql`
      INSERT INTO ${K()}.document_links (org_id, source_document_id, target_document_id)
      VALUES (${orgId}::uuid, ${id}::uuid, ${neighbour}::uuid),
             (${orgId}::uuid, ${neighbour}::uuid, ${id}::uuid)`)
    await privileged(sql`
      INSERT INTO ${KS()}.resource_grants (org_id, resource_type, resource_id, grantee_kind, grantee, role)
      VALUES (${orgId}::uuid, 'knowledge.document', ${id}::uuid, 'user', ${viewerId}, 'viewer')`)
    await privileged(sql`
      INSERT INTO ${KS()}.thread_references (thread_id, app, entity_type, entity_id, added_by, org_id)
      VALUES (${thread}::uuid, 'knowledge', 'document', ${id}, ${editorId}::uuid, ${orgId}::uuid)`)
    await privileged(sql`
      INSERT INTO ${KS()}.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_type, occurred_at, digest_eligible_at)
      VALUES (${orgId}::uuid, ${editorId}::uuid, 'knowledge', 'document', ${id}, 'knowledge_review', 1,
              'Review', 'system', now(), now())`)
    await privileged(sql`
      UPDATE ${K()}.collections SET index_document_id = ${id}::uuid WHERE id = ${f1.id}::uuid`)
    const before = await residue(id)
    for (const k of [
      "versions",
      "links",
      "memberships",
      "taggings",
      "shares",
      "files",
      "thread_refs",
    ]) {
      expect(before[k]).toBeGreaterThan(0)
    }

    await trash(id)
    await privileged(sql`
      UPDATE ${K()}.documents SET archived_at = archived_at - interval '31 days',
             trashed_at = trashed_at - interval '31 days' WHERE id = ${id}::uuid`)
    const scheduled: TrashResidueJobPayload[] = []
    const report = await runTrashPurge({ schedule: async (p) => void scheduled.push(p) })
    expect(report.purged).toContain(id)
    expect(Object.values(await residue(id)).every((n) => n === 0)).toBe(true)
    // The neighbour itself stays; only the link rows naming the page went.
    expect((await clock(neighbour)).exists).toBe(true)
    // Objects: the kernel file delete event (the object goes after the commit) and the
    // residue check ten minutes on, naming both keys.
    const fileEvents = extractRows<{ key: string }>(
      await privileged(sql`
        SELECT payload->'data'->>'storageKey' AS key FROM ${KS()}.pending_events
         WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'file'
           AND payload->>'action' = 'delete' AND payload->>'entityId' = ${file?.id}`),
    )
    expect(fileEvents.map((e) => e.key)).toEqual([`${orgId}/trash-test/${id}.png`])
    const check = scheduled.find((p) => p.documentId === id)
    expect(check).toMatchObject({ attempt: 1, orgId })
    expect(check?.files[0]).toMatchObject({
      id: file?.id,
      storageKey: `${orgId}/trash-test/${id}.png`,
      thumbnailKey: `${orgId}/trash-test/${id}.thumb.png`,
    })
    const docEvents = extractRows<{ n: number }>(
      await privileged(sql`
        SELECT count(*)::int AS n FROM ${KS()}.pending_events
         WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'knowledge'
           AND payload->>'entity' = 'document' AND payload->>'action' = 'delete'
           AND payload->>'entityId' = ${id}`),
    )
    expect(docEvents[0]?.n).toBe(1)
  })

  it("a page linking to a purged page and showing its image keeps its body byte-equal", async () => {
    const target = await page()
    const fileId = crypto.randomUUID()
    const body = `See [](knowledge:document:${target}) and ![](liaison-file:${fileId})\n`
    const source = await page(editor, { body })
    await trash(target)
    await privileged(sql`
      UPDATE ${K()}.documents SET archived_at = archived_at - interval '31 days',
             trashed_at = trashed_at - interval '31 days' WHERE id = ${target}::uuid`)
    await runTrashPurge({ schedule: async () => {} })
    expect((await clock(target)).exists).toBe(false)
    const [row] = extractRows<{ body: string }>(
      await privileged(sql`SELECT body FROM ${K()}.documents WHERE id = ${source}::uuid`),
    )
    const stored = (await call(editor, "GET", `/documents/${source}`)).json.data as { body: string }
    expect(row?.body).toBe(stored.body)
    expect(stored.body).toContain(`knowledge:document:${target}`)
    expect(stored.body).toContain(fileId)
  })

  it("a row the purge forgets rolls it back: the page stays in Trash and an alert is raised", async () => {
    const id = await page()
    const keeper = await page()
    await trash(id)
    await privileged(sql`
      UPDATE ${K()}.documents SET archived_at = archived_at - interval '31 days',
             trashed_at = trashed_at - interval '31 days' WHERE id = ${id}::uuid`)
    // Something the purge does not know writes a row naming the page as it goes.
    const fn = `${KN()}.trash_test_plant_${id.replaceAll("-", "")}`
    await asOwner(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        INSERT INTO ${KN()}.document_links (org_id, source_document_id, target_document_id)
        VALUES (OLD.org_id, '${keeper}', OLD.id);
        RETURN OLD;
      END $f$;
      CREATE TRIGGER trash_test_plant AFTER DELETE ON ${KN()}.documents
        FOR EACH ROW WHEN (OLD.id = '${id}') EXECUTE FUNCTION ${fn}();`)
    try {
      const report = await runTrashPurge({ schedule: async () => {} })
      expect(report.failed).toContain(id)
      expect(report.purged).not.toContain(id)
    } finally {
      await asOwner(`DROP TRIGGER trash_test_plant ON ${KN()}.documents; DROP FUNCTION ${fn}();`)
    }
    expect(await clock(id)).toMatchObject({ exists: true, archived: true })
    expect((await trashList()).find((e) => e.id === id)?.daysLeft).toBe(0)
    expect(
      getDiagErrorState().errorSignatures.some((s) => s.signature.startsWith("PurgeResidueError")),
    ).toBe(true)
  })
})

describe("after the commit: index entry and objects (K-R12)", () => {
  const payload = (attempt: number): TrashResidueJobPayload => ({
    orgId,
    documentId: crypto.randomUUID(),
    files: [{ id: crypto.randomUUID(), storageKey: "k1", thumbnailKey: "k1.thumb" }],
    attempt,
  })

  it("gone: silent, nothing re-queued", async () => {
    const calls: string[] = []
    const r = await checkTrashResidue(payload(1), {
      searchHas: async () => false,
      objectExists: async () => false,
      removeFromIndex: async () => void calls.push("index"),
      removeObjects: async () => void calls.push("objects"),
      schedule: async () => void calls.push("schedule"),
    })
    expect(r).toEqual({ index: false, objects: [] })
    expect(calls).toEqual([])
  })

  it("still there: re-queued and checked again; the third miss raises the alert", async () => {
    const calls: string[] = []
    const next: TrashResidueJobPayload[] = []
    const deps = {
      searchHas: async () => true,
      objectExists: async (k: string) => k === "k1.thumb",
      removeFromIndex: async () => void calls.push("index"),
      removeObjects: async (_o: string, files: { id: string }[]) =>
        void calls.push(`objects:${files.length}`),
      schedule: async (p: TrashResidueJobPayload) => void next.push(p),
    }
    const first = payload(1)
    expect(await checkTrashResidue(first, deps)).toEqual({ index: true, objects: ["k1.thumb"] })
    expect(calls).toEqual(["index", "objects:1"])
    expect(next[0]).toMatchObject({ documentId: first.documentId, attempt: 2 })
    const before = getDiagErrorState().errorSignatures.length
    await checkTrashResidue({ ...first, attempt: 3 }, deps)
    expect(next).toHaveLength(1)
    expect(
      getDiagErrorState().errorSignatures.some((s) => s.signature.includes("purge residue")),
    ).toBe(true)
    expect(getDiagErrorState().errorSignatures.length).toBeGreaterThanOrEqual(before)
  })
})

describe("members of an org registered before Trash (S1)", () => {
  it("a Full Member trashes and restores a page they can edit, by route and agent tool", async () => {
    const p = await minimal.person(orgId, { name: "Full Member" })
    await minimal.assignRole(p.id, FULL_MEMBER_ROLE_NAME)
    // The org was registered before: its Full Member role lacks the archive scope...
    await privileged(sql`
      DELETE FROM ${KS()}.role_scope_grants g USING ${KS()}.roles r
       WHERE g.role_id = r.id AND r.org_id = ${orgId}::uuid AND r.name = ${FULL_MEMBER_ROLE_NAME}
         AND g.scope = ${ARCHIVE}`)
    // ...until the next registration extends it from the manifest.
    await withPrivilegedDb(orgId, "test-extend", (tx) =>
      extendFullMemberRole(tx, orgId, manifest.roles as never),
    )
    const member = await minimal.sessionOf(p)
    const id = await page(member)
    const trashed = await call(member, "POST", `/documents/${id}/trash`)
    expect(trashed.status).toBe(200)
    expect((await trashList(member)).some((e) => e.id === id)).toBe(true)
    const perms = await withPrivilegedDb(orgId, "test-perms", (tx) =>
      loadEffectivePermissions(tx, p.id, orgId),
    )
    expect(perms.scopes).toContain(ARCHIVE)
    await executeTool({
      toolName: "knowledge:restore",
      orgId,
      actor: {
        actorType: "user",
        orgId,
        userId: p.id,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
        roles: perms.roles,
      },
      params: { id },
      threadId: await minimal.thread(orgId, p.id, { title: "restore" }),
      origin: "in-app-agent",
      stepBundleId: null,
    } as never)
    expect(await clock(id)).toMatchObject({ exists: true, archived: false, trashed_at: null })
    await trash(id, member)
    expect((await call(member, "POST", `/documents/${id}/restore`)).status).toBe(200)
    expect((await clock(id)).archived).toBe(false)
    // A viewer of it is refused with a message.
    const refused = await call(viewer, "POST", `/documents/${id}/trash`)
    expect(refused.status).toBe(404)
    expect(refused.json.error?.message).toMatch(/cannot/i)
    void otherId
  })
})

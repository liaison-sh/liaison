// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge import kinds: `knowledge.collection` and `knowledge.document`,
// written through the knowledge service (sensitivity → org_access default,
// dimension ladder, owner rules), deduplicated by external ref, tags reused
// without being touched, attachments resolved under the person's RLS (A9),
// and undone without touching anything the run did not create.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { runImport } from "~/modules/imports/runner"
import type { SourceItem } from "~/modules/imports/source"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { documentId } from "~/modules/search/document-id"
import { LiveIndexTestAccess, resolveLiveIndexItems } from "~/modules/search/live-index-queue"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let otherOrgId = ""
let adminId = ""
let colleagueId = ""
let colleagueEmail = ""
let otherAdminId = ""
const tmpDirs: string[] = []
const tag = () => crypto.randomUUID().slice(0, 8)

function admin(): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

function recordsOf(records: Array<Record<string, unknown>>): {
  type: "records"
  records: SourceItem[]
} {
  return { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) }
}

function importDocs(
  records: Array<Record<string, unknown>>,
  label: string,
  actor: UserContext = admin(),
) {
  return runImport({
    orgId,
    actor,
    kinds: ["knowledge.document"],
    source: recordsOf(records),
    sourceLabel: label,
    mode: "cli",
  })
}

async function doc(label: string, ref: string) {
  const [row] = await sql`
    SELECT id, title, org_access, sensitivity, document_scope, owner_user_id, created_by
    FROM app_knowledge.documents WHERE org_id = ${orgId} AND external_ref = ${`${label}:${ref}`}`
  return row
}

/** A file only `ownerId` can see (uploaded to a thread they alone are in). */
async function uploadedFile(inOrg: string, ownerId: string): Promise<string> {
  const fileId = crypto.randomUUID()
  const storageKey = `${inOrg}/knowledge-import-test/${fileId}.txt`
  await putObject({ key: storageKey, body: Buffer.from("manual"), contentType: "text/plain" })
  await withPrivilegedDb(inOrg, "t", async (tx) => {
    const threadId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${threadId}::uuid, ${inOrg}::uuid, ${`kimp-${threadId.slice(0, 8)}`}, 'upload', ${ownerId}::uuid)
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}::uuid, ${ownerId}::uuid, ${inOrg}::uuid, 'owner')
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                size_bytes, storage_key, uploaded_by)
      VALUES (${fileId}::uuid, ${inOrg}::uuid, 'kernel', 'thread', ${threadId}, 'manual.txt',
              'text/plain', 6, ${storageKey}, ${ownerId}::uuid)
    `)
  })
  return fileId
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-kn-${tag()}`, name: "Knowledge Import" })).orgId
  otherOrgId = (await ensureOrg({ slug: `imp-kn2-${tag()}`, name: "Knowledge Import B" })).orgId
  const mk = async (org: string, role: "admin" | "member", email: string) =>
    (await ensureUser({ orgId: org, email, name: role, password: "pw-import-1!", role })).userId
  adminId = await mk(orgId, "admin", `owner-${tag()}@fabrikam.example`)
  colleagueEmail = `colleague-${tag()}@fabrikam.example`
  colleagueId = await mk(orgId, "member", colleagueEmail)
  otherAdminId = await mk(otherOrgId, "admin", `owner-${tag()}@contoso.example`)
  // The knowledge file parent is registered with the org's apps.
  await ensureAppsForOrg(orgId)
  await rebuildFilesSelectPolicy()
}, 300_000)

afterAll(async () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  await releaseTestLock()
})

describe("knowledge.document", () => {
  it("applies the sensitivity → org_access default and dedups by external ref", async () => {
    const label = `kd${tag()}`
    const recs = [
      { externalRef: "conf", title: "Board minutes", body: "Secret", sensitivity: "confidential" },
      { externalRef: "int", title: "Onboarding", body: "Welcome", sensitivity: "internal" },
    ]
    const first = await importDocs(recs, label)
    expect(first.counts["knowledge.document"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect((await doc(label, "conf"))!.org_access).toBe("none")
    expect((await doc(label, "int"))!.org_access).toBe("editor")
    const again = await importDocs(recs, label)
    expect(again.counts["knowledge.document"]).toEqual({ created: 0, skipped: 2, failed: 0 })
  })

  it("reuses an existing tag without touching it and creates the missing one", async () => {
    const label = `kt${tag()}`
    const existingName = `Firmware ${tag()}`
    const [existing] = await sql`
      INSERT INTO app_knowledge.tags (org_id, name, normalized_name, updated_at)
      VALUES (${orgId}, ${existingName}, ${existingName.toLowerCase()}, now() - interval '2 days')
      RETURNING id, updated_at`
    const freshName = `Release ${tag()}`
    const run = await importDocs(
      [{ externalRef: "t1", title: "Notes", body: "x", tagNames: [existingName, freshName] }],
      label,
    )
    expect(run.counts["knowledge.document"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [after] = await sql`SELECT updated_at FROM app_knowledge.tags WHERE id = ${existing!.id}`
    expect(after!.updated_at).toEqual(existing!.updated_at)
    const tags = await sql`
      SELECT t.name FROM app_knowledge.taggings g JOIN app_knowledge.tags t ON t.id = g.tag_id
      WHERE g.org_id = ${orgId} AND g.target_id = ${(await doc(label, "t1"))!.id} ORDER BY t.name`
    expect(tags.map((t) => t.name).sort()).toEqual([existingName, freshName].sort())
  })

  it("a personal document belongs to the person the record names", async () => {
    const label = `kp${tag()}`
    const run = await importDocs(
      [
        {
          externalRef: "p1",
          title: "My notes",
          body: "Private",
          documentScope: "personal",
          ownerEmail: colleagueEmail.toUpperCase(),
        },
      ],
      label,
    )
    expect(run.counts["knowledge.document"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const row = (await doc(label, "p1"))!
    expect([row.document_scope, row.owner_user_id]).toEqual(["personal", colleagueId])
  })

  it("refuses a sensitivity outside the person's grant (out_of_scope), allows one inside", async () => {
    const label = `ks${tag()}`
    const limited: UserContext = {
      actorType: "user",
      userId: adminId,
      orgId,
      scopes: ["knowledge:documents:create"],
      dimensionGrants: { "knowledge:sensitivity": ["internal"] },
    }
    const run = await importDocs(
      [
        { externalRef: "r", title: "Payroll", body: "x", sensitivity: "restricted" },
        { externalRef: "i", title: "Handbook", body: "x", sensitivity: "internal" },
        { externalRef: "tg", title: "Tagged", body: "x", tagNames: ["needs-scope"] },
      ],
      label,
      limited,
    )
    expect(run.counts["knowledge.document"]).toEqual({ created: 1, skipped: 0, failed: 2 })
    expect(run.errors.map((e) => String(e.error))).toEqual([
      expect.stringMatching(/^out_of_scope: /),
      expect.stringMatching(/^out_of_scope: .*knowledge:tags:manage/),
    ])
    expect(await doc(label, "r")).toBeUndefined()
  })

  it("creates, never redirects onto a routine's running doc, even inside a routine tick", async () => {
    const label = `kr${tag()}`
    const seed = await importDocs(
      [{ externalRef: "bound", title: "Running doc", body: "v1" }],
      label,
    )
    expect(seed.counts["knowledge.document"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const bound = (await doc(label, "bound"))!
    const [routine] = await sql`
      INSERT INTO kernel.routines (org_id, owner_user_id, name, description, kind, cron, timezone,
                                   prompt, scopes, created_by_actor_type)
      VALUES (${orgId}, ${adminId}, ${`watch ${label}`}, 'watch', 'recurring', '0 9 * * 1', 'UTC',
              ${`Digest. MAINTAIN THIS EXISTING RUNNING DOC "Running doc" id ${bound.id}`},
              '{}', 'user')
      RETURNING id`
    const run = await runContextStore.run(
      {
        runId: crypto.randomUUID(),
        parentRunId: null,
        rootRunId: crypto.randomUUID(),
        nestingDepth: 0,
        routineId: String(routine!.id),
      },
      () => importDocs([{ externalRef: "new", title: "Fresh", body: "v2" }], label),
    )
    expect(run.counts["knowledge.document"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    expect((await doc(label, "new"))!.title).toBe("Fresh")
    const [unchanged] = await sql`SELECT body FROM app_knowledge.documents WHERE id = ${bound.id}`
    expect(unchanged!.body).toBe("v1")
  })

  it("undo takes the deleted document out of search", async () => {
    const label = `kx${tag()}`
    const run = await importDocs([{ externalRef: "gone", title: "Soon gone", body: "x" }], label)
    const id = String((await doc(label, "gone"))!.id)
    await LiveIndexTestAccess.clear()
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report).toEqual({ deleted: 1, refused: [] })
    const pending = await LiveIndexTestAccess.pendingItems()
    const docKey = documentId(orgId, "knowledge", "document", id)
    const item = pending.find((p) => p.key === docKey)
    expect(item?.payload.action).toBe("delete")
    // What the flusher writes for it: a delete of that search document.
    const resolved = await resolveLiveIndexItems([item!])
    expect(resolved.deleteIds).toContain(docKey)
  })

  it("refuses a record that names a synced source", async () => {
    const run = await importDocs(
      [{ externalRef: "s", title: "Synced", body: "x", syncedSourceId: crypto.randomUUID() }],
      `ky${tag()}`,
    )
    expect(run.counts["knowledge.document"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(run.errors[0]?.error)).toMatch(/syncedSourceId/)
  })

  it("attaches an uploaded file the person can see, refuses another org's (A9)", async () => {
    const label = `ka${tag()}`
    const mine = await uploadedFile(orgId, adminId)
    const foreign = await uploadedFile(otherOrgId, otherAdminId)
    const run = await importDocs(
      [
        { externalRef: "a1", title: "With manual", body: "x", attachments: [{ fileId: mine }] },
        { externalRef: "a2", title: "Foreign", body: "x", attachments: [{ fileId: foreign }] },
      ],
      label,
    )
    expect(run.counts["knowledge.document"]).toEqual({ created: 1, skipped: 0, failed: 1 })
    expect(String(run.errors[0]?.error)).toMatch(/not found/i)
    expect(await doc(label, "a2")).toBeUndefined()
    const [file] = await sql`
      SELECT id, storage_key FROM kernel.files
      WHERE org_id = ${orgId} AND app = 'knowledge' AND entity_type = 'document'
        AND entity_id = ${String((await doc(label, "a1"))!.id)}`
    expect(file).toBeDefined()
    expect(String(await getObjectBuffer(String(file!.storage_key)))).toBe("manual")
    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused).toEqual([])
    expect((await sql`SELECT 1 FROM kernel.files WHERE id = ${file!.id}`).length).toBe(0)
  })
})

describe("knowledge.collection with its documents", () => {
  it("imports collections and the documents filed in them in one run; undo removes only what it created", async () => {
    const label = `kc${tag()}`
    const keptTag = `Kept ${tag()}`
    const [kept] = await sql`
      INSERT INTO app_knowledge.tags (org_id, name, normalized_name)
      VALUES (${orgId}, ${keptTag}, ${keptTag.toLowerCase()}) RETURNING id`
    const dir = mkdtempSync(join(tmpdir(), "knowledge-import-"))
    tmpDirs.push(dir)
    const file = join(dir, "export.ndjson")
    writeFileSync(
      file,
      [
        {
          kind: "knowledge.document",
          record: {
            externalRef: "d1",
            title: "Release checklist",
            body: "Steps",
            collectionRefs: ["c-child"],
            tagNames: [keptTag, `New ${label}`],
          },
        },
        {
          kind: "knowledge.collection",
          record: { externalRef: "c-root", name: "Engineering", shared: true },
        },
        {
          kind: "knowledge.collection",
          record: {
            externalRef: "c-child",
            name: "Releases",
            parentExternalRef: "c-root",
            shared: true,
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    )
    const run = await runImport({
      orgId,
      actor: admin(),
      kinds: ["knowledge.document", "knowledge.collection"],
      source: { type: "path", path: file },
      sourceLabel: label,
      mode: "cli",
    })
    expect(run.counts["knowledge.collection"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect(run.counts["knowledge.document"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const cols = await sql`
      SELECT c.name, p.name AS parent, c.owner_user_id FROM app_knowledge.collections c
      LEFT JOIN app_knowledge.collections p ON p.id = c.parent_collection_id
      WHERE c.org_id = ${orgId} AND c.external_ref LIKE ${`${label}:%`} ORDER BY c.name`
    expect(cols.map((c) => [c.name, c.parent, c.owner_user_id])).toEqual([
      ["Engineering", null, null],
      ["Releases", "Engineering", null],
    ])
    const d1 = (await doc(label, "d1"))!
    const [membership] = await sql`
      SELECT c.name FROM app_knowledge.collection_memberships m
      JOIN app_knowledge.collections c ON c.id = m.collection_id
      WHERE m.org_id = ${orgId} AND m.target_id = ${d1.id}`
    expect(membership!.name).toBe("Releases")

    const report = await undoImportRun(orgId, run.runId, { userId: adminId })
    expect(report.refused).toEqual([])
    expect(await doc(label, "d1")).toBeUndefined()
    expect(
      (await sql`SELECT 1 FROM app_knowledge.collections WHERE external_ref LIKE ${`${label}:%`}`)
        .length,
    ).toBe(0)
    expect(
      (
        await sql`SELECT 1 FROM app_knowledge.tags WHERE org_id = ${orgId} AND name = ${`New ${label}`}`
      ).length,
    ).toBe(0)
    expect((await sql`SELECT 1 FROM app_knowledge.tags WHERE id = ${kept!.id}`).length).toBe(1)
  })
})

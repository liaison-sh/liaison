// SPDX-License-Identifier: FSL-1.1-ALv2
// Transform sources through the import runner (P4b T7): a saved transform runs
// over uploaded files (CSV, a zip with declared entries) or an API connection,
// once per run even when kinds have levels; its records go through the kinds'
// handlers; declared entries and deferred downloads are staged in storage for
// the handler and removed after the run; rejected records, a failing batch, a
// preview limit, a cancel, the download limits (size, run quota) and the
// version pin all behave as the run report says.
// Real database and object storage, one fixture host app on an ad-hoc schema.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBuffer, listOrgPrefix, putObject } from "~/infra/storage/object-storage"
import { importRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { BUILTIN_IMPORT_HANDLERS } from "~/modules/imports/builtin-import-handlers"
import { processImportRunJob } from "~/modules/imports/job"
import type { ImportKindDecl } from "~/modules/imports/kind-schema"
import { buildZip } from "~/modules/imports/parsers/__test-helpers__/zip-writer"
import { runImport, transformRunSource } from "~/modules/imports/runner"
import { createImportRun, getImportRun, requestRunCancel } from "~/modules/imports/runs"
import { noteStagedBytes, orgStagedBytes, stagingPrefixOf } from "~/modules/imports/staging"
import { sweepStaleImportRuns } from "~/modules/imports/sweep"
import { type ApiConnectionClient, prepareTransform } from "~/modules/imports/transform-run"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"
import { saveTransform } from "~/modules/imports/transforms/store"
import { dedupMatchSql, type HostImportHandler, ImportError } from "~/modules/imports/types"
import { setOrgCaps } from "~/modules/org/caps"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCHEMA = "app_xformfix"

const FOLDER_DECL: ImportKindDecl = {
  schema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", minLength: 1 } },
    additionalProperties: false,
  },
  handler: "importFolders",
  dedupKey: "name",
  tables: [`${SCHEMA}.folders`],
  writeScopes: ["xformfix:notes:write"],
}

const NOTE_DECL: ImportKindDecl = {
  schema: {
    type: "object",
    required: ["ref", "title"],
    properties: {
      ref: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      folder: { type: "string" },
      attachments: {
        type: "array",
        items: {
          type: "object",
          required: ["filename", "fileId"],
          properties: {
            filename: { type: "string" },
            mimeType: { type: "string" },
            fileId: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  handler: "importNotes",
  dedupKey: "ref",
  tables: [`${SCHEMA}.notes`],
  writeScopes: ["xformfix:notes:write"],
  files: ["attachments"],
  parent: "folder",
}

async function existing(table: string, column: string, orgId: string, label: string, key: string) {
  return extractRows<{ id: string }>(
    await sql.unsafe(
      `SELECT id FROM ${SCHEMA}.${table} WHERE org_id = $1 AND ${column} = ANY($2::text[]) LIMIT 1`,
      [orgId, label ? [`${label}:${key}`, key] : [key]],
    ),
  )
}

const folderHandler: HostImportHandler = {
  async importRecord(tx, ctx, record, dedupValue) {
    if (
      (await existing("folders", "external_ref", ctx.orgId, ctx.sourceLabel, String(record.name)))
        .length
    ) {
      return { status: "skipped", rows: [] }
    }
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(SCHEMA)}.folders (org_id, external_ref, name)
        VALUES (${ctx.orgId}::uuid, ${dedupValue}, ${String(record.name)}) RETURNING id`),
    )
    return { status: "created", rows: [{ table: `${SCHEMA}.folders`, id: rows[0]!.id }] }
  },
}

const noteHandler: HostImportHandler = {
  async importRecord(tx, ctx, record, dedupValue) {
    const found = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${drizzleSql.raw(SCHEMA)}.notes
        WHERE org_id = ${ctx.orgId}::uuid
          AND ${dedupMatchSql(drizzleSql`external_ref`, ctx.sourceLabel, String(record.ref))}
        LIMIT 1`),
    )
    if (found.length > 0) return { status: "skipped", rows: [] }
    const hashes: string[] = []
    for (const att of (record.attachments as Array<{ fileId: string }> | undefined) ?? []) {
      const file = await ctx.resolveFile(att.fileId)
      const bytes = await getObjectBuffer(file.storageKey)
      hashes.push(crypto.createHash("sha256").update(bytes).digest("hex"))
    }
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(SCHEMA)}.notes (org_id, external_ref, title, folder, hashes)
        VALUES (${ctx.orgId}::uuid, ${dedupValue}, ${String(record.title)},
                ${typeof record.folder === "string" ? record.folder : null},
                ${`{${hashes.join(",")}}`}::text[])
        RETURNING id`),
    )
    return { status: "created", rows: [{ table: `${SCHEMA}.notes`, id: rows[0]!.id }] }
  },
}

let orgId = ""
let adminId = ""

function actor(userId: string): UserContext {
  return { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: { "*": ["*"] } }
}

const sha = (b: Uint8Array | string) => crypto.createHash("sha256").update(b).digest("hex")

/** An uploaded file the admin owns (a thread only they take part in). */
async function upload(filename: string, bytes: Uint8Array | string, mime: string): Promise<string> {
  const fileId = crypto.randomUUID()
  const storageKey = `orgs/${orgId}/xform-test/${fileId}/${filename}`
  const body = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes)
  await putObject({ key: storageKey, body, contentType: mime })
  await withPrivilegedDb(orgId, "t", async (tx) => {
    const threadId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${threadId}::uuid, ${orgId}::uuid, ${`xf-${threadId.slice(0, 8)}`}, 'import upload', ${adminId}::uuid)`)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}::uuid, ${adminId}::uuid, ${orgId}::uuid, 'owner')`)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                size_bytes, storage_key, uploaded_by)
      VALUES (${fileId}::uuid, ${orgId}::uuid, 'kernel', 'thread', ${threadId}, ${filename},
              ${mime}, ${body.byteLength}, ${storageKey}, ${adminId}::uuid)`)
  })
  return fileId
}

async function save(name: string, source: string, sourceType: "upload" | "api" = "upload") {
  return withPrivilegedDb(orgId, "t", (tx) =>
    saveTransform(tx, {
      orgId,
      name,
      source,
      kinds: ["xformfix.folder", "xformfix.note"],
      sourceType,
      ...(sourceType === "api" ? { connectionIdentifier: "helpdesk" } : {}),
      createdBy: adminId,
    }),
  )
}

async function notes(prefix: string) {
  return extractRows<{
    external_ref: string
    title: string
    folder: string | null
    hashes: string[]
  }>(
    await sql.unsafe(
      `SELECT external_ref, title, folder, hashes FROM ${SCHEMA}.notes
       WHERE org_id = $1 AND external_ref LIKE $2 ORDER BY external_ref`,
      [orgId, `${prefix}%`],
    ),
  )
}

async function stagedObjects(runId: string): Promise<number> {
  const all = await listOrgPrefix({ orgId })
  return all.objects.filter((o) => o.Key.includes(`/import_run/${runId}/`)).length
}

const CSV_TRANSFORM = `
async function transform(batch, ctx) {
  var folders = (batch.state && batch.state.folders) || {}
  var out = []
  for (var i = 0; i < batch.records.length; i++) {
    var r = batch.records[i]
    if (!folders[r.folder]) { folders[r.folder] = true; await ctx.emitRecords("xformfix.folder", [{ name: r.folder }]) }
    out.push({ ref: r.id, title: r.title, folder: r.folder })
  }
  await ctx.emitRecords("xformfix.note", out)
  return { state: { folders: folders } }
}`

beforeAll(async () => {
  await acquireTestLock()
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
  await sql.unsafe(`
    CREATE TABLE "${SCHEMA}".folders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
      external_ref text NOT NULL, name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`)
  await sql.unsafe(`
    CREATE TABLE "${SCHEMA}".notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
      external_ref text NOT NULL, title text NOT NULL, folder text, hashes text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`)
  for (const role of ["liaison_rls", "liaison_admin"]) {
    await sql.unsafe(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO ${role}`).catch(() => {})
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${SCHEMA}" TO ${role}`).catch(() => {})
  }
  orgId = (await ensureOrg({ slug: `xf-${crypto.randomUUID().slice(0, 8)}`, name: "Xform" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
      name: "admin",
      password: "pw-xform-1!",
      role: "admin",
    })
  ).userId
  await ensureAppsForOrg(orgId)
  importRegistry.set([orgId, "xformfix"], { kinds: { folder: FOLDER_DECL, note: NOTE_DECL } })
  BUILTIN_IMPORT_HANDLERS["xformfix.folder"] = folderHandler
  BUILTIN_IMPORT_HANDLERS["xformfix.note"] = noteHandler
  await rebuildFilesSelectPolicy()
}, 300_000)

afterAll(async () => {
  delete BUILTIN_IMPORT_HANDLERS["xformfix.folder"]
  delete BUILTIN_IMPORT_HANDLERS["xformfix.note"]
  await shutdownTransformPool()
  await sql
    .begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '10s'")
      await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    })
    .catch((err: unknown) => console.error(`drop ${SCHEMA} failed`, err))
  await releaseTestLock()
}, 120_000)

const KINDS = ["xformfix.folder", "xformfix.note"]

describe("transform sources through the runner", () => {
  it("runs a saved transform over an uploaded CSV once, parents first; a rerun skips everything", async () => {
    const p = `C${crypto.randomUUID().slice(0, 6)}`
    const rows = Array.from(
      { length: 450 },
      (_, i) => `${p}-${String(i).padStart(3, "0")},Note ${i},${i % 2 ? "Inbox" : "Archive"}`,
    )
    const fileId = await upload("notes.csv", `id,title,folder\n${rows.join("\n")}\n`, "text/csv")
    const t = await save(`csv-${p.toLowerCase()}`, CSV_TRANSFORM)
    const run = (sourceLabel: string) =>
      runImport({
        orgId,
        actor: actor(adminId),
        kinds: KINDS,
        source: {
          type: "transform",
          transform: { id: t.id, version: t.version },
          input: { type: "files", fileIds: [fileId] },
        },
        sourceLabel,
        mode: "api",
      })
    const first = await run("csvsrc")
    expect(first.status).toBe("done")
    expect(first.counts["xformfix.note"]).toEqual({ created: 450, skipped: 0, failed: 0 })
    expect(first.counts["xformfix.folder"]?.created).toBe(2)
    // 450 rows in batches of 200: three transform calls, not six (two kind levels).
    expect(first.report.transformCalls).toBe(3)
    expect((await notes(`csvsrc:${p}`)).length).toBe(450)
    const again = await run("csvsrc")
    expect(again.counts["xformfix.note"]).toEqual({ created: 0, skipped: 450, failed: 0 })
  }, 120_000)

  it("reads a zip in the order its file rules give; a declared entry reaches the handler and is gone after the run", async () => {
    const p = `Z${crypto.randomUUID().slice(0, 6)}`
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])
    const zip = buildZip([
      {
        name: "notes/b.json",
        data: JSON.stringify([{ id: `${p}-2`, title: "Two", file: "files/pic.png" }]),
      },
      { name: "notes/a.json", data: JSON.stringify([{ id: `${p}-1`, title: "One" }]) },
      { name: "folders.json", data: JSON.stringify([{ name: "Zipped" }]) },
      { name: "files/pic.png", data: png },
      { name: "README.txt", data: "ignored" },
    ])
    const fileId = await upload("export.zip", zip, "application/zip")
    const t = await save(
      `zip-${p.toLowerCase()}`,
      `async function transform(batch, ctx) {
         var seen = (batch.state && batch.state.files) || []
         seen.push(batch.file)
         if (batch.file === "folders.json") { await ctx.emitRecords("xformfix.folder", batch.records); return { state: { files: seen } } }
         var out = []
         for (var i = 0; i < batch.records.length; i++) {
           var r = batch.records[i]
           var rec = { ref: r.id, title: r.title, folder: "Zipped" }
           if (r.file) rec.attachments = [{ filename: "pic.png", mimeType: "image/png", fileId: await ctx.declareFile(r.file) }]
           out.push(rec)
         }
         await ctx.emitRecords("xformfix.note", out)
         return { state: { files: seen } }
       }`,
    )
    const result = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "files", fileIds: [fileId] },
        files: [{ match: "folders.json" }, { match: "notes/*.json" }],
      },
      sourceLabel: "zipsrc",
      mode: "api",
    })
    expect(result.status).toBe("done")
    expect(result.counts["xformfix.note"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect(result.report.filesRead).toEqual(["folders.json", "notes/a.json", "notes/b.json"])
    const got = await notes(`zipsrc:${p}`)
    expect(got.map((n) => n.hashes)).toEqual([[], [sha(png)]])
    expect(await stagedObjects(result.runId)).toBe(0)
  }, 120_000)

  it("a transform may name only its own files: a ref, or a file of the run's input; any other file id is refused", async () => {
    const p = `X${crypto.randomUUID().slice(0, 6)}`
    const secret = new TextEncoder().encode(`someone else's file ${p}`)
    // A file the importing person can read but did not give the import.
    const outside = await upload("payroll.pdf", secret, "application/pdf")
    const pic = new TextEncoder().encode(`picture ${p}`)
    const inputPic = await upload("pic.png", pic, "image/png")
    const rows = await upload(
      "rows.jsonl",
      [
        JSON.stringify({ id: `${p}-1`, title: "Steals", file: outside }),
        JSON.stringify({ id: `${p}-2`, title: "Own input", file: inputPic }),
      ].join("\n"),
      "application/x-ndjson",
    )
    const t = await save(
      `refs-${p.toLowerCase()}`,
      `async function transform(batch, ctx) {
         await ctx.emitRecords("xformfix.note", batch.records.map(function (r) {
           return { ref: r.id, title: r.title, attachments: [{ filename: "f", fileId: r.file }] }
         }))
         return {}
       }`,
    )
    const result = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "files", fileIds: [rows, inputPic] },
        files: [{ match: "rows.jsonl" }],
      },
      sourceLabel: "refsrc",
      mode: "api",
    })
    expect(result.counts["xformfix.note"]).toEqual({ created: 1, skipped: 0, failed: 1 })
    expect(String(result.errors[0]?.error)).toContain("not a file of this import")
    const got = await notes(`refsrc:${p}`)
    expect(got.map((n) => [n.external_ref, n.hashes])).toEqual([[`refsrc:${p}-2`, [sha(pic)]]])
  }, 120_000)

  it("counts a record the kind refuses as failed with its batch and index; the others import", async () => {
    const p = `R${crypto.randomUUID().slice(0, 6)}`
    const fileId = await upload(
      "rows.jsonl",
      [1, 2, 3]
        .map((i) => JSON.stringify({ id: `${p}-${i}`, title: i === 2 ? "" : `T${i}` }))
        .join("\n"),
      "application/x-ndjson",
    )
    const t = await save(
      `rej-${p.toLowerCase()}`,
      `async function transform(batch, ctx) {
         await ctx.emitRecords("xformfix.note", batch.records.map(function (r) { return { ref: r.id, title: r.title } }))
         return {}
       }`,
    )
    const result = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "files", fileIds: [fileId] },
      },
      sourceLabel: "rejsrc",
      mode: "api",
    })
    expect(result.status).toBe("done")
    expect(result.counts["xformfix.note"]).toEqual({ created: 2, skipped: 0, failed: 1 })
    expect(result.errors).toHaveLength(1)
    expect(String(result.errors[0]?.error)).toContain("title")
    expect(String(result.errors[0]?.at)).toContain("batch 1")
    expect(String(result.errors[0]?.at)).toContain("record 2")
  }, 120_000)

  it("fails the run on the batch whose call throws, and writes nothing", async () => {
    const p = `F${crypto.randomUUID().slice(0, 6)}`
    const rows = Array.from({ length: 300 }, (_, i) =>
      JSON.stringify({ id: `${p}-${i}`, title: `T${i}` }),
    )
    const fileId = await upload("rows.jsonl", rows.join("\n"), "application/x-ndjson")
    const t = await save(
      `boom-${p.toLowerCase()}`,
      `async function transform(batch, ctx) {
         if (batch.offset > 1) throw new Error("cannot read row " + batch.offset)
         await ctx.emitRecords("xformfix.note", batch.records.map(function (r) { return { ref: r.id, title: r.title } }))
         return {}
       }`,
    )
    const err = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "files", fileIds: [fileId] },
      },
      sourceLabel: "boomsrc",
      mode: "api",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toContain("batch 2")
    expect(String((err as Error).message)).toContain("cannot read row 201")
    expect((await notes(`boomsrc:${p}`)).length).toBe(0)
  }, 120_000)

  it("previews (dry run) only the first batches, writes nothing and downloads nothing", async () => {
    const p = `P${crypto.randomUUID().slice(0, 6)}`
    const rows = Array.from({ length: 700 }, (_, i) =>
      JSON.stringify({ id: `${p}-${i}`, title: `T${i}` }),
    )
    const fileId = await upload("rows.jsonl", rows.join("\n"), "application/x-ndjson")
    const t = await save(
      `prev-${p.toLowerCase()}`,
      `async function transform(batch, ctx) {
         await ctx.emitRecords("xformfix.note", batch.records.map(function (r) { return { ref: r.id, title: r.title } }))
         return {}
       }`,
    )
    const result = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "files", fileIds: [fileId] },
        limit: { batches: 2 },
      },
      sourceLabel: "prevsrc",
      mode: "api",
      dryRun: true,
    })
    expect(result.status).toBe("done")
    expect(result.counts["xformfix.note"]).toEqual({ created: 400, skipped: 0, failed: 0 })
    expect(result.report.transformCalls).toBe(2)
    expect(result.report.cutAtLimit).toBe(true)
    expect((await notes(`prevsrc:${p}`)).length).toBe(0)
  }, 120_000)

  it("refuses a version that is not the pinned one before any write", async () => {
    const t = await save(`pin-${crypto.randomUUID().slice(0, 6)}`, CSV_TRANSFORM)
    const fileId = await upload("x.csv", "id,title,folder\nA,B,C\n", "text/csv")
    const err = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version + 1 },
        input: { type: "files", fileIds: [fileId] },
      },
      sourceLabel: "pinsrc",
      mode: "api",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toContain("version")
  }, 60_000)

  it("the job runs a queued transform run as the person who started it", async () => {
    const p = `J${crypto.randomUUID().slice(0, 6)}`
    const fileId = await upload(
      "j.csv",
      `id,title,folder\n${p}-1,One,Jobs\n${p}-2,Two,Jobs\n`,
      "text/csv",
    )
    const t = await save(`job-${p.toLowerCase()}`, CSV_TRANSFORM)
    const source = {
      type: "transform" as const,
      transform: { id: t.id, version: t.version },
      input: { type: "files" as const, fileIds: [fileId] },
    }
    const prepared = await prepareTransform(orgId, source, KINDS)
    const run = await createImportRun({
      orgId,
      kinds: KINDS,
      sourceLabel: "jobsrc",
      source: transformRunSource(source, prepared),
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminId,
    })
    await processImportRunJob({ orgId, runId: run.id })
    const done = await getImportRun(orgId, run.id)
    expect(done?.status).toBe("done")
    expect(done?.counts["xformfix.note"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    expect((await notes(`jobsrc:${p}`)).length).toBe(2)
  }, 120_000)

  it("the job refuses a queued run whose transform code no longer matches its pin", async () => {
    const t = await save(`jobpin-${crypto.randomUUID().slice(0, 6)}`, CSV_TRANSFORM)
    const fileId = await upload("k.csv", "id,title,folder\nA,B,C\n", "text/csv")
    const run = await createImportRun({
      orgId,
      kinds: KINDS,
      sourceLabel: "jobpinsrc",
      source: {
        transform: { id: t.id, version: t.version, sha256: "0".repeat(64) },
        input: { type: "files", fileIds: [fileId] },
      },
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminId,
    })
    await processImportRunJob({ orgId, runId: run.id })
    const done = await getImportRun(orgId, run.id)
    expect(done?.status).toBe("failed")
    expect(JSON.stringify(done?.errors)).toContain("not the code the run was approved on")
  }, 60_000)

  it("refuses server paths on an API run", async () => {
    const t = await save(`path-${crypto.randomUUID().slice(0, 6)}`, CSV_TRANSFORM)
    const err = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "paths", paths: ["/etc/passwd"] },
      },
      sourceLabel: "pathsrc",
      mode: "api",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).code).toBe("invalid_source")
  }, 60_000)

  it("stops at a cancel between calls and writes nothing", async () => {
    const p = `K${crypto.randomUUID().slice(0, 6)}`
    const rows = Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({ id: `${p}-${i}`, title: `T${i}` }),
    )
    const fileId = await upload("rows.jsonl", rows.join("\n"), "application/x-ndjson")
    const t = await save(
      `cancel-${p.toLowerCase()}`,
      `async function transform(batch, ctx) {
         await ctx.emitRecords("xformfix.note", batch.records.map(function (r) { return { ref: r.id, title: r.title } }))
         return {}
       }`,
    )
    let runId = ""
    const result = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "files", fileIds: [fileId] },
      },
      sourceLabel: "cancelsrc",
      mode: "api",
      hooks: {
        afterTransformCall: async (n, id) => {
          runId = id
          if (n === 2) await requestRunCancel(orgId, id)
        },
      },
    })
    expect(runId).toBe(result.runId)
    expect(result.status).toBe("cancelled")
    expect((await notes(`cancelsrc:${p}`)).length).toBe(0)
  }, 120_000)
})

describe("staging and the storage quota", () => {
  it("files staged by other runs count against the quota, and declared zip entries are held to it", async () => {
    const p = `Q${crypto.randomUUID().slice(0, 6)}`
    // A missing storage cap is unlimited (organizations.caps), so the org gets
    // a 10 GB one, and another run of the org holds staged files worth all of it.
    await setOrgCaps(orgId, { set: { storageGb: 10 } })
    const other = crypto.randomUUID()
    await noteStagedBytes(orgId, other, 10 * 1024 * 1024 * 1024)
    try {
      const zip = buildZip([
        {
          name: "rows.json",
          data: JSON.stringify([{ id: `${p}-1`, title: "With file", file: "pic.png" }]),
        },
        { name: "pic.png", data: new Uint8Array(2048).fill(7) },
      ])
      const fileId = await upload("export.zip", zip, "application/zip")
      const t = await save(
        `zq-${p.toLowerCase()}`,
        `async function transform(batch, ctx) {
           const out = []
           for (const r of batch.records) {
             out.push({ ref: r.id, title: r.title, attachments: [{ filename: "pic.png", fileId: await ctx.declareFile(r.file) }] })
           }
           await ctx.emitRecords("xformfix.note", out)
           return {}
         }`,
      )
      const result = await runImport({
        orgId,
        actor: actor(adminId),
        kinds: KINDS,
        source: {
          type: "transform",
          transform: { id: t.id, version: t.version },
          input: { type: "files", fileIds: [fileId] },
          files: [{ match: "rows.json" }],
        },
        sourceLabel: "zqsrc",
        mode: "api",
      })
      expect(result.report.attachmentsMissing).toBe(1)
      expect((result.report.missingFiles as Array<{ reason: string }>)[0]?.reason).toContain(
        "storage quota",
      )
      // The run's own staged bytes are released when it ends.
      expect(await orgStagedBytes(orgId)).toBe(10 * 1024 * 1024 * 1024)
    } finally {
      await noteStagedBytes(orgId, other, null)
      await setOrgCaps(orgId, { unset: ["storageGb"] })
    }
    expect(await orgStagedBytes(orgId)).toBe(0)
  }, 120_000)

  it("the stale-run sweep deletes a crashed run's staged files and releases its bytes", async () => {
    const run = await createImportRun({
      orgId,
      kinds: KINDS,
      sourceLabel: "crash",
      source: {},
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: adminId,
      status: "running",
    })
    await sql`UPDATE kernel.import_runs SET heartbeat_at = now() - interval '1 hour', started_at = now() - interval '1 hour' WHERE id = ${run.id}`
    const key = `orgs/${orgId}/${stagingPrefixOf(run.id)}${crypto.randomUUID()}/left.bin`
    await putObject({
      key,
      body: Buffer.from("left behind"),
      contentType: "application/octet-stream",
    })
    await noteStagedBytes(orgId, run.id, 11)
    expect(await stagedObjects(run.id)).toBe(1)
    await sweepStaleImportRuns(60_000)
    expect(await stagedObjects(run.id)).toBe(0)
    expect(await orgStagedBytes(orgId)).toBe(0)
  }, 60_000)
})

describe("API sources", () => {
  const PULL = `
async function pull(page, ctx) {
  var n = page.cursor || 1
  var answer = await ctx.apiGet("/issues?page=" + n)
  if (answer.status === 429) return { nextCursor: n }
  var out = []
  for (var k = 0; k < answer.data.issues.length; k++) {
    var i = answer.data.issues[k]
    var rec = { ref: i.key, title: i.title, folder: "Api" }
    if (i.attachment) rec.attachments = [{ filename: i.attachment, mimeType: "application/octet-stream", fileId: await ctx.downloadToFile("/attachments/" + i.attachment, { filename: i.attachment }) }]
    out.push(rec)
  }
  if (n === 1) await ctx.emitRecords("xformfix.folder", [{ name: "Api" }])
  await ctx.emitRecords("xformfix.note", out)
  return { nextCursor: answer.data.next || null }
}`

  function client(
    p: string,
    files: Record<string, Uint8Array | number | "gone">,
  ): ApiConnectionClient {
    let throttled = false
    return {
      async get(path) {
        if (path === "/issues?page=1" && !throttled) {
          throttled = true
          return { status: 429, data: null, retryAfterMs: 1 }
        }
        const n = Number(new URL(`http://x${path}`).searchParams.get("page"))
        const names = Object.keys(files)
        return {
          status: 200,
          retryAfterMs: null,
          data: {
            issues: [{ key: `${p}-${n}`, title: `Issue ${n}`, attachment: names[n - 1] }],
            next: n < names.length ? n + 1 : null,
          },
        }
      },
      async download(path) {
        const name = path.slice("/attachments/".length)
        const f = files[name]
        if (f === "gone" || f === undefined) {
          return {
            status: 404,
            body: null,
            contentType: null,
            contentLength: null,
            filename: null,
            retryAfterMs: null,
          }
        }
        const bytes = typeof f === "number" ? new Uint8Array(f) : f
        return {
          status: 200,
          body: new Blob([bytes]).stream(),
          contentType: "application/octet-stream",
          contentLength: bytes.byteLength,
          filename: name,
          retryAfterMs: null,
        }
      },
    }
  }

  it("pulls pages, stages downloads for the handler, reports a missing and an oversized file, and cleans up", async () => {
    const p = `A${crypto.randomUUID().slice(0, 6)}`
    const good = new TextEncoder().encode(`attachment of ${p}`)
    const t = await save(`api-${p.toLowerCase()}`, PULL, "api")
    const result = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "api", connection: "helpdesk" },
      },
      sourceLabel: "apisrc",
      mode: "api",
      hooks: {
        apiConnection: () => client(p, { "a.bin": good, "b.bin": "gone", "c.bin": 64 }),
        downloadMaxBytes: 32,
      },
    })
    expect(result.status).toBe("done")
    expect(result.counts["xformfix.note"]).toEqual({ created: 3, skipped: 0, failed: 0 })
    expect(result.report.attachmentsMissing).toBe(2)
    const missing = result.report.missingFiles as Array<{ path: string; reason: string }>
    expect(missing.map((m) => m.path).sort()).toEqual(["/attachments/b.bin", "/attachments/c.bin"])
    expect(missing.find((m) => m.path.endsWith("c.bin"))?.reason).toContain("32 bytes")
    const got = await notes(`apisrc:${p}`)
    expect(got.map((n) => n.hashes)).toEqual([[sha(good)], [], []])
    expect(result.report.throttleWaits).toBe(1)
    expect(await stagedObjects(result.runId)).toBe(0)
  }, 120_000)

  it("gives up on a download that runs past its time limit and reports it missing", async () => {
    const p = `T${crypto.randomUUID().slice(0, 6)}`
    const t = await save(`slow-${p.toLowerCase()}`, PULL, "api")
    const base = client(p, { "slow.bin": 8 })
    const result = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "api", connection: "helpdesk" },
      },
      sourceLabel: "slowsrc",
      mode: "api",
      hooks: {
        apiConnection: () => ({
          get: base.get,
          // Headers arrive, then the body never ends.
          async download() {
            return {
              status: 200,
              body: new ReadableStream<Uint8Array>({ start() {} }),
              contentType: "application/octet-stream",
              contentLength: null,
              filename: null,
              retryAfterMs: null,
            }
          },
        }),
        downloadTimeoutMs: 300,
      },
    })
    expect(result.status).toBe("done")
    expect(result.counts["xformfix.note"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const missing = result.report.missingFiles as Array<{ reason: string }>
    expect(missing[0]?.reason).toContain("time limit")
    expect(await stagedObjects(result.runId)).toBe(0)
  }, 60_000)

  it("refuses a download that would take the org past its storage quota", async () => {
    const p = `Q${crypto.randomUUID().slice(0, 6)}`
    const t = await save(`quota-${p.toLowerCase()}`, PULL, "api")
    const result = await runImport({
      orgId,
      actor: actor(adminId),
      kinds: KINDS,
      source: {
        type: "transform",
        transform: { id: t.id, version: t.version },
        input: { type: "api", connection: "helpdesk" },
      },
      sourceLabel: "quotasrc",
      mode: "api",
      hooks: {
        apiConnection: () => client(p, { "big.bin": 4096 }),
        storageQuotaBytesLeft: async () => 1024,
      },
    })
    expect(result.status).toBe("done")
    expect(result.report.attachmentsMissing).toBe(1)
    const missing = result.report.missingFiles as Array<{ reason: string }>
    expect(missing[0]?.reason).toContain("storage quota")
  }, 120_000)
})

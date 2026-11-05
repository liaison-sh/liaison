// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison org delete` (spec S2, D10, D11, A5) through the real CLI and the
// real `org-delete` job (the server's worker, played in-process: the CLI never
// hosts jobs), against Postgres, Redis, BullMQ, Meilisearch and object storage.
//
// Pinned:
//   - every gate refuses with exit 2 and the fix, before anything changes:
//     the operator org (no override), a running export, no downloaded export,
//     no legal archive recipient, an invalid recipient, a wrong --yes slug;
//   - --dry-run reports the gates and the residue and changes nothing;
//   - a deletion leaves residue 0 in every store, the neighbour org unchanged;
//   - the legal archive decrypts with a throwaway identity generated here and
//     holds the legal rows, their PDF and the manifest (and nothing else);
//   - the ledger and legal_archives rows survive the purge;
//   - a crash between steps 4 (rows) and 5 (search) is resumed by a re-run,
//     found through the ledger by org id once the org row is gone or not;
//   - --abort before step 3 restores the org;
//   - --export-to saves the export to disk and meets the gate;
//   - fix round 1 of the review: a legal row written during the settle window
//     is archived (the wait runs before the archive); a `legalRetention` row
//     filter keeps issued invoices / credit notes and their lines, never drafts
//     or quotes; a file name too long for tar and a missing object never block
//     the archive; an export older than 24 h does not meet the gate; --abort
//     after the archive was written deletes it; a crash after the org row is
//     gone resumes by slug and by id through the ledger; the job runs through a
//     real BullMQ worker (the dispatch does not drop it as a deleting org's
//     job); an --abort racing the job's own mark leaves the org restored;
//     --export-to with nothing to save is refused; an ignored
//     --no-legal-archive is said.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption"
import { MeiliSearch } from "meilisearch"
import { runOrgDeleteCli } from "~/cli/org-delete"
import { sql } from "~/db"
import { closeAllQueues, getJobQueue, JobsTestAccess } from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import {
  deleteObject,
  getObjectBuffer,
  headObject,
  putObject,
} from "~/infra/storage/object-storage"
import { redisBullMQ } from "~/lib/redis"
import { generateImmutableTriggerDdl } from "~/modules/apps/ddl"
import * as operatorOrgModule from "~/modules/apps/operator-org"
import {
  ORG_DELETE_JOB,
  processOrgDeleteJob,
  registerOrgDeleteJobWorker,
} from "~/modules/org/delete/job"
import { createOrgDeletion } from "~/modules/org/delete/ledger"
import { type LegalRetentionManifest, writeLegalArchive } from "~/modules/org/delete/legal-archive"
import { readTar } from "~/modules/org/delete/tar"
import * as deletingModule from "~/modules/org/purge/deleting"
import { residueScan } from "~/modules/org/purge/residue"
import { IndexWriterTestAccess } from "~/modules/search/index-writer"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const tag = crypto.randomUUID().slice(0, 8)
const APP = `deltest_${tag}`
const APP_SCHEMA = `app_${APP}`
const INDEX = `test_org_delete_${tag}`
const MANIFESTS: LegalRetentionManifest[] = [
  {
    name: APP,
    schema: {
      transmissions: { legalRetention: true },
      legal: {},
      notes: {},
      // Issued invoices and credit notes only (the invoicing shape, D13).
      docs: {
        legalRetention: {
          where: {
            type: { in: ["invoice", "credit_note"] },
            status: { in: ["issued", "paid", "voided"] },
          },
        },
      },
      doc_lines: { legalRetention: { parent: { table: "docs", column: "doc_id" } } },
    },
  },
]

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

const spies: Array<{ mockRestore: () => void }> = []
const objectKeys: string[] = []
const orgsCreated: string[] = []
let operatorOrgId = ""
let identity = ""
let recipient = ""
let tmpDir = ""

async function asAdmin(statements: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    for (const s of statements) await tx.unsafe(s)
  })
}

interface Seeded {
  orgId: string
  slug: string
  legalId: string
  pdfKey: string
}

/** One org with legal records, a PDF on a legal row, ordinary data and a footprint in every store. */
async function seedOrg(name: string): Promise<Seeded> {
  const orgId = crypto.randomUUID()
  const slug = `del-${name}-${tag}`
  const userId = crypto.randomUUID()
  const threadId = crypto.randomUUID()
  orgsCreated.push(orgId)
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, ${`Org ${name}`}, ${slug})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${userId}, ${orgId}, ${`${name}-${tag}@delete.test`}, ${name}, 'x')`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
    VALUES (${threadId}, ${orgId}, ${slug}, 'A thread', ${userId})`
  await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
    VALUES (${threadId}, ${orgId}, ${userId}, 'not a legal record', '{}'::text[])`
  await sql`INSERT INTO kernel.audit_log (org_id, actor_id, actor_type, action, app)
    VALUES (${orgId}, ${userId}, 'user', 'invoice.issued', ${APP})`
  const legalId = crypto.randomUUID()
  await sql.unsafe(
    `INSERT INTO "${APP_SCHEMA}".legal (id, org_id, number) VALUES ('${legalId}', '${orgId}', 'INV-${name}-1')`,
  )
  await sql.unsafe(
    `INSERT INTO "${APP_SCHEMA}".transmissions (org_id, legal_id, state) VALUES ('${orgId}', '${legalId}', 'delivered')`,
  )
  await sql.unsafe(
    `INSERT INTO "${APP_SCHEMA}".notes (org_id, body) VALUES ('${orgId}', 'not legal either')`,
  )
  const pdfKey = `orgs/${orgId}/files/${crypto.randomUUID()}.pdf`
  const pdf = new TextEncoder().encode(`%PDF-1.7 invoice of ${name}`)
  await putObject({ key: pdfKey, body: pdf, contentType: "application/pdf" })
  objectKeys.push(pdfKey)
  await sql`INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
    VALUES (${orgId}, ${APP}, 'legal_original', ${legalId}, ${`INV-${name}-1.pdf`}, 'application/pdf', ${pdf.byteLength}, ${pdfKey}, ${userId})`
  // An ordinary file, not attached to a legal row: never in the archive.
  const otherKey = `orgs/${orgId}/files/${crypto.randomUUID()}.txt`
  await putObject({
    key: otherKey,
    body: new TextEncoder().encode("chat file"),
    contentType: "text/plain",
  })
  objectKeys.push(otherKey)
  await sql`INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
    VALUES (${orgId}, 'kernel', 'message', ${threadId}, 'chat.txt', 'text/plain', 9, ${otherKey}, ${userId})`
  await redisBullMQ.set(`presence:${orgId}:${userId}`, "1")
  const task = await meili
    .index(INDEX)
    .addDocuments([{ id: `${orgId}_kernel_message_1`, org_id: orgId, title: "hello" }])
  await meili.tasks.waitForTask(task.taskUid)
  return { orgId, slug, legalId, pdfKey }
}

/** A completed export of the org, downloaded (or not), with its object. */
async function seedExport(
  orgId: string,
  opts: { downloaded: boolean; hoursAgo?: number },
): Promise<string> {
  const id = crypto.randomUUID()
  const key = `orgs/${orgId}/exports/${id}.zip`
  await putObject({
    key,
    body: new TextEncoder().encode("PK fake export"),
    contentType: "application/zip",
  })
  objectKeys.push(key)
  await sql`INSERT INTO kernel.org_exports (id, org_id, status, requested_via, object_key, bytes, completed_at, expires_at, downloaded_at)
    VALUES (${id}, ${orgId}, 'completed', 'cli', ${key}, 14,
      now() - make_interval(hours => ${opts.hoursAgo ?? 0}::int), now() + interval '7 days',
      CASE WHEN ${opts.downloaded}::boolean THEN now() END)`
  return id
}

/** Decrypt a stored archive with the test identity: its entries by name, and its manifest. */
async function openArchive(
  key: string,
): Promise<{ byName: Map<string, string>; manifest: Record<string, any> }> {
  const d = new Decrypter()
  d.addIdentity(identity)
  const entries = readTar(await d.decrypt(new Uint8Array(await getObjectBuffer(key))))
  const byName = new Map(entries.map((e) => [e.name, new TextDecoder().decode(e.bytes)]))
  return { byName, manifest: JSON.parse(byName.get("manifest.json") ?? "{}") }
}

/** The archive manifest's tables of this run's scratch app (a scratch app another run left behind is ignored). */
function ownTables(manifest: Record<string, any>): any[] {
  return manifest.tables.filter((t: any) => t.schema === APP_SCHEMA)
}

/** One document of the scratch app, with one line. */
async function seedDoc(
  orgId: string,
  type: string,
  status: string,
  number: string,
): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    `INSERT INTO "${APP_SCHEMA}".docs (id, org_id, type, status, number) VALUES ('${id}', '${orgId}', '${type}', '${status}', '${number}')`,
  )
  await sql.unsafe(
    `INSERT INTO "${APP_SCHEMA}".doc_lines (org_id, doc_id, description) VALUES ('${orgId}', '${id}', 'line of ${number}')`,
  )
  return id
}

/** A `kernel.files` row of the scratch app on `entityId`; the object is stored unless `missing`. */
async function seedAppFile(
  orgId: string,
  entityId: string,
  filename: string,
  body: string,
  opts: { missing?: boolean } = {},
): Promise<string> {
  const key = `orgs/${orgId}/files/${crypto.randomUUID()}.pdf`
  const bytes = new TextEncoder().encode(body)
  if (!opts.missing) {
    await putObject({ key, body: bytes, contentType: "application/pdf" })
    objectKeys.push(key)
  }
  await sql`INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
    VALUES (${orgId}, ${APP}, 'legal_original', ${entityId}, ${filename}, 'application/pdf', ${bytes.byteLength}, ${key})`
  return key
}

/** The archive of `org` written directly (no deletion), opened. */
async function archiveDirect(org: Seeded) {
  const archive = await writeLegalArchive({
    org: { id: org.orgId, name: "x", slug: org.slug },
    recipient,
    manifests: MANIFESTS,
  })
  objectKeys.push(archive.objectKey)
  return openArchive(archive.objectKey)
}

async function counts(orgId: string): Promise<Record<string, unknown>> {
  const scan = await residueScan(orgId)
  return {
    rows: scan.rows,
    objects: scan.objects,
    redis: scan.redisKeys,
    search: scan.searchDocuments,
  }
}

const noSleep = async () => undefined

/** The server's worker, played in-process. */
function worker(extra: Parameters<typeof processOrgDeleteJob>[1] = {}) {
  return async (p: Parameters<typeof processOrgDeleteJob>[0]) => {
    void processOrgDeleteJob(p, {
      sleep: noSleep,
      manifests: MANIFESTS,
      heartbeatMs: 1000,
      ...extra,
    })
  }
}

const quiet = { warn: () => undefined, pollMs: 50, operator: "test@host" }

beforeAll(async () => {
  await acquireTestLock()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  IndexWriterTestAccess.resetRebuildCache()
  const created = await meili.createIndex(INDEX, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const settings = await meili.index(INDEX).updateSettings({ filterableAttributes: ["org_id"] })
  await meili.tasks.waitForTask(settings.taskUid)

  // A scratch app: an immutable legal table (the kernel trigger, current
  // generator), a table the manifest marks legalRetention, an ordinary one.
  await asAdmin([
    `CREATE SCHEMA "${APP_SCHEMA}"`,
    `CREATE TABLE "${APP_SCHEMA}".legal (id uuid primary key default gen_random_uuid(), org_id uuid not null, created_at timestamptz not null default now(), number text)`,
    ...generateImmutableTriggerDdl(APP_SCHEMA, "legal", { retentionYears: 10 })
      .split(";\n")
      .filter((s) => s.trim()),
    `CREATE TABLE "${APP_SCHEMA}".transmissions (id uuid primary key default gen_random_uuid(), org_id uuid not null, legal_id uuid, state text)`,
    `CREATE TABLE "${APP_SCHEMA}".notes (id uuid primary key default gen_random_uuid(), org_id uuid not null, body text)`,
    `CREATE TABLE "${APP_SCHEMA}".docs (id uuid primary key default gen_random_uuid(), org_id uuid not null, type text not null, status text not null, number text)`,
    `CREATE TABLE "${APP_SCHEMA}".doc_lines (id uuid primary key default gen_random_uuid(), org_id uuid not null, doc_id uuid not null, description text)`,
  ])

  operatorOrgId = crypto.randomUUID()
  orgsCreated.push(operatorOrgId)
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${operatorOrgId}, 'Operator', ${`del-operator-${tag}`})`
  spies.push(spyOn(operatorOrgModule, "resolveOperatorOrgId").mockResolvedValue(operatorOrgId))

  identity = await generateX25519Identity()
  recipient = await identityToRecipient(identity)
  tmpDir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "org-delete-test-"))
}, 60_000)

afterAll(async () => {
  for (const s of spies) s.mockRestore()
  for (const orgId of orgsCreated) {
    await asAdmin([`DROP TRIGGER IF EXISTS kernel_immutable ON "${APP_SCHEMA}".legal`]).catch(
      () => undefined,
    )
    for (const t of ["files", "audit_log", "org_exports", "messages", "threads", "users"]) {
      await sql.unsafe(`DELETE FROM kernel.${t} WHERE org_id = '${orgId}'`).catch(() => undefined)
    }
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`.catch(() => undefined)
    await sql`DELETE FROM kernel.org_deletions WHERE deleted_org_id = ${orgId}`
    const archives = await sql<{ object_key: string }[]>`
      DELETE FROM kernel.legal_archives WHERE deleted_org_id = ${orgId} RETURNING object_key`
    for (const a of archives) await deleteObject(a.object_key).catch(() => undefined)
  }
  for (const k of objectKeys) await deleteObject(k).catch(() => undefined)
  await asAdmin([`DROP SCHEMA IF EXISTS "${APP_SCHEMA}" CASCADE`])
  await meili.deleteIndex(INDEX).catch(() => undefined)
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  await closeAllQueues()
  await releaseTestLock()
})

describe("liaison org delete: gates (exit 2, nothing changed)", () => {
  it("refuses the operator org, whatever the flags", async () => {
    const res = await runOrgDeleteCli(
      [
        operatorOrgId,
        "--yes",
        `del-operator-${tag}`,
        "--no-legal-archive",
        "--without-export-i-accept-losing-the-org-data",
      ],
      { ...quiet, recipient: null, enqueue: async () => expect.unreachable() },
    )
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("operator")
    const [row] =
      await sql`SELECT deleting_at FROM kernel.organizations WHERE id = ${operatorOrgId}`
    expect(row?.deleting_at).toBeNull()
  })

  it("refuses each missing gate with its fix, and changes nothing", async () => {
    const org = await seedOrg("gates")
    const run = (argv: string[], rcpt: string | null) =>
      runOrgDeleteCli([org.slug, ...argv], {
        ...quiet,
        recipient: rcpt,
        enqueue: async () => expect.unreachable(),
        prompt: async () => null,
      })

    // No export at all.
    let res = await run(["--yes", org.slug], recipient)
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("liaison org export")
    // An export that never left the server.
    await seedExport(org.orgId, { downloaded: false })
    // What the org holds once its export exists: every later refusal leaves it so.
    const before = await counts(org.orgId)
    res = await run(["--yes", org.slug], recipient)
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("never downloaded")
    // A running export.
    await sql`INSERT INTO kernel.org_exports (org_id, status, requested_via) VALUES (${org.orgId}, 'running', 'cli')`
    res = await run(["--yes", org.slug, "--without-export-i-accept-losing-the-org-data"], recipient)
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("running export")
    await sql`DELETE FROM kernel.org_exports WHERE org_id = ${org.orgId} AND status = 'running'`
    // No recipient, no waiver.
    res = await run(["--yes", org.slug, "--without-export-i-accept-losing-the-org-data"], null)
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("LEGAL_ARCHIVE_RECIPIENT")
    expect(res.message).toContain("--no-legal-archive")
    // An invalid recipient.
    res = await run(
      ["--yes", org.slug, "--without-export-i-accept-losing-the-org-data"],
      "age1notakey",
    )
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("not an age recipient")
    // A wrong confirmation, and no terminal to confirm on.
    res = await run(["--yes", "wrong", "--without-export-i-accept-losing-the-org-data"], recipient)
    expect(res.exitCode).toBe(2)
    res = await run(["--without-export-i-accept-losing-the-org-data"], recipient)
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain(`--yes ${org.slug}`)
    // Usage.
    expect((await runOrgDeleteCli([], quiet)).exitCode).toBe(2)

    const [row] = await sql`SELECT deleting_at FROM kernel.organizations WHERE id = ${org.orgId}`
    expect(row?.deleting_at).toBeNull()
    const ledger = await sql`SELECT 1 FROM kernel.org_deletions WHERE deleted_org_id = ${org.orgId}`
    expect(ledger.length).toBe(0)
    expect(await counts(org.orgId)).toEqual(before)
  })

  it("--dry-run prints the gates and the residue and changes nothing", async () => {
    const org = await seedOrg("dry")
    await seedExport(org.orgId, { downloaded: true })
    const before = await counts(org.orgId)
    const res = await runOrgDeleteCli([org.slug, "--dry-run"], {
      ...quiet,
      recipient,
      enqueue: async () => expect.unreachable(),
    })
    expect(res.exitCode).toBe(0)
    const report = res.report as Record<string, any>
    expect(report.dryRun).toBe(true)
    expect(report.gates.export.ok).toBe(true)
    expect(report.gates.legalArchive.ok).toBe(true)
    expect(report.residue.total).toBeGreaterThan(0)
    expect(report.residue.rows[`${APP_SCHEMA}.legal`]).toBe(1)
    const refused = await runOrgDeleteCli([org.slug, "--dry-run"], { ...quiet, recipient: null })
    expect(refused.exitCode).toBe(2)
    expect((refused.report as Record<string, any>).gates.legalArchive.ok).toBe(false)
    const [row] = await sql`SELECT deleting_at FROM kernel.organizations WHERE id = ${org.orgId}`
    expect(row?.deleting_at).toBeNull()
    expect(await counts(org.orgId)).toEqual(before)
  })
})

describe("liaison org delete: the deletion", () => {
  it("deletes everything (residue 0), leaves the neighbour unchanged, and keeps an archive only the identity opens", async () => {
    const target = await seedOrg("target")
    const neighbour = await seedOrg("neighbour")
    await seedExport(target.orgId, { downloaded: true })
    const neighbourBefore = await counts(neighbour.orgId)

    const res = await runOrgDeleteCli([target.slug, "--yes", target.slug], {
      ...quiet,
      recipient,
      enqueue: worker(),
    })
    expect(res.message).toBeUndefined()
    expect(res.exitCode).toBe(0)
    const ledger = res.report as Record<string, any>
    expect(ledger.status).toBe("completed")
    expect(ledger.operator).toBe("test@host")
    expect(ledger.stepsDone).toEqual(
      expect.arrayContaining([
        "mark",
        "legal-archive",
        "purge",
        "rows",
        "search",
        "verify",
        "org-row",
        "release",
      ]),
    )
    expect(ledger.waivers).toEqual([])
    expect(String(ledger.archiveKey)).toStartWith(`legal-archives/${target.orgId}/`)

    const residue = await residueScan(target.orgId)
    expect(residue.total).toBe(0)
    expect(residue.orgRow).toBe(false)
    expect(await counts(neighbour.orgId)).toEqual(neighbourBefore)

    // The ledger and the archive index survive the purge.
    const [kept] =
      await sql`SELECT status, archive_key FROM kernel.org_deletions WHERE deleted_org_id = ${target.orgId}`
    expect(kept?.status).toBe("completed")
    const [archiveRow] =
      await sql`SELECT object_key, retain_until, recipient FROM kernel.legal_archives WHERE deleted_org_id = ${target.orgId}`
    expect(archiveRow?.object_key).toBe(ledger.archiveKey)
    expect(archiveRow?.recipient).toBe(recipient)
    const years =
      (new Date(archiveRow?.retain_until).getTime() - Date.now()) / (365.25 * 86_400_000)
    expect(Math.round(years)).toBe(10)

    // The archive: age ciphertext; the throwaway identity opens it.
    const encrypted = new Uint8Array(await getObjectBuffer(String(ledger.archiveKey)))
    expect(new TextDecoder().decode(encrypted.subarray(0, 21))).toBe("age-encryption.org/v1")
    const d = new Decrypter()
    d.addIdentity(identity)
    const entries = readTar(await d.decrypt(encrypted))
    const byName = new Map(entries.map((e) => [e.name, new TextDecoder().decode(e.bytes)]))
    const manifest = JSON.parse(byName.get("manifest.json") ?? "{}")
    expect(manifest.org).toEqual({ id: target.orgId, name: "Org target", slug: target.slug })
    expect(manifest.container).toBe("tar")
    expect(manifest.retentionYears).toBe(10)
    const tables = Object.fromEntries(
      ownTables(manifest).map((t: any) => [t.table, { rows: t.rows, reason: t.reason }]),
    )
    expect(tables.legal).toEqual({ rows: 1, reason: "immutable" })
    expect(tables.transmissions).toEqual({ rows: 1, reason: "legalRetention" })
    expect(tables.notes).toBeUndefined()
    expect(manifest.auditLog.rows).toBe(1)
    expect(manifest.files.count).toBe(1)
    const legal = JSON.parse((byName.get(`data/${APP_SCHEMA}.legal.0001.ndjson`) ?? "").trim())
    expect(legal.number).toBe("INV-target-1")
    expect(legal.org_id).toBe(target.orgId)
    const pdf = [...byName].find(([n]) => n.startsWith("files/") && n.endsWith(".pdf"))
    expect(pdf?.[1]).toBe("%PDF-1.7 invoice of target")
    expect(byName.get("data/kernel.audit_log.0001.ndjson")).toContain("invoice.issued")
    // Minimisation: no chat, no ordinary rows or files.
    const all = [...byName.values()].join("\n")
    expect(all).not.toContain("not a legal record")
    expect(all).not.toContain("not legal either")
    expect(all).not.toContain("chat file")
    expect(all).not.toContain(neighbour.orgId)
  }, 60_000)

  it("a crash between steps 4 (rows) and 5 (search) is completed by a re-run", async () => {
    const org = await seedOrg("crash")
    await seedExport(org.orgId, { downloaded: true })
    const first = await runOrgDeleteCli([org.slug, "--yes", org.slug], {
      ...quiet,
      recipient,
      enqueue: worker({
        onPurgeStep: (step) => {
          if (step === "rows") throw new Error("simulated crash after the row purge")
        },
      }),
    })
    expect(first.exitCode).toBe(1)
    const failed = first.report as Record<string, any>
    expect(failed.status).toBe("failed")
    expect(failed.stepsDone).toContain("rows")
    expect(failed.stepsDone).not.toContain("search")
    expect(first.message).toContain("simulated crash")
    const mid = await residueScan(org.orgId)
    expect(mid.orgRow).toBe(true)
    expect(mid.searchDocuments).toBe(1)

    // The re-run resumes (by the org id, through the ledger), without the gates.
    const again = await runOrgDeleteCli([org.orgId, "--yes", org.slug], {
      ...quiet,
      recipient: null,
      enqueue: worker(),
    })
    expect(again.exitCode).toBe(0)
    const done = again.report as Record<string, any>
    expect(done.deletionId).toBe(failed.deletionId)
    expect(done.status).toBe("completed")
    // One archive, written once.
    const archives =
      await sql`SELECT 1 FROM kernel.legal_archives WHERE deleted_org_id = ${org.orgId}`
    expect(archives.length).toBe(1)
    expect((await residueScan(org.orgId)).total).toBe(0)
  }, 60_000)

  it("--abort before step 3 restores the org; nothing of it was deleted", async () => {
    const org = await seedOrg("abort")
    const before = await counts(org.orgId)
    // The job is never run: the deletion stops after step 1 (mark) with the job queued.
    const res = await runOrgDeleteCli(
      [
        org.slug,
        "--yes",
        org.slug,
        "--no-legal-archive",
        "--without-export-i-accept-losing-the-org-data",
        "--timeout",
        "0.2",
      ],
      { ...quiet, recipient: null, enqueue: async () => undefined },
    )
    expect(res.exitCode).toBe(1)
    const queued = res.report as Record<string, any>
    expect(queued.status).toBe("queued")
    expect(queued.waivers.map((w: any) => w.kind).sort()).toEqual([
      "no-legal-archive",
      "without-export",
    ])
    const [marked] = await sql`SELECT deleting_at FROM kernel.organizations WHERE id = ${org.orgId}`
    expect(marked?.deleting_at).not.toBeNull()

    const aborted = await runOrgDeleteCli([org.slug, "--abort"], quiet)
    expect(aborted.exitCode).toBe(0)
    expect((aborted.report as Record<string, any>).status).toBe("aborted")
    const [row] = await sql`SELECT deleting_at FROM kernel.organizations WHERE id = ${org.orgId}`
    expect(row?.deleting_at).toBeNull()
    expect(await counts(org.orgId)).toEqual(before)
    // A job that runs after the abort does nothing.
    await processOrgDeleteJob(
      { deletionId: queued.deletionId, targetOrgId: org.orgId },
      { sleep: noSleep, manifests: MANIFESTS },
    )
    expect(await counts(org.orgId)).toEqual(before)
    expect((await runOrgDeleteCli([org.slug, "--abort"], quiet)).exitCode).toBe(2)
  })

  it("--abort is refused once the purge started", async () => {
    const org = await seedOrg("noabort")
    await sql`INSERT INTO kernel.org_deletions (deleted_org_id, org_slug, org_name, operator, status, steps_done)
      VALUES (${org.orgId}, ${org.slug}, 'x', 'test', 'failed', ARRAY['mark','legal-archive','purge','triggers'])`
    const res = await runOrgDeleteCli([org.slug, "--abort"], quiet)
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("cannot be aborted")
    await sql`DELETE FROM kernel.org_deletions WHERE deleted_org_id = ${org.orgId}`
  })

  it("--export-to saves the latest export to disk and meets the export gate", async () => {
    const org = await seedOrg("exportto")
    const exportId = await seedExport(org.orgId, { downloaded: false })
    const file = path.join(tmpDir, "org.zip")
    const res = await runOrgDeleteCli(
      [org.slug, "--yes", org.slug, "--export-to", file, "--no-legal-archive"],
      { ...quiet, recipient: null, enqueue: worker() },
    )
    expect(res.exitCode).toBe(0)
    expect(await readFile(file, "utf8")).toBe("PK fake export")
    const ledger = res.report as Record<string, any>
    expect(ledger.export).toMatchObject({ exportId, savedTo: file, bytes: 14 })
    expect(ledger.waivers.map((w: any) => w.kind)).toEqual(["no-legal-archive"])
    expect(ledger.archiveKey).toBeNull()
    expect((await residueScan(org.orgId)).total).toBe(0)
  }, 60_000)
})

describe("liaison org delete: review fixes (round 1)", () => {
  it("K1: a legal row written during the settle window is in the archive", async () => {
    const org = await seedOrg("settle")
    await seedExport(org.orgId, { downloaded: true })
    let slept = 0
    const res = await runOrgDeleteCli([org.slug, "--yes", org.slug], {
      ...quiet,
      recipient,
      enqueue: worker({
        // Work admitted just before the mark commits a legal record while the job waits.
        sleep: async () => {
          slept++
          await sql.unsafe(
            `INSERT INTO "${APP_SCHEMA}".legal (org_id, number) VALUES ('${org.orgId}', 'INV-settle-late')`,
          )
        },
      }),
    })
    expect(res.exitCode).toBe(0)
    expect(slept).toBe(1)
    const ledger = res.report as Record<string, any>
    const { byName, manifest } = await openArchive(String(ledger.archiveKey))
    const legal = ownTables(manifest).find((t: any) => t.table === "legal")
    expect(legal.rows).toBe(2)
    expect(byName.get(`data/${APP_SCHEMA}.legal.0001.ndjson`)).toContain("INV-settle-late")
    expect((await residueScan(org.orgId)).total).toBe(0)
  }, 60_000)

  it("K2: issued invoices and credit notes and their lines are archived; a draft and a quote are not", async () => {
    const org = await seedOrg("docs")
    const issued = await seedDoc(org.orgId, "invoice", "issued", "INV-ISSUED-1")
    await seedDoc(org.orgId, "credit_note", "issued", "CN-ISSUED-1")
    await seedDoc(org.orgId, "invoice", "voided", "INV-VOIDED-1")
    const draft = await seedDoc(org.orgId, "invoice", "draft", "INV-DRAFT-1")
    await seedDoc(org.orgId, "quote", "issued", "QUOTE-1")
    await seedAppFile(org.orgId, issued, "INV-ISSUED-1.pdf", "%PDF issued")
    await seedAppFile(org.orgId, draft, "INV-DRAFT-1.pdf", "%PDF draft")
    const { byName, manifest } = await archiveDirect(org)
    const tables = Object.fromEntries(ownTables(manifest).map((t: any) => [t.table, t]))
    expect(tables.docs?.rows).toBe(3)
    expect(tables.docs?.reason).toBe("legalRetention")
    expect(tables.doc_lines?.rows).toBe(3)
    const all = [...byName.values()].join("\n")
    for (const kept of ["INV-ISSUED-1", "CN-ISSUED-1", "INV-VOIDED-1", "line of CN-ISSUED-1"]) {
      expect(all).toContain(kept)
    }
    for (const dropped of ["INV-DRAFT-1", "QUOTE-1", "%PDF draft"]) {
      expect(all).not.toContain(dropped)
    }
    expect(all).toContain("%PDF issued")
  }, 60_000)

  it("K5: a file name too long for tar (multi-byte) is cut, never fatal", async () => {
    const org = await seedOrg("names")
    const issued = await seedDoc(org.orgId, "invoice", "issued", "INV-NAMES-1")
    const cjk = `${"請求書".repeat(20)}.pdf`
    const emoji = `${"😀".repeat(40)}.pdf`
    await seedAppFile(org.orgId, issued, cjk, "%PDF cjk")
    await seedAppFile(org.orgId, issued, emoji, "%PDF emoji")
    const { byName, manifest } = await archiveDirect(org)
    const files = [...byName.keys()].filter((n) => n.startsWith("files/"))
    expect(manifest.files.count).toBe(3)
    for (const n of files) {
      const last = n.split("/").pop() ?? ""
      expect(Buffer.byteLength(last)).toBeLessThanOrEqual(100)
      expect(last).not.toContain("�")
      expect(last.endsWith(".pdf")).toBe(true)
    }
    // The full names are in files.ndjson.
    expect(byName.get("files.ndjson")).toContain(cjk)
  }, 60_000)

  it("K6: a legal file whose object is missing is recorded, never fatal", async () => {
    const org = await seedOrg("missing")
    const issued = await seedDoc(org.orgId, "invoice", "issued", "INV-MISSING-1")
    const gone = await seedAppFile(org.orgId, issued, "gone.pdf", "%PDF gone", { missing: true })
    const { manifest } = await archiveDirect(org)
    expect(manifest.files.missing).toEqual([
      expect.objectContaining({ storageKey: gone, filename: "gone.pdf" }),
    ])
    // The seeded legal PDF is still archived.
    expect(manifest.files.count).toBe(1)
  }, 60_000)

  it("K3: a downloaded export older than 24 h does not meet the export gate", async () => {
    const org = await seedOrg("stale")
    await seedExport(org.orgId, { downloaded: true, hoursAgo: 25 })
    const res = await runOrgDeleteCli([org.slug, "--yes", org.slug], {
      ...quiet,
      recipient,
      enqueue: async () => expect.unreachable(),
    })
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("no completed export in the last 24 h")
  })

  it("K3: --abort after the job wrote the archive deletes it", async () => {
    const org = await seedOrg("abortarchive")
    await seedExport(org.orgId, { downloaded: true })
    const first = await runOrgDeleteCli([org.slug, "--yes", org.slug], {
      ...quiet,
      recipient,
      enqueue: worker({
        onArchived: () => {
          throw new Error("simulated crash after the archive")
        },
      }),
    })
    expect(first.exitCode).toBe(1)
    const failed = first.report as Record<string, any>
    expect(failed.stepsDone).toContain("legal-archive")
    expect(failed.stepsDone).not.toContain("purge")
    const key = String(failed.archiveKey)
    expect(key).toStartWith(`legal-archives/${org.orgId}/`)
    await headObject(key)

    const aborted = await runOrgDeleteCli([org.slug, "--abort"], quiet)
    expect(aborted.exitCode).toBe(0)
    await expect(headObject(key)).rejects.toThrow()
    const [row] = await sql`SELECT deleted_at FROM kernel.legal_archives WHERE object_key = ${key}`
    expect(row?.deleted_at).not.toBeNull()
    const [o] = await sql`SELECT deleting_at FROM kernel.organizations WHERE id = ${org.orgId}`
    expect(o?.deleting_at).toBeNull()
  }, 60_000)

  it("K3: a crash after the org row is gone resumes by slug and by id through the ledger", async () => {
    const org = await seedOrg("gone")
    await seedExport(org.orgId, { downloaded: true })
    const crashAt = (at: string) =>
      worker({
        onPurgeStep: (step) => {
          if (step === at) throw new Error(`simulated crash after ${at}`)
        },
      })
    const first = await runOrgDeleteCli([org.slug, "--yes", org.slug], {
      ...quiet,
      recipient,
      enqueue: crashAt("org-row"),
    })
    expect(first.exitCode).toBe(1)
    const failed = first.report as Record<string, any>
    expect(failed.stepsDone).toContain("org-row")
    expect((await residueScan(org.orgId)).orgRow).toBe(false)

    // By slug: the org row is gone, the ledger names it.
    const bySlug = await runOrgDeleteCli([org.slug, "--yes", org.slug], {
      ...quiet,
      recipient: null,
      enqueue: crashAt("release"),
    })
    expect(bySlug.exitCode).toBe(1)
    expect((bySlug.report as Record<string, any>).deletionId).toBe(failed.deletionId)
    expect(bySlug.message).toContain("simulated crash after release")

    // By id.
    const byId = await runOrgDeleteCli([org.orgId, "--yes", org.slug], {
      ...quiet,
      recipient: null,
      enqueue: worker(),
    })
    expect(byId.exitCode).toBe(0)
    const done = byId.report as Record<string, any>
    expect(done.deletionId).toBe(failed.deletionId)
    expect(done.status).toBe("completed")
    const archives =
      await sql`SELECT 1 FROM kernel.legal_archives WHERE deleted_org_id = ${org.orgId}`
    expect(archives.length).toBe(1)
  }, 60_000)

  it("K3: the job runs through a real BullMQ worker; the dispatch does not drop it", async () => {
    const org = await seedOrg("bullmq")
    await seedExport(org.orgId, { downloaded: true })
    registerOrgDeleteJobWorker({ sleep: noSleep, manifests: MANIFESTS, heartbeatMs: 1000 })
    try {
      // No `enqueue` seam: the CLI hands the job to the queue as in production.
      const res = await runOrgDeleteCli([org.slug, "--yes", org.slug, "--timeout", "45"], {
        ...quiet,
        recipient,
      })
      expect(res.message).toBeUndefined()
      expect(res.exitCode).toBe(0)
      expect((res.report as Record<string, any>).status).toBe("completed")
      expect((await residueScan(org.orgId)).total).toBe(0)
    } finally {
      await JobsTestAccess.getWorkerForQueue("kernel-bulk")?.close(true)
      await getJobQueue("kernel", ORG_DELETE_JOB)
        .obliterate({ force: true })
        .catch(() => undefined)
    }
  }, 90_000)

  it("K4: an --abort landing between the job's read and its mark leaves the org restored", async () => {
    const org = await seedOrg("race")
    // The CLI crashed before step 1: a queued deletion, the org not marked.
    const row = await createOrgDeletion({
      orgId: org.orgId,
      slug: org.slug,
      name: "x",
      operator: "test",
      waivers: [],
      export: null,
      legalArchiveRecipient: null,
    })
    await sql`UPDATE kernel.org_deletions SET status = 'queued' WHERE id = ${row.id}`
    const real = deletingModule.readOrgDeletion
    let raced = false
    const spy = spyOn(deletingModule, "readOrgDeletion").mockImplementation(async (id: string) => {
      if (!raced && id === org.orgId) {
        raced = true
        const aborted = await runOrgDeleteCli([org.slug, "--abort"], quiet)
        expect(aborted.exitCode).toBe(0)
      }
      return real(id)
    })
    try {
      await processOrgDeleteJob(
        { deletionId: row.id, targetOrgId: org.orgId },
        { sleep: noSleep, manifests: MANIFESTS },
      )
    } finally {
      spy.mockRestore()
    }
    expect(raced).toBe(true)
    const [o] = await sql`SELECT deleting_at FROM kernel.organizations WHERE id = ${org.orgId}`
    expect(o?.deleting_at).toBeNull()
    const [l] = await sql`SELECT status FROM kernel.org_deletions WHERE id = ${row.id}`
    expect(l?.status).toBe("aborted")
  }, 60_000)

  it("K8: --export-to with no export to save is refused; an ignored --no-legal-archive is said", async () => {
    const org = await seedOrg("flags")
    const file = path.join(tmpDir, "nothing.zip")
    const res = await runOrgDeleteCli(
      [
        org.slug,
        "--yes",
        org.slug,
        "--export-to",
        file,
        "--without-export-i-accept-losing-the-org-data",
        "--no-legal-archive",
      ],
      { ...quiet, recipient: null, enqueue: async () => expect.unreachable() },
    )
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("nothing to save")

    const warned: string[] = []
    const kept = await runOrgDeleteCli(
      [
        org.slug,
        "--yes",
        org.slug,
        "--no-legal-archive",
        "--without-export-i-accept-losing-the-org-data",
        "--timeout",
        "0.2",
      ],
      { ...quiet, warn: (l) => warned.push(l), recipient, enqueue: async () => undefined },
    )
    expect(kept.exitCode).toBe(1)
    expect(warned.join("\n")).toContain("--no-legal-archive ignored")
    expect((await runOrgDeleteCli([org.slug, "--abort"], quiet)).exitCode).toBe(0)
  })
})

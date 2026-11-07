// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Imported legacy documents on real Postgres + object storage, through the real kernel path
// (executeTool -> sandbox handler -> bridge), as a user holding the issuer's scopes (never admin).
// Documents and their PDFs are seeded exactly as the legacy importer writes them: a
// system-uploaded kernel file on the `pdf` fileParent, referenced by `pdf_file_id`, with
// `external_refs.import_source` / `import_file_id`.
//
// - Marking an imported document paid keeps its PDF: same file id, same bytes.
// - One imported document was re-rendered over before the guard existed (its `pdf_file_id` points
//   at a rendered copy): the dry run reports it, the approved run restores it and records a
//   `legacy_import` legal original whose SHA-256 is that of the imported bytes; a batch stops
//   before max_bytes and reports what remains; a final run finds nothing left.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { putObject } from "~/infra/storage/object-storage"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { buildStorageKey } from "~/modules/files/service"
import { acquireTestLock, releaseTestLock, superuserUrlForTestDb } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

const ORG = "00000000-0000-4000-8000-0000000e9101"
const USER = "00000000-0000-4000-8000-0000000e9102"
const THREAD = "00000000-0000-4000-8000-0000000e9103"
// Ids in ascending order: the backfill walks documents by id.
const DOC_A = "00000000-0000-4000-8000-0000000e9111" // imported, on its imported PDF
const DOC_B = "00000000-0000-4000-8000-0000000e9112" // imported, re-rendered over
const DOC_C = "00000000-0000-4000-8000-0000000e9113" // imported, on its imported PDF
const FILE_A = "00000000-0000-4000-8000-0000000e9121"
const FILE_B = "00000000-0000-4000-8000-0000000e9122"
const FILE_C = "00000000-0000-4000-8000-0000000e9123"
const RENDER_B = "00000000-0000-4000-8000-0000000e9124"

const CEO_ROLE_SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:approve",
]

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: CEO_ROLE_SCOPES,
  dimensionGrants: {},
}

function pdfBytes(seed: number, n: number): Buffer {
  const head = Buffer.from(`%PDF-1.4\n% imported legacy document ${seed}\n`, "latin1")
  const body = Buffer.alloc(n - head.length)
  for (let i = 0; i < body.length; i++) body[i] = (seed * 17 + i * 7) & 0xff
  return Buffer.concat([head, body])
}
const BYTES: Record<string, Buffer> = {
  [FILE_A]: pdfBytes(1, 2000),
  [FILE_B]: pdfBytes(2, 3000),
  [FILE_C]: pdfBytes(3, 3000),
  [RENDER_B]: pdfBytes(4, 1500),
}
const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex")

type Data = Record<string, unknown>

async function callTool(
  toolName: string,
  params: Record<string, unknown>,
  origin: "in-app-agent" | "human-ui",
) {
  return executeTool({ toolName, orgId: ORG, actor, params, threadId: THREAD, origin })
}

/** Call the gated backfill, then approve it as the issuer (who holds invoicing:approve). */
async function approvedBackfill(params: Record<string, unknown>): Promise<Data> {
  const res = await callTool(
    "invoicing:einvoicing_backfill_legacy_originals",
    params,
    "in-app-agent",
  )
  const approvalId = res.blocked?.approvalRequestId as string | undefined
  expect(approvalId).toBeTruthy()
  const decided = await decideApproval({
    orgId: ORG,
    requestId: approvalId!,
    actor,
    decision: "approve",
  })
  expect(decided.status).toBe("approved")
  const [exec] = await sql<Array<{ result: Data | null }>>`
    SELECT result FROM kernel.approved_handler_executions WHERE approval_request_id = ${approvalId!}`
  return (exec?.result ?? {}) as Data
}

async function fileBytes(fileId: string): Promise<Buffer> {
  const [row] = await sql<Array<{ storage_key: string }>>`
    SELECT storage_key FROM kernel.files WHERE id = ${fileId}`
  expect(row).toBeTruthy()
  return (await getObjectBytes(row!.storage_key, { maxBytes: 25 * 1024 * 1024 })).bytes
}

async function docRow(id: string): Promise<Data> {
  const [row] = await sql<Array<Data>>`
    SELECT pdf_file_id::text AS pdf_file_id, payment_status, legal_original_id::text AS legal_original_id,
           legal_original_sha256, lifecycle_log
    FROM app_invoicing.documents WHERE id = ${id}`
  return row as Data
}

/**
 * Remove this test org's rows. Legal originals (and the Factur-X copies) are write-once and
 * retained by a kernel trigger that refuses every application role, so the removal runs the way
 * an operator removes a whole organisation: a superuser session with the retention override.
 * Also run before seeding, so rows left by an interrupted run never collide with the fixed ids.
 */
async function removeTestOrgRows(): Promise<void> {
  const superUrl = superuserUrlForTestDb()
  if (!superUrl)
    throw new Error(
      "a superuser URL for the test database is required to remove retained test rows",
    )
  const { default: postgres } = await import("postgres")
  const su = postgres(superUrl, { max: 1, onnotice: () => {} })
  try {
    await su.begin(async (tx) => {
      await tx`SET LOCAL liaison.retention_override = 'on'`
      await tx`DELETE FROM kernel.approved_handler_executions
        WHERE approval_request_id IN (SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG})`
      await tx`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
      await tx`DELETE FROM app_invoicing.legal_originals WHERE org_id = ${ORG}`
      await tx`DELETE FROM app_invoicing.facturx_files WHERE org_id = ${ORG}`
      await tx`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
      await tx`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
      await tx`DELETE FROM kernel.files WHERE org_id = ${ORG}`
    })
  } finally {
    await su.end()
  }
}

describe("imported legacy originals (real Postgres + storage, issuer scopes)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Imported Original Org', 'imported-original-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'imported-original@test.com', 'hash', 'Original Tester', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'imported-original-thread', 'agent_chat', ${USER}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
    for (const scope of CEO_ROLE_SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }

    await initSandboxPool()
    await initWorkerPool()
    await registerApps([bundledDescriptor("invoicing") as never], ORG)
    // The production kernel.files SELECT policy from the registered fileParents (boot does this):
    // a file is readable only through the parent row that references it. Boot builds it from the
    // installed catalog, which need not hold the invoicing app registered from source here.
    await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
    await removeTestOrgRows()

    const issuerId = randomUUID()
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, vat_id, address, default_currency, default_language)
      VALUES (${issuerId}, ${ORG}, 'Fictive Issuer SAS', 'FR', 'FR60902000009',
        '2 rue Test, 75001 Paris', 'EUR', 'fr')`

    // Files exactly as the importer stores them: system-uploaded, `pdf` parent keyed by their own id.
    const filenames: Record<string, string> = {
      [FILE_A]: "2001.pdf",
      [FILE_B]: "2002.pdf",
      [FILE_C]: "2003.pdf",
      [RENDER_B]: "invoice-2002.pdf",
    }
    for (const [fileId, filename] of Object.entries(filenames)) {
      const body = BYTES[fileId]!
      const storageKey = buildStorageKey({
        orgId: ORG,
        app: "invoicing",
        entityType: "pdf",
        entityId: fileId,
        filename,
      })
      await putObject({ key: storageKey, body, contentType: "application/pdf" })
      await sql`INSERT INTO kernel.files
        (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
        VALUES (${fileId}, ${ORG}, 'invoicing', 'pdf', ${fileId}, ${filename}, 'application/pdf',
          ${body.byteLength}, ${storageKey}, NULL)`
    }
    const docs: Array<[string, string, string, string]> = [
      [DOC_A, "2001", FILE_A, FILE_A],
      [DOC_B, "2002", FILE_B, RENDER_B],
      [DOC_C, "2003", FILE_C, FILE_C],
    ]
    let n = 2001
    for (const [id, number, importFile, current] of docs) {
      const refs = { import_source: `${number}.pdf`, import_file_id: importFile }
      const lifecycle = [
        { ts: "2025-04-01T00:00:00.000Z", event: "issued", source: "import" },
        {
          ts: "2026-01-02T00:00:00.000Z",
          event: "imported",
          source: "import",
          file: `${number}.pdf`,
        },
      ]
      await sql`INSERT INTO app_invoicing.documents
        (id, org_id, type, status, payment_status, number, number_int, year_of_issue, issuer_profile_id,
         counterparty_name, counterparty_country, currency, subtotal_minor, tax_total_minor, grand_total_minor,
         tax_treatment, incoterm, issued_at, pdf_file_id, pdf_status, external_refs, lifecycle_log)
        VALUES (${id}, ${ORG}, 'invoice', 'issued', 'unpaid', ${number}, ${n}, 2025, ${issuerId},
         'Studio Fictif GmbH', 'DE', 'EUR', 10000, 0, 10000, 'intra_eu_b2b', 'DAP', '2025-04-01',
         ${current}, 'ready', ${JSON.stringify(refs)}::jsonb, ${JSON.stringify(lifecycle)}::jsonb)`
      n += 1
    }
  }, 60_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    // Back to the policy an empty registry yields.
    await rebuildFilesSelectPolicy()
    await removeTestOrgRows()
    await releaseTestLock()
  }, 60_000)

  it("marking an imported document paid keeps its PDF: same file id, same bytes", async () => {
    const before = sha256(await fileBytes(FILE_A))
    const res = await callTool(
      "invoicing:documents_mark_paid",
      { document_id: DOC_A, paid_date: "2025-04-20" },
      "human-ui",
    )
    expect((res.data as Data)?.status).toBe("completed")
    const doc = await docRow(DOC_A)
    expect(doc.payment_status).toBe("paid")
    expect(doc.pdf_file_id).toBe(FILE_A)
    expect(sha256(await fileBytes(FILE_A))).toBe(before)
    expect(before).toBe(sha256(BYTES[FILE_A]!))
    const [files] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.files WHERE org_id = ${ORG}`
    expect(files?.n).toBe(4)
  }, 120_000)

  it("the approved dry run reports the re-rendered document and writes nothing", async () => {
    const report = await approvedBackfill({ dry_run: true })
    expect(report).toMatchObject({
      status: "ok",
      dry_run: true,
      processed: 3,
      repointed: 1,
      remaining: 0,
    })
    const [lo] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM app_invoicing.legal_originals WHERE org_id = ${ORG}`
    expect(lo?.n).toBe(0)
    expect((await docRow(DOC_B)).pdf_file_id).toBe(RENDER_B)
  }, 120_000)

  it("a batch stops before max_bytes and reports what remains", async () => {
    const report = await approvedBackfill({ dry_run: false, max_bytes: 4000 })
    expect(report).toMatchObject({
      status: "ok",
      dry_run: false,
      processed: 1,
      repointed: 0,
      remaining: 2,
      bytes: 2000,
    })
    const a = await docRow(DOC_A)
    expect(a.legal_original_sha256).toBe(sha256(BYTES[FILE_A]!))
    // B was left for the next batch untouched.
    expect((await docRow(DOC_B)).pdf_file_id).toBe(RENDER_B)
  }, 120_000)

  it("the approved run restores the re-rendered document and records the imported bytes' hash", async () => {
    const report = await approvedBackfill({ dry_run: false })
    expect(report).toMatchObject({
      status: "ok",
      processed: 2,
      repointed: 1,
      remaining: 0,
      bytes: 6000,
    })

    const b = await docRow(DOC_B)
    expect(b.pdf_file_id).toBe(FILE_B)
    const restored = (b.lifecycle_log as Data[]).filter(
      (e) => e.event === "legal_original_restored",
    )
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ from_file_id: RENDER_B, to_file_id: FILE_B })

    const rows = await sql<Array<Data>>`
      SELECT id::text AS id, document_id::text AS document_id, kind, file_id::text AS file_id, sha256,
             byte_size::int AS byte_size
      FROM app_invoicing.legal_originals WHERE org_id = ${ORG} ORDER BY document_id`
    expect(rows.map((r) => r.document_id)).toEqual([DOC_A, DOC_B, DOC_C])
    for (const [row, source] of [
      [rows[0]!, FILE_A],
      [rows[1]!, FILE_B],
      [rows[2]!, FILE_C],
    ] as const) {
      expect(row.kind).toBe("legacy_import")
      expect(row.sha256).toBe(sha256(BYTES[source]!))
      expect(row.byte_size).toBe(BYTES[source]!.byteLength)
      // The legal original's own copy, on its own fileParent, byte for byte the imported file.
      const [copy] = await sql<Array<{ entity_type: string; entity_id: string }>>`
        SELECT entity_type, entity_id FROM kernel.files WHERE id = ${row.file_id as string}`
      expect(copy).toMatchObject({ entity_type: "legal_original", entity_id: row.id })
      expect(sha256(await fileBytes(row.file_id as string))).toBe(row.sha256 as string)
      const doc = await docRow(row.document_id as string)
      expect(doc.legal_original_id).toBe(row.id)
      expect(doc.legal_original_sha256).toBe(row.sha256)
    }
    // The imported file itself is untouched.
    expect(sha256(await fileBytes(FILE_B))).toBe(sha256(BYTES[FILE_B]!))
  }, 120_000)

  it("a second run finds nothing left", async () => {
    const report = await approvedBackfill({ dry_run: false })
    expect(report).toMatchObject({ status: "ok", processed: 0, repointed: 0, remaining: 0 })
  }, 120_000)
})

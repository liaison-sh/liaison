// SPDX-License-Identifier: FSL-1.1-ALv2
// `invoicing.document` end to end with the real invoicing bundle, installed
// the way a deployment installs it, run in the sandbox: documents and lines
// written by the bundle, the original PDF attached by the host as the
// document's own `pdf` file, the numbering sequence raised past the imported
// numbers, a re-run that creates nothing, and an undo that removes the PDF
// copies and keeps a document someone worked on since.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto, { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { decideApproval } from "~/modules/approvals/decide"
import { executeTool } from "~/modules/apps/execute-tool"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { runImport } from "~/modules/imports/runner"
import { importServiceClient } from "~/modules/imports/service-client"
import type { SourceItem } from "~/modules/imports/source"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { allocateSequence } from "~/modules/sequences/allocate"
import { type AppInstallSnapshot, snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Apps this file installs are instance-wide rows: put them back after it.
let installs: AppInstallSnapshot | null = null

let installRoot = ""
let prevAppsDir: string | undefined
let orgId = ""
let otherOrgId = ""
let adminId = ""
let otherAdminId = ""
let issuerId = ""
let threadId = ""
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

/** A PDF only `ownerId` can see (uploaded to a thread they alone are in). */
async function uploadedPdf(inOrg: string, ownerId: string, body: string): Promise<string> {
  const fileId = crypto.randomUUID()
  const storageKey = `${inOrg}/invoicing-import-test/${fileId}.pdf`
  await putObject({ key: storageKey, body: Buffer.from(body), contentType: "application/pdf" })
  await withPrivilegedDb(inOrg, "t", async (tx) => {
    const threadId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${threadId}::uuid, ${inOrg}::uuid, ${`inv-${threadId.slice(0, 8)}`}, 'upload', ${ownerId}::uuid)
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}::uuid, ${ownerId}::uuid, ${inOrg}::uuid, 'owner')
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                size_bytes, storage_key, uploaded_by)
      VALUES (${fileId}::uuid, ${inOrg}::uuid, 'kernel', 'thread', ${threadId}, 'original.pdf',
              'application/pdf', ${Buffer.byteLength(body)}, ${storageKey}, ${ownerId}::uuid)
    `)
  })
  return fileId
}

function recordsOf(records: Array<Record<string, unknown>>): {
  type: "records"
  records: SourceItem[]
} {
  return { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) }
}

const invoice = (
  ref: string,
  numberInt: number,
  pdf: string,
  extra: Record<string, unknown> = {},
) => ({
  externalRef: ref,
  type: "invoice",
  number: ref,
  numberInt,
  issueDate: "2025-05-06",
  currency: "EUR",
  counterparty: { name: "Contoso", country: "DE" },
  lines: [
    {
      description: "Controller",
      quantity: 1,
      unitPriceMinor: 120000,
      taxRateBp: 0,
      totalMinor: 120000,
    },
  ],
  taxTotalMinor: 0,
  grandTotalMinor: 120000,
  amountPaidMinor: 120000,
  pdf: { fileId: pdf },
  ...extra,
})

beforeAll(async () => {
  await acquireTestLock()
  installs = await snapshotAppInstalls()
  installRoot = mkdtempSync(join(tmpdir(), "invoicing-import-install-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
  orgId = (await ensureOrg({ slug: `imp-inv-${tag()}`, name: "Invoicing Import" })).orgId
  otherOrgId = (await ensureOrg({ slug: `imp-inv2-${tag()}`, name: "Invoicing Import B" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-inv-1!",
      role: "admin",
    })
  ).userId
  otherAdminId = (
    await ensureUser({
      orgId: otherOrgId,
      email: `owner-${tag()}@contoso.example`,
      name: "Owner",
      password: "pw-inv-1!",
      role: "admin",
    })
  ).userId
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../bundled-apps/invoicing/app.manifest.json"),
      "utf8",
    ),
  ) as { scopes: string[] }
  await installAppFromTarball({
    tarballPath: firstPartyAppTarball("invoicing"),
    installedBy: adminId,
    grantedScopes: manifest.scopes,
  })
  await reloadInstalledApps(orgId)
  await rebuildFilesSelectPolicy()
  const [issuer] = await sql`
    INSERT INTO app_invoicing.issuer_profiles (org_id, legal_name, country, default_currency)
    VALUES (${orgId}, ${`Fabrikam ${tag()}`}, 'FR', 'EUR') RETURNING id`
  issuerId = String(issuer!.id)
  threadId = crypto.randomUUID()
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}, ${orgId}, ${`inv-imp-${tag()}`}, 'agent_chat', ${adminId})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}, ${adminId}, ${orgId}, 'admin')`
}, 600_000)

afterAll(async () => {
  await shutdownWorkerPool()
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  await installs?.restore()
  await releaseTestLock()
}, 120_000)

describe("invoicing.document with the real bundle", () => {
  it("imports documents with their PDFs, raises the numbering, re-runs to nothing, and undoes", async () => {
    const label = `erp${tag()}`
    const [p1, p2, p3] = await Promise.all(
      ["%PDF one", "%PDF two", "%PDF three"].map((b) => uploadedPdf(orgId, adminId, b)),
    )
    const records = [
      invoice("INV-2001", 2001, p1!),
      invoice("INV-2002", 2002, p2!, { amountPaidMinor: 0 }),
      {
        ...invoice("CN-3", 3, p3!),
        type: "credit_note",
        grandTotalMinor: -120000,
        lines: [
          {
            description: "Refund",
            quantity: 1,
            unitPriceMinor: -120000,
            taxRateBp: 0,
            totalMinor: -120000,
          },
        ],
        amountPaidMinor: undefined,
        originalExternalRef: "INV-2002",
      },
    ]
    const first = await runImport({
      orgId,
      actor: admin(),
      kinds: ["invoicing.document"],
      source: recordsOf(records),
      sourceLabel: label,
      mode: "cli",
    })
    expect(first.errors).toEqual([])
    expect(first.counts["invoicing.document"]).toEqual({ created: 3, skipped: 0, failed: 0 })

    const docs = await sql`
      SELECT id, number, status, payment_status, pdf_file_id, pdf_status, original_document_id
      FROM app_invoicing.documents WHERE org_id = ${orgId} AND external_ref LIKE ${`${label}:%`}
      ORDER BY number`
    const by = new Map(docs.map((d) => [d.number, d]))
    expect([by.get("INV-2001")!.status, by.get("INV-2002")!.status]).toEqual(["paid", "issued"])
    expect(by.get("CN-3")!.original_document_id).toBe(by.get("INV-2002")!.id)
    // The PDF is the document's own, self-parented `pdf` file, a copy of the upload.
    const pdfId = String(by.get("INV-2001")!.pdf_file_id)
    const [file] = await sql`
      SELECT app, entity_type, entity_id, storage_key, copied_from_id FROM kernel.files WHERE id = ${pdfId}`
    expect([file!.app, file!.entity_type, file!.entity_id, file!.copied_from_id]).toEqual([
      "invoicing",
      "pdf",
      pdfId,
      p1,
    ])
    expect(String(await getObjectBuffer(String(file!.storage_key)))).toBe("%PDF one")
    expect(
      (await sql`SELECT 1 FROM app_invoicing.legal_originals WHERE org_id = ${orgId}`).length,
    ).toBe(0)

    // Numbering continues after the imported numbers.
    const key = `invoicing:doc_number:${issuerId}:invoice:2025`
    const [seq] = await sql`
      SELECT value::int AS value FROM kernel.app_sequences WHERE org_id = ${orgId} AND key = ${key}`
    expect(seq!.value).toBe(2002)
    const next = await withPrivilegedDb(orgId, "t", (tx) =>
      allocateSequence(importServiceClient(tx), { orgId, callingAppId: "invoicing", key }),
    )
    expect(next.value).toBe(2003)

    const again = await runImport({
      orgId,
      actor: admin(),
      kinds: ["invoicing.document"],
      source: recordsOf(records),
      sourceLabel: label,
      mode: "cli",
    })
    expect(again.counts["invoicing.document"]).toEqual({ created: 0, skipped: 3, failed: 0 })

    // The documents are marked imported, with the host's copy as their file.
    const refs = await sql`
      SELECT number, external_refs->>'import_source' AS src, external_refs->>'import_file_id' AS file,
             pdf_file_id::text AS pdf
      FROM app_invoicing.documents WHERE org_id = ${orgId} AND external_ref LIKE ${`${label}:%`}`
    for (const r of refs) {
      expect(r.src).toBe(`${label}:${r.number}`)
      expect(r.file).toBe(r.pdf)
    }

    // Marking an imported invoice paid keeps its PDF: no render over the original.
    const unpaid = by.get("INV-2002")!
    const unpaidPdf = String(unpaid.pdf_file_id)
    const paidRes = await executeTool({
      toolName: "invoicing:documents_mark_paid",
      orgId,
      actor: admin(),
      params: { document_id: unpaid.id, paid_date: "2025-06-01" },
      threadId,
      origin: "human-ui",
    })
    expect((paidRes.data as Record<string, unknown>)?.status).toBe("completed")
    const [afterPaid] = await sql`
      SELECT payment_status, pdf_file_id::text AS pdf FROM app_invoicing.documents WHERE id = ${unpaid.id}`
    expect([afterPaid!.payment_status, afterPaid!.pdf]).toEqual(["paid", unpaidPdf])
    const [unpaidFile] = await sql`SELECT storage_key FROM kernel.files WHERE id = ${unpaidPdf}`
    expect(String(await getObjectBuffer(String(unpaidFile!.storage_key)))).toBe("%PDF two")

    // The real legal-original backfill records one imported document from its PDF.
    const gated = await executeTool({
      toolName: "invoicing:einvoicing_backfill_legacy_originals",
      orgId,
      actor: admin(),
      params: { dry_run: false, limit: 1 },
      threadId,
      origin: "in-app-agent",
    })
    const approvalId = gated.blocked?.approvalRequestId as string | undefined
    expect(approvalId).toBeTruthy()
    const decided = await decideApproval({
      orgId,
      requestId: approvalId!,
      actor: admin(),
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    const recorded = await sql`
      SELECT d.id::text AS id, d.legal_original_sha256 AS sha, d.pdf_file_id::text AS pdf
      FROM app_invoicing.documents d
      WHERE d.org_id = ${orgId} AND d.external_ref LIKE ${`${label}:%`} AND d.legal_original_id IS NOT NULL`
    expect(recorded.length).toBe(1)
    const backfilled = recorded[0]!
    const [bytes] = await sql`SELECT storage_key FROM kernel.files WHERE id = ${backfilled.pdf}`
    const original = await getObjectBuffer(String(bytes!.storage_key))
    expect(backfilled.sha).toBe(createHash("sha256").update(original).digest("hex"))

    // Undo keeps the document with a legal original and the one paid since,
    // and removes the rest with their PDF copies.
    const keep = new Set([String(backfilled.id), String(unpaid.id)])
    const report = await undoImportRun(orgId, first.runId, { userId: adminId })
    for (const id of keep) expect(report.refused.map((r) => r.id)).toContain(id)
    const left = await sql`
      SELECT id::text AS id FROM app_invoicing.documents WHERE org_id = ${orgId} AND external_ref LIKE ${`${label}:%`}`
    expect(new Set(left.map((r) => String(r.id)))).toEqual(keep)
    for (const d of docs) {
      if (keep.has(String(d.id))) continue
      expect((await sql`SELECT 1 FROM kernel.files WHERE id = ${d.pdf_file_id}`).length).toBe(0)
    }
  }, 300_000)

  it("a record with an invalid line leaves no document behind", async () => {
    const label = `bl${tag()}`
    const pdf = await uploadedPdf(orgId, adminId, "%PDF bad line")
    const run = await runImport({
      orgId,
      actor: admin(),
      kinds: ["invoicing.document"],
      source: recordsOf([
        invoice("INV-7001", 7001, pdf, {
          lines: [
            { description: "ok", quantity: 1, unitPriceMinor: 100, taxRateBp: 0, totalMinor: 100 },
            {
              description: "bad",
              quantity: 1,
              unitPriceMinor: "12.50",
              taxRateBp: 0,
              totalMinor: 100,
            },
          ],
        }),
      ]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(run.counts["invoicing.document"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    const docs = await sql`
      SELECT 1 FROM app_invoicing.documents WHERE org_id = ${orgId} AND external_ref LIKE ${`${label}:%`}`
    expect(docs.length).toBe(0)
  }, 300_000)

  it("a preview refuses what the run would: no issuer, then several; one issuer passes", async () => {
    // The walk's failure: a preview counted 4 created, 0 failed, and the run it
    // approved then refused all 4 with issuer_ambiguous.
    const bare = (await ensureOrg({ slug: `imp-inv3-${tag()}`, name: "No Issuer" })).orgId
    const bareAdmin = (
      await ensureUser({
        orgId: bare,
        email: `owner-${tag()}@northwind.example`,
        name: "Owner",
        password: "pw-inv-1!",
        role: "admin",
      })
    ).userId
    await reloadInstalledApps(bare)
    const actor: UserContext = {
      actorType: "user",
      userId: bareAdmin,
      orgId: bare,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    const pdf = await uploadedPdf(bare, bareAdmin, "%PDF preview")
    const preview = () =>
      runImport({
        orgId: bare,
        actor,
        kinds: ["invoicing.document"],
        source: recordsOf([invoice("INV-5001", 5001, pdf), invoice("INV-5002", 5002, pdf)]),
        sourceLabel: `pv${tag()}`,
        mode: "cli",
        dryRun: true,
      })

    const none = await preview()
    expect(none.counts["invoicing.document"]).toEqual({ created: 0, skipped: 0, failed: 2 })
    expect(String(none.errors[0]?.error)).toMatch(
      /^issuer_missing: the org has no issuer profile yet\. Ask the person/,
    )

    await sql`
      INSERT INTO app_invoicing.issuer_profiles (org_id, legal_name, country, default_currency)
      VALUES (${bare}, 'Northwind A', 'FR', 'EUR'), (${bare}, 'Northwind B', 'FR', 'EUR')`
    const several = await preview()
    expect(several.counts["invoicing.document"]).toEqual({ created: 0, skipped: 0, failed: 2 })
    expect(String(several.errors[0]?.error)).toMatch(/^issuer_ambiguous: the org has several/)

    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${bare} AND legal_name = 'Northwind B'`
    const one = await preview()
    expect(one.counts["invoicing.document"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    // A preview writes nothing.
    expect(await sql`SELECT 1 FROM app_invoicing.documents WHERE org_id = ${bare}`).toHaveLength(0)
  }, 300_000)

  it("a preview refuses a number an earlier batch of the run uses", async () => {
    const pdf = await uploadedPdf(orgId, adminId, "%PDF twin")
    const run = await runImport({
      orgId,
      actor: admin(),
      kinds: ["invoicing.document"],
      source: recordsOf([
        invoice("INV-6001", 6001, pdf),
        invoice("INV-6001-B", 6001, pdf, { number: "INV-6001" }),
      ]),
      sourceLabel: `tw${tag()}`,
      mode: "cli",
      dryRun: true,
      batchSize: 1,
    })
    expect(run.counts["invoicing.document"]).toEqual({ created: 1, skipped: 0, failed: 1 })
    expect(String(run.errors[0]?.error)).toMatch(
      /^numberTaken: INV-6001 is used by an earlier record/,
    )
  }, 300_000)

  it("refuses a PDF from another org", async () => {
    const label = `xo${tag()}`
    const foreign = await uploadedPdf(otherOrgId, otherAdminId, "%PDF foreign")
    const run = await runImport({
      orgId,
      actor: admin(),
      kinds: ["invoicing.document"],
      source: recordsOf([invoice("INV-9001", 9001, foreign)]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(run.counts["invoicing.document"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(run.errors[0]?.error)).toMatch(/^forbidden_attachment: .*not found/)
  }, 300_000)
})

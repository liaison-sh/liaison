// SPDX-License-Identifier: FSL-1.1-ALv2
// `liaison invoicing import` as a client of the `invoicing.document` import
// kind: it reads its JSON manifest and PDF folder, maps amounts and VAT
// labels, and writes through an import run (undoable), with the report it
// always gave. Fictional data.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInvoicingImport } from "~/cli/invoicing/import"
import { sql } from "~/db"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { type AppInstallSnapshot, snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Apps this file installs are instance-wide rows: put them back after it.
let installs: AppInstallSnapshot | null = null

let installRoot = ""
let prevAppsDir: string | undefined
const tmpDirs: string[] = []
const tag = () => crypto.randomUUID().slice(0, 8)

beforeAll(async () => {
  await acquireTestLock()
  installs = await snapshotAppInstalls()
  installRoot = mkdtempSync(join(tmpdir(), "invoicing-cli-install-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
}, 120_000)

afterAll(async () => {
  await shutdownWorkerPool()
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  for (const d of [installRoot, ...tmpDirs]) rmSync(d, { recursive: true, force: true })
  await installs?.restore()
  await releaseTestLock()
}, 120_000)

const entry = (over: Record<string, unknown>) => ({
  doc_type: "invoice",
  number_raw: "F-1",
  number_int: 1,
  issue_date: "2025-02-03",
  currency: "EUR",
  counterparty: {
    name: "Ann Example",
    company: "Contoso GmbH",
    address: "Main st 1",
    country: "DE",
    vat_id: "DE999",
  },
  lines: [
    {
      item: "Pad",
      description: "Grey",
      quantity: "2",
      unit_price: "1,000.00",
      vat_rate: "0%",
      total: "2,000.00",
    },
  ],
  vat_amount: "0.00",
  total: "2,000.00",
  amount_paid: "2,000.00",
  amount_due: "0.00",
  validated: true,
  ...over,
})

describe("invoicing import (CLI client of the import kind)", () => {
  it("imports a manifest through an undoable run, with its report, and a re-run skips", async () => {
    const slug = `inv-cli-${tag()}`
    const { orgId } = await ensureOrg({ slug, name: "Invoicing CLI" })
    const { userId } = await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-inv-1!",
      role: "admin",
    })
    const manifest = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../../../bundled-apps/invoicing/app.manifest.json"),
        "utf8",
      ),
    ) as { scopes: string[] }
    await installAppFromTarball({
      tarballPath: firstPartyAppTarball("invoicing"),
      installedBy: userId,
      grantedScopes: manifest.scopes,
    })
    // The app's tables exist once some process registered it; the CLI itself never does.
    const { reloadInstalledApps } = await import("~/modules/apps/init")
    await reloadInstalledApps(orgId)
    const [issuer] = await sql`
      INSERT INTO app_invoicing.issuer_profiles (org_id, legal_name, country, default_currency)
      VALUES (${orgId}, ${`Fabrikam ${tag()}`}, 'FR', 'EUR') RETURNING id`

    const dir = mkdtempSync(join(tmpdir(), "invoicing-cli-"))
    tmpDirs.push(dir)
    const pdfDir = join(dir, "pdfs")
    mkdirSync(pdfDir)
    writeFileSync(join(pdfDir, "F-1.pdf"), "%PDF invoice")
    writeFileSync(join(pdfDir, "A-1.pdf"), "%PDF credit")
    const manifestPath = join(dir, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify([
        // The credit note first: the client orders invoices before credit notes.
        entry({
          source_file: "A-1.pdf",
          doc_type: "credit_note",
          number_raw: "A-1",
          number_int: 1,
          total: "-2,000.00",
          amount_paid: null,
          amount_due: null,
          lines: [{ item: "Refund", quantity: "1", unit_price: "-2,000.00", total: "-2,000.00" }],
          original_invoice_ref: "F-1",
        }),
        entry({ source_file: "F-1.pdf" }),
        entry({ source_file: "skip.pdf", number_raw: "F-9", number_int: 9, validated: false }),
      ]),
    )

    const first = await runInvoicingImport({ manifestPath, pdfDir, orgSlug: slug })
    expect(first.report.failed).toEqual([])
    expect(first.exitCode).toBe(0)
    expect(first.report.imported).toBe(2)
    expect(first.report.skippedUnvalidated).toEqual(["skip.pdf"])
    expect(first.report.sequencesRaised).toEqual({
      [`invoicing:doc_number:${issuer!.id}:credit_note:2025`]: 1,
      [`invoicing:doc_number:${issuer!.id}:invoice:2025`]: 1,
    })
    expect(first.report.totalsByTypeCurrency).toEqual({
      "credit_note:EUR": "-2000.00",
      "invoice:EUR": "2000.00",
    })

    const docs = await sql`
      SELECT number, status, counterparty_name, counterparty_address, tax_treatment,
             grand_total_minor::text AS total, original_document_id, id, pdf_file_id
      FROM app_invoicing.documents WHERE org_id = ${orgId} ORDER BY number DESC`
    const inv = docs.find((d) => d.number === "F-1")!
    const credit = docs.find((d) => d.number === "A-1")!
    expect([
      inv.status,
      inv.counterparty_name,
      inv.counterparty_address,
      inv.tax_treatment,
      inv.total,
    ]).toEqual(["paid", "Contoso GmbH", "Ann Example, Main st 1", "eu_reverse_charge", "200000"])
    expect(credit.original_document_id).toBe(inv.id)
    expect(inv.pdf_file_id).not.toBeNull()
    // The staged uploads are gone; only the documents' own PDFs remain.
    const staged = await sql`
      SELECT 1 FROM kernel.files WHERE org_id = ${orgId} AND entity_type = 'file_upload_session'`
    expect(staged.length).toBe(0)

    const again = await runInvoicingImport({ manifestPath, pdfDir, orgSlug: slug })
    expect(again.report.imported).toBe(0)
    expect(again.report.skippedDuplicates).toBe(2)

    const [run] = await sql`
      SELECT id FROM kernel.import_runs WHERE org_id = ${orgId} AND kind_set = '{invoicing.document}'
      ORDER BY created_at LIMIT 1`
    const report = await undoImportRun(orgId, String(run!.id), { userId })
    expect(report.refused).toEqual([])
    expect((await sql`SELECT 1 FROM app_invoicing.documents WHERE org_id = ${orgId}`).length).toBe(
      0,
    )
  }, 600_000)
})

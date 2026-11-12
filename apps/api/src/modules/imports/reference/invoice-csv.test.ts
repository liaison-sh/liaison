// SPDX-License-Identifier: FSL-1.1-ALv2
// The generic invoice CSV reference (an example to adapt, fictional columns),
// run through the real runner with the real invoicing bundle installed the
// way a deployment installs it: a zip holding the CSV (one row per line item)
// and the original PDFs becomes invoicing.document records, credit notes
// linked to the invoice they correct, each document with its own PDF.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { zipSync } from "fflate"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { readReference } from "~/modules/imports/reference/references"
import { runImport } from "~/modules/imports/runner"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { type AppInstallSnapshot, snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Apps this file installs are instance-wide rows: put them back after it.
let installs: AppInstallSnapshot | null = null

const FIXTURE = join(import.meta.dir, "__fixtures__", "invoice-csv")
const tag = () => crypto.randomUUID().slice(0, 8)

let installRoot = ""
let prevAppsDir: string | undefined
let orgId = ""
let adminId = ""
let zipDir = ""
let zipPath = ""

function admin(): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

beforeAll(async () => {
  await acquireTestLock()
  installs = await snapshotAppInstalls()
  installRoot = mkdtempSync(join(tmpdir(), "invoice-csv-install-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
  orgId = (await ensureOrg({ slug: `ref-inv-${tag()}`, name: "Invoice CSV" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-inv-1!",
      role: "admin",
    })
  ).userId
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../../bundled-apps/invoicing/app.manifest.json"),
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
  await sql`
    INSERT INTO app_invoicing.issuer_profiles (org_id, legal_name, country, default_currency)
    VALUES (${orgId}, ${`Fabrikam ${tag()}`}, 'FR', 'EUR')`
  // The export as a person would upload it: the CSV and its PDFs in one zip.
  const entries: Record<string, Uint8Array> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else entries[relative(FIXTURE, p)] = new Uint8Array(readFileSync(p))
    }
  }
  walk(FIXTURE)
  zipDir = mkdtempSync(join(tmpdir(), "invoice-csv-"))
  zipPath = join(zipDir, "invoices-export.zip")
  writeFileSync(zipPath, zipSync(entries))
}, 600_000)

afterAll(async () => {
  await shutdownTransformPool()
  await shutdownWorkerPool()
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  rmSync(zipDir, { recursive: true, force: true })
  await installs?.restore()
  await releaseTestLock()
}, 120_000)

describe("invoice-csv reference", () => {
  const run = () => {
    const ref = readReference("invoice-csv")
    return runImport({
      orgId,
      actor: admin(),
      kinds: ref.kinds,
      source: {
        type: "transform",
        transform: { inline: ref.code, name: "invoice-csv" },
        input: { type: "paths", paths: [zipPath] },
        ...(ref.files ? { files: ref.files } : {}),
      },
      sourceLabel: "invref",
      mode: "cli",
    })
  }

  it("imports invoices and credit notes with their lines, taxes, customer, status, payment and original PDF; a rerun skips", async () => {
    const first = await run()
    expect(first.errors).toEqual([])
    expect(first.status).toBe("done")
    expect(first.counts["invoicing.document"]).toEqual({ created: 4, skipped: 0, failed: 0 })

    const docs = await sql`
      SELECT id, number, type, status, payment_status, currency, issued_at::date::text AS issued,
             subtotal_minor::text AS sub, tax_total_minor::text AS tax, grand_total_minor::text AS total,
             counterparty_name, original_document_id, pdf_file_id
      FROM app_invoicing.documents WHERE org_id = ${orgId} AND external_ref LIKE 'invref:%'
      ORDER BY number`
    const by = new Map(docs.map((d) => [String(d.number), d]))
    const paid = by.get("FAB-2025-0001")!
    expect([paid.type, paid.status, paid.currency, paid.issued]).toEqual([
      "invoice",
      "paid",
      "EUR",
      "2025-05-06",
    ])
    // Two rows, one document: lines summed, tax kept apart.
    expect([paid.sub, paid.tax, paid.total]).toEqual(["121000", "24200", "145200"])
    expect(paid.counterparty_name).toBe("Contoso Retail")
    const lines = await sql`
      SELECT description, tax_rate_bp, total_minor::text AS total FROM app_invoicing.document_lines
      WHERE document_id = ${paid.id} ORDER BY position`
    expect(lines.map((l) => [l.description, l.tax_rate_bp, l.total])).toEqual([
      ["Pad controller", 2000, "110000"],
      ["Carry case", 2000, "11000"],
    ])
    expect(by.get("FAB-2025-0002")!.status).toBe("issued")
    expect(by.get("FAB-2025-0003")!.status).toBe("voided")
    // A credit note: negative, linked to the invoice it corrects.
    const credit = by.get("FAB-CN-2025-0001")!
    expect([credit.type, credit.status, credit.total]).toEqual([
      "credit_note",
      "refunded",
      "-110000",
    ])
    expect(credit.original_document_id).toBe(by.get("FAB-2025-0002")!.id)
    // Each document carries its own original PDF.
    const [file] = await sql`SELECT storage_key FROM kernel.files WHERE id = ${paid.pdf_file_id}`
    expect(String(await getObjectBuffer(String(file!.storage_key)))).toContain(
      "fictional FAB-2025-0001",
    )

    const again = await run()
    expect(again.counts["invoicing.document"]).toEqual({ created: 0, skipped: 4, failed: 0 })
  }, 300_000)
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real-database, real-sandbox proof of the legal original at issue (S7, S23): issuing an
// e_invoice through executeTool → sandbox → bridge → kernel PDF renderer produces ONE file, a
// PDF/A-3B Factur-X whose embedded CII passes the XSD and every schematron, stored under the
// `legal_original` file parent in an immutable `legal_originals` row whose hash is the stored
// bytes' hash; the CII is also kept as its own `facturx_xml` file. A document whose Factur-X
// could not be built is `facturx_failed`; once the data is fixed, documents_retry_pdf records
// the legal original with the host committing its row (the cross-app-visible path).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFRawStream,
} from "pdf-lib"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { registerTemplate } from "~/modules/pdf/registry"
import { getFileBytes } from "~/modules/pdf/render"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { validateFacturxXml } from "../../../../../tools/schematron/validate"
import { failing, structuralAsserts } from "../../../test-support/pdfa/structural-asserts"

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

// A fresh org per run: legal originals are retained by design (nothing here can be cleaned up).
const ORG = randomUUID()
const USER = randomUUID()
const THREAD = randomUUID()
const CONTACT = randomUUID()

const SCOPES = [
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
  scopes: SCOPES,
  dimensionGrants: {},
}

const buyer = {
  contact_id: CONTACT,
  legal_name: "Client Exemple SAS",
  country: "FR",
  vat_id: "FR83900000001",
  address: "10 rue Domestic, 69002 Lyon",
  email: "compta@client-exemple.example",
  customer_kind: "business",
  billing_line1: "10 rue Domestic",
  billing_postcode: "69002",
  billing_city: "Lyon",
  billing_country_code: "FR",
}
const items = [
  { description: "Contrôleur", quantity: "2", unit_price_minor: 34999 },
  { description: "Câble", quantity: "1", unit_price_minor: 1250 },
]

let issuerId = ""

/** The invoicing PDF templates as the package build makes them (scripts/freeze-app.ts): bundled
 *  for the sandbox, the trailing ESM export block replaced by a `globalThis.renderTemplate`. */
async function registerInvoicingTemplates(): Promise<void> {
  for (const kind of ["invoice", "credit_note"]) {
    // Bundled in a child `bun build`, the same bundler and options as the package build. In this
    // process the from-source app registration has already run the bundler, and a second in-process
    // Bun.build after it fails reading a dependency ("Unexpected reading file" on zod's index.js).
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(REPO_ROOT, "bundled-apps", "invoicing", "templates", `${kind}.ts`),
        "--target",
        "bun",
        "--external",
        "node:*",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (build.exitCode !== 0) {
      throw new Error(`template ${kind} build failed: ${build.stderr.toString()}`)
    }
    let js = build.stdout.toString()
    const block = /export\s*\{([^}]*)\};?\s*$/.exec(js)
    const local = block?.[1]
      ?.split(",")
      .map((x) => x.trim())
      .map(
        (x) => /^(\w+)\s+as\s+renderTemplate$/.exec(x)?.[1] ?? (x === "renderTemplate" ? x : null),
      )
      .find((x) => x)
    if (!block || !local) throw new Error(`template ${kind} exports no renderTemplate`)
    js = `${js.slice(0, block.index)}\nglobalThis.renderTemplate = ${local};\n`
    registerTemplate("invoicing", `invoicing:${kind}_v1`, js)
  }
}

async function issue(): Promise<string> {
  const res = await executeTool({
    toolName: "invoicing:invoice_create_and_issue",
    orgId: ORG,
    actor,
    params: {
      counterparty: buyer,
      issuer_profile_id: issuerId,
      currency: "EUR",
      operation_category: "goods",
      items,
    },
    threadId: THREAD,
    origin: "human-ui",
  })
  const id = (res.data as { document_id?: string } | undefined)?.document_id
  if (!id) throw new Error(`issue failed: ${JSON.stringify(res)}`)
  return id
}

async function doc(id: string): Promise<Record<string, unknown>> {
  const [row] = await sql<
    Array<Record<string, unknown>>
  >`SELECT * FROM app_invoicing.documents WHERE id = ${id}`
  return row as Record<string, unknown>
}

function embeddedXml(pdf: PDFDocument): string {
  const af = pdf.catalog.lookup(PDFName.of("AF"), PDFArray)
  const spec = pdf.context.lookup(af.get(0), PDFDict)
  const ef = spec.lookup(PDFName.of("EF"), PDFDict)
  const stream = ef.lookup(PDFName.of("F")) as PDFRawStream
  return new TextDecoder().decode(decodePDFRawStream(stream).decode())
}

describe("Factur-X legal original at issue (real Postgres, sandbox, kernel renderer)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Facturx Issue Org', ${`facturx-issue-${ORG.slice(0, 8)}`}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, ${`facturx-${USER.slice(0, 8)}@test.com`}, 'hash', 'Facturx Tester', 'active') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, ${`facturx-thread-${THREAD.slice(0, 8)}`}, 'agent_chat', ${USER}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
    for (const scope of SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([bundledDescriptor("invoicing") as never], ORG)
    await registerInvoicingTemplates()
    issuerId = randomUUID()
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, vat_id, address, default_currency, default_language, iban, swift_bic,
       siren, routing_address, address_line1, postcode, city, country_code)
      VALUES (${issuerId}, ${ORG}, 'Maison Exemple SAS', 'FR', 'FR40902000009', '1 rue de Test, 75011 Paris',
       'EUR', 'fr', 'FR7630006000011234567890189', 'AGRIFRPP',
       '902000009', '902000009', '1 rue de Test', '75011', 'Paris', 'FR')
      ON CONFLICT (org_id, legal_name) DO UPDATE SET siren = EXCLUDED.siren`
    // Re-runnable: the org's rows persist (legal originals are retained by design).
    const [iss] = await sql<
      Array<{ id: string }>
    >`SELECT id FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG} AND legal_name = 'Maison Exemple SAS'`
    issuerId = iss!.id
    await sql`DELETE FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
    await sql`INSERT INTO app_invoicing.einvoicing_settings (org_id, gate_mode, gate_mode_source) VALUES (${ORG}, 'enforce', 'config')`
    await sql`DELETE FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG}`
    await sql`INSERT INTO app_invoicing.counterparty_identities
      (org_id, contact_id, customer_kind, siren, registry_name, registry_line1, registry_postcode,
       registry_city, registry_country_code, registry_status, registry_checked_at, source, confirmed_via, changed_at)
      VALUES (${ORG}, ${CONTACT}, 'business', '900000001', 'CLIENT EXEMPLE', '10 rue Domestic', '69002',
       'Lyon', 'FR', 'A', '2026-10-01', 'registry', 'auto', '2026-10-01')`
  }, 120_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("issuing an e-invoice records ONE PDF/A-3B Factur-X as the immutable legal original", async () => {
    const id = await issue()
    const d = await doc(id)
    expect(d.regime).toBe("e_invoice")
    // A failed render names its code here before the status check hides it.
    expect((d.lifecycle_log as Array<{ event: string }>).filter((e) => e.event === "pdf_render_failed")).toEqual([])
    expect(d.pdf_status).toBe("ready")
    const [lo] = await sql<
      Array<Record<string, unknown>>
    >`SELECT * FROM app_invoicing.legal_originals WHERE document_id = ${id}`
    expect(lo).toMatchObject({
      kind: "facturx",
      id: d.legal_original_id,
      sha256: d.legal_original_sha256,
      file_id: d.pdf_file_id,
    })
    const [file] = await sql<Array<{ entity_type: string; entity_id: string }>>`
      SELECT entity_type, entity_id::text AS entity_id FROM kernel.files WHERE id = ${String(lo!.file_id)}`
    expect(file).toEqual({ entity_type: "legal_original", entity_id: String(lo!.id) })

    const bytes = await getFileBytes(null, String(lo!.file_id))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(String(lo!.sha256))
    expect(Number(lo!.byte_size)).toBe(bytes.byteLength)

    // The container (S10 asserts) and the XML (S8) of the stored legal original.
    const asserts = await structuralAsserts(bytes, {
      attachments: [{ name: "factur-x.xml", mime: "text/xml", afRelationship: "Data" }],
      xmpExtensions: [
        {
          namespaceUri: "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#",
          prefix: "fx",
          values: {
            DocumentFileName: "factur-x.xml",
            DocumentType: "INVOICE",
            Version: "1.0",
            ConformanceLevel: "EN 16931",
          },
        },
      ],
    })
    expect(failing(asserts)).toEqual([])
    const xml = embeddedXml(await PDFDocument.load(bytes, { updateMetadata: false }))
    const v = validateFacturxXml(xml)
    expect(v.xsd.errors).toEqual([])
    expect(v.blocking.map((b) => `${b.schematron}:${b.id}`)).toEqual([])
    expect(xml).toContain(`<ram:ID>${String(d.number)}</ram:ID>`)

    // The CII is also its own file, identical to the embedded one.
    const [fx] = await sql<
      Array<Record<string, unknown>>
    >`SELECT * FROM app_invoicing.facturx_files WHERE document_id = ${id}`
    const xmlBytes = await getFileBytes(null, String(fx!.file_id))
    expect(new TextDecoder().decode(xmlBytes)).toBe(xml)
    expect(createHash("sha256").update(xmlBytes).digest("hex")).toBe(String(fx!.sha256))

    // Immutable from the moment it exists.
    await expect(
      (async () => {
        await sql`UPDATE app_invoicing.legal_originals SET sha256 = ${"0".repeat(64)} WHERE id = ${String(lo!.id)}`
      })(),
    ).rejects.toThrow(/immutable_row/)
  }, 120_000)

  it("a later forced re-render is a management copy; the legal original does not move", async () => {
    const id = await issue()
    const before = await doc(id)
    const res = await executeTool({
      toolName: "invoicing:documents_retry_pdf",
      orgId: ORG,
      actor,
      params: { id },
      threadId: THREAD,
      origin: "human-ui",
    })
    expect((res.data as { status?: string } | undefined)?.status ?? "completed").toBe("completed")
    const after = await doc(id)
    expect(after.legal_original_id).toBe(before.legal_original_id)
    expect(after.pdf_file_id).not.toBe(before.pdf_file_id)
    const los = await sql`SELECT 1 FROM app_invoicing.legal_originals WHERE document_id = ${id}`
    expect(los.length).toBe(1)
  }, 120_000)

  it("facturx_failed, then a retry once the issuer is fixed records it, the host committing the row", async () => {
    await sql`UPDATE app_invoicing.issuer_profiles SET siren = NULL WHERE id = ${issuerId}`
    let id: string
    try {
      id = await issue()
    } finally {
      await sql`UPDATE app_invoicing.issuer_profiles SET siren = '902000009' WHERE id = ${issuerId}`
    }
    const failed = await doc(id)
    expect(failed.pdf_status).toBe("facturx_failed")
    expect(failed.legal_original_id).toBeNull()
    expect(
      (await sql`SELECT 1 FROM app_invoicing.legal_originals WHERE document_id = ${id}`).length,
    ).toBe(0)

    await executeTool({
      toolName: "invoicing:documents_retry_pdf",
      orgId: ORG,
      actor,
      params: { id },
      threadId: THREAD,
      origin: "human-ui",
    })
    const fixed = await doc(id)
    expect(fixed.pdf_status).toBe("ready")
    const [lo] = await sql<
      Array<Record<string, unknown>>
    >`SELECT * FROM app_invoicing.legal_originals WHERE document_id = ${id}`
    expect(lo).toMatchObject({ kind: "facturx", id: fixed.legal_original_id })
    const bytes = await getFileBytes(null, String(lo!.file_id))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(String(lo!.sha256))
  }, 120_000)

  it("a credit note issued with negative lines (agent path) records a Factur-X with positive amounts that passes every rule", async () => {
    const original = await issue()
    const res = await executeTool({
      toolName: "invoicing:credit_note_create_and_issue",
      orgId: ORG,
      actor,
      params: {
        counterparty: buyer,
        issuer_profile_id: issuerId,
        currency: "EUR",
        operation_category: "goods",
        original_document_id: original,
        reason: "Return of the goods",
        items: items.map((i) => ({ ...i, unit_price_minor: -i.unit_price_minor })),
      },
      threadId: THREAD,
      origin: "human-ui",
    })
    const id = (res.data as { document_id?: string } | undefined)?.document_id
    if (!id) throw new Error(`credit note failed: ${JSON.stringify(res)}`)
    const d = await doc(id)
    expect(d.regime).toBe("e_invoice")
    expect(d.pdf_status).toBe("ready")
    expect(BigInt(String(d.grand_total_minor))).toBeLessThan(0n)
    const [lo] = await sql<
      Array<Record<string, unknown>>
    >`SELECT * FROM app_invoicing.legal_originals WHERE document_id = ${id}`
    const xml = embeddedXml(
      await PDFDocument.load(await getFileBytes(null, String(lo!.file_id)), {
        updateMetadata: false,
      }),
    )
    expect(xml).toContain("<ram:TypeCode>381</ram:TypeCode>")
    expect(xml).not.toMatch(
      /<ram:(ChargeAmount|LineTotalAmount|GrandTotalAmount|DuePayableAmount|BasisAmount|CalculatedAmount)>-/,
    )
    const v = validateFacturxXml(xml)
    expect(v.xsd.errors).toEqual([])
    expect(v.blocking.map((b) => `${b.schematron}:${b.id}`)).toEqual([])
  }, 240_000)
})

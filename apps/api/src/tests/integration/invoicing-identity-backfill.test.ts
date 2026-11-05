// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoicing identity backfill and the e-invoicing readiness list on real Postgres, through
// the real kernel path (executeTool -> sandbox handler -> bridge; the business registry answered
// by a canned fake at the sandbox fetch boundary), as a user holding the issuer's scopes (never
// admin). Three existing customers: a consumer in Germany, a French company with a French VAT id,
// a French company without one. A dry run (approved) writes nothing; the real run (approved)
// gives every customer a kind, confirms the VAT one's SIREN against the registry, reports that
// the issuer's own SIREN needs a settings writer, and leaves the third on the readiness list with
// the registry lookup as its fix.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

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

const ORG = "00000000-0000-4000-8000-0000000e9001"
const USER = "00000000-0000-4000-8000-0000000e9002"
const THREAD = "00000000-0000-4000-8000-0000000e9003"
const C_DE = "00000000-0000-4000-8000-0000000e9011" // a consumer in Germany
const C_VAT = "00000000-0000-4000-8000-0000000e9012" // a French company with a French VAT id
const C_NOVAT = "00000000-0000-4000-8000-0000000e9013" // a French company without one

// Fictional, Luhn-valid identifiers.
const BUYER_SIREN = "900000001"
const BUYER_VAT = "FR68900000001"
const ISSUER_SIRET = "90200000900016"

const CEO_ROLE_SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:approve",
]
// The issuer reads a customer's company on its kernel contact.
const KERNEL_SCOPES = ["kernel:contacts:read"]

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [...CEO_ROLE_SCOPES, ...KERNEL_SCOPES],
  dimensionGrants: {},
}

const REGISTRY: Record<string, Record<string, unknown>> = {
  [BUYER_SIREN]: {
    siren: BUYER_SIREN,
    nom_complet: "EXEMPLE INDUSTRIES",
    nom_raison_sociale: "EXEMPLE INDUSTRIES",
    sigle: null,
    etat_administratif: "A",
    nature_juridique: "5710",
    siege: {
      siret: `${BUYER_SIREN}00017`,
      numero_voie: "1",
      type_voie: "RUE",
      libelle_voie: "DE L'EXEMPLE",
      code_postal: "75002",
      libelle_commune: "PARIS",
      liste_enseignes: null,
    },
    matching_etablissements: [],
  },
}
let registryCalls = 0

const registryFetch = (async (input: Parameters<typeof fetch>[0]) => {
  registryCalls += 1
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  )
  const hit = REGISTRY[url.searchParams.get("q") ?? ""]
  return new Response(
    JSON.stringify({
      results: hit ? [hit] : [],
      total_results: hit ? 1 : 0,
      page: 1,
      per_page: 10,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}) as unknown as typeof fetch

type Data = Record<string, unknown>

async function callTool(toolName: string, params: Record<string, unknown>) {
  return executeTool({
    toolName,
    orgId: ORG,
    actor,
    params,
    threadId: THREAD,
    origin: "in-app-agent",
  })
}

/** Call the gated backfill, then approve it as the issuer (who holds invoicing:approve). */
async function approvedBackfill(params: Record<string, unknown>): Promise<Data> {
  const res = await callTool("invoicing:einvoicing_backfill_identities", params)
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

async function identities(): Promise<Array<Record<string, unknown>>> {
  return sql`SELECT * FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG}`
}

describe("invoicing identity backfill + readiness (real Postgres, issuer scopes)", () => {
  let issuerId = ""

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Identity Backfill Org', 'identity-backfill-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'identity-backfill@test.com', 'hash', 'Backfill Tester', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'identity-backfill-thread', 'agent_chat', ${USER}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
    for (const scope of [...CEO_ROLE_SCOPES, ...KERNEL_SCOPES]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, company) VALUES
      (${C_DE}, ${ORG}, 'backfill-de', 'Joel Beispiel', NULL),
      (${C_VAT}, ${ORG}, 'backfill-vat', 'Celine Exemple', 'Exemple Industries'),
      (${C_NOVAT}, ${ORG}, 'backfill-novat', 'Alex Imaginaire', 'Studio Imaginaire')
      ON CONFLICT (id) DO NOTHING`

    await initSandboxPool()
    await initWorkerPool()
    await registerApps([bundledDescriptor("invoicing") as never], ORG)
    // The kernel tools the app calls across (kernel:contacts_read for a customer's company).
    await registerKernelAgentTools(ORG)
    SandboxBridgeTestAccess.setFetch(registryFetch)
    SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === "recherche-entreprises.api.gouv.fr")

    issuerId = randomUUID()
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, vat_id, tax_registration_id, address, default_currency, default_language)
      VALUES (${issuerId}, ${ORG}, 'Backfill Issuer SAS', 'FR', 'FR60902000009', ${ISSUER_SIRET},
        '2 rue Test, 75001 Paris', 'EUR', 'fr')`
    await sql`INSERT INTO app_invoicing.einvoicing_settings (org_id, gate_mode, gate_mode_source)
      VALUES (${ORG}, 'enforce', 'config')`
    const docs: Array<[string, string, string, string | null, string, string]> = [
      [C_DE, "Joel Beispiel", "DE", null, "Musterstrasse 1\n10115 Berlin", "INV-2026-0901"],
      [
        C_VAT,
        "Exemple Industries SAS",
        "FR",
        BUYER_VAT,
        "1 rue de l'Exemple\n75002 Paris",
        "INV-2026-0902",
      ],
      [C_NOVAT, "Studio Imaginaire", "FR", null, "3 place du Test\n69002 Lyon", "INV-2026-0903"],
    ]
    let n = 901
    for (const [contact, name, country, vat, address, number] of docs) {
      await sql`INSERT INTO app_invoicing.documents
        (org_id, type, status, number, number_int, year_of_issue, currency, incoterm, issuer_profile_id,
         counterparty_contact_id, counterparty_name, counterparty_address, counterparty_country, counterparty_vat_id,
         subtotal_minor, tax_total_minor, grand_total_minor, issued_at, external_refs, lifecycle_log)
        VALUES (${ORG}, 'invoice', 'issued', ${number}, ${n}, 2026, 'EUR', 'DAP', ${issuerId},
         ${contact}, ${name}, ${address}, ${country}, ${vat}, 10000, 2000, 12000, '2026-09-01', '{}'::jsonb, '[]'::jsonb)`
      n += 1
    }
  }, 60_000)

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql`DELETE FROM kernel.approved_handler_executions
      WHERE approval_request_id IN (SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await releaseTestLock()
  }, 60_000)

  it("an approved dry run writes nothing", async () => {
    const report = await approvedBackfill({ dry_run: true })
    expect(report).toMatchObject({ status: "ok", dry_run: true, scanned: 3, next_cursor: null })
    expect(report.would_write as number).toBeGreaterThan(0)
    expect(typeof report.readiness_count).toBe("number")
    expect(await identities()).toHaveLength(0)
    const [issuer] = await sql<Array<{ siren: string | null }>>`
      SELECT siren FROM app_invoicing.issuer_profiles WHERE id = ${issuerId}`
    expect(issuer?.siren ?? null).toBeNull()
  }, 120_000)

  it("the approved run gives every customer a kind and confirms the VAT one against the registry", async () => {
    const report = await approvedBackfill({ dry_run: false })
    expect(report).toMatchObject({ status: "ok", dry_run: false, scanned: 3, next_cursor: null })
    const rows = await identities()
    const of = (c: string) => rows.find((r) => r.contact_id === c)
    expect(of(C_DE)).toMatchObject({ customer_kind: "individual", source: "derived", siren: null })
    expect(of(C_VAT)).toMatchObject({
      customer_kind: "business",
      siren: BUYER_SIREN,
      source: "vat_derived",
      confirmed_via: "auto",
      registry_name: "EXEMPLE INDUSTRIES",
      registry_status: "A",
    })
    expect(of(C_NOVAT)).toMatchObject({ customer_kind: "business", siren: null, source: "derived" })
    expect(registryCalls).toBeGreaterThan(0)

    // The issuer's own SIREN lives in issuer settings, which this role (no
    // invoicing:settings:write) may not change: not written, and the report says so.
    const [issuer] = await sql<Array<{ siren: string | null; siret: string | null }>>`
      SELECT siren, siret FROM app_invoicing.issuer_profiles WHERE id = ${issuerId}`
    expect(issuer).toMatchObject({ siren: null, siret: null })
    expect((report.counts as Data).issuers_not_written).toBe(1)
    expect(String(report.message)).toContain("invoicing:settings:write")

    const [doc] = await sql<Array<Record<string, unknown>>>`
      SELECT billing_postcode, billing_city, billing_country_code FROM app_invoicing.documents
      WHERE org_id = ${ORG} AND counterparty_contact_id = ${C_VAT}`
    expect(doc).toMatchObject({
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
    })
  }, 120_000)

  it("readiness lists the French company without a SIREN, with the registry lookup as its action", async () => {
    const res = await callTool("invoicing:einvoicing_readiness", { limit: 200 })
    const data = res.data as { status: string; items: Array<Data>; count: number }
    expect(data.status).toBe("ok")
    const subjects = data.items.map((i) => (i.subject as Data).contact_id)
    expect(subjects).not.toContain(C_DE)
    expect(subjects).not.toContain(C_VAT)
    const third = data.items.filter((i) => (i.subject as Data).contact_id === C_NOVAT)
    expect(third.map((i) => [i.blocker_code, (i.action as Data).tool])).toEqual([
      ["einvoice_data_missing", "counterparty_identity_lookup"],
    ])
    expect(data.count).toBe(data.items.length)
  }, 60_000)
})

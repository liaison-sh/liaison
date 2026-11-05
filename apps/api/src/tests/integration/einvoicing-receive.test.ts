// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real Postgres, real sandbox, real kernel: a supplier e-invoice received through the PA reaches
// the invoicing app's Received mirror through the generic provider contract (invoicing calls
// `einvoicing-pa@1`; the org binds Pennylane, answered by its fake behind the egress override).
//
//   the platform's signed arrival webhook → the provider's inbox → the e-invoicing job drains it →
//   get_received → the original and the PDF are downloaded HOST-SIDE by the provider onto the
//   invoicing app's own file rows (token to the API host only; the storage hop gets none; an
//   unlisted hop is refused) → sha256 recorded, XML figures read safely.
// Refusing: an agent asks → ONE approval request, nothing sent; an auto-approve policy changes
// nothing; the agent cannot call the gated action itself; a person approves → sent once, the
// mirror shows the refusal with its official code; nothing more is offered.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { connectedAccounts } from "~/db/schema/kernel"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { storeAppHeldSecret } from "~/modules/apps/connections/service"
import { executeTool, executeToolCore } from "~/modules/apps/execute-tool"
import { writeKernelContractBinding } from "~/modules/apps/provider-contracts/binding"
import { registerApps } from "~/modules/apps/runtime"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { getFileBytes } from "~/modules/pdf/render"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { PennylaneFake } from "../../../../../bundled-apps/pennylane/src/einvoicing/fake/server"
import { API_HOST, STORAGE_HOST } from "../../../../../bundled-apps/pennylane/src/received/hosts"

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

const ORG = randomUUID()
const USER = randomUUID()
const THREAD = randomUUID()
const HOOK_SECRET = "whsec_integration_receive_secret"
const OWN_SIREN = "902000009"

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:settings:read",
  "invoicing:received:read",
  "invoicing:received:write",
  "invoicing:approve",
]
const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}
const agentActor = { ...actor, actorType: "agent" as const, agentId: randomUUID() }

const fake = new PennylaneFake()

const CII = (n: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"><rsm:ExchangedDocument><ram:ID>${n}</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20261103</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument><rsm:SupplyChainTradeTransaction><ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Fournisseur Exemple</ram:Name><ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">732829320</ram:ID></ram:SpecifiedLegalOrganization></ram:SellerTradeParty></ram:ApplicableHeaderTradeAgreement><ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode><ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">20.00</ram:TaxTotalAmount><ram:GrandTotalAmount>120.00</ram:GrandTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation></ram:ApplicableHeaderTradeSettlement></rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>`

function signedWebhook(body: string) {
  const t = Math.floor(Date.now() / 1000)
  const v1 = createHmac("sha256", HOOK_SECRET).update(`${t}.${body}`, "utf8").digest("hex")
  return app.request(`/webhooks/${ORG}/pennylane/einvoicing`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pennylane-signature": `t=${t},v1=${v1}` },
    body,
  })
}

async function runJob(name: string): Promise<void> {
  const handler = JobsTestAccess.getHandler("invoicing", name)
  if (!handler) throw new Error(`${name} not registered`)
  await dispatchAppJobWithContext(
    handler,
    { orgId: ORG },
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
    "session",
  )
}

async function arrive(number: string): Promise<number> {
  const id = fake.receive({
    supplier: "Fournisseur Exemple",
    supplierSiren: "732829320",
    number,
    total: "120.0",
    tax: "20.0",
    original: new TextEncoder().encode(CII(number)),
    routing: OWN_SIREN,
  })
  const body = JSON.stringify({
    id: `env-${randomUUID()}`,
    type: "supplier_invoice.e_invoicing_received",
    data: { object: { id, created_at: new Date().toISOString() } },
  })
  expect((await signedWebhook(body)).status).toBe(200)
  return id
}

async function receivedRow(providerRef: number): Promise<Record<string, any> | undefined> {
  const [row] = await sql<
    Array<Record<string, any>>
  >`SELECT * FROM app_invoicing.received_einvoices WHERE org_id = ${ORG} AND provider_ref = ${String(providerRef)}`
  return row
}

const puts = () =>
  fake.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/e_invoice_status")).length

describe("received supplier e-invoices through the einvoicing-pa@1 contract (real Postgres, sandbox, kernel; Pennylane fake)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Einvoice Receive Org', ${`einv-recv-${ORG.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, ${`recv-${USER.slice(0, 8)}@test.com`}, 'hash', 'Approver', 'active')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, ${`recv-thread-${THREAD.slice(0, 8)}`}, 'agent_chat', ${USER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${THREAD}, ${USER}, ${ORG}, 'admin')`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER}, ${THREAD}, ${ORG})`
    for (const scope of SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.apps (id, org_id, name, version, status) VALUES (gen_random_uuid(), ${ORG}, 'pennylane', '1.0.0', 'active')`
    await initSandboxPool()
    await initWorkerPool()
    await registerApps(
      [bundledDescriptor("invoicing") as never, bundledDescriptor("pennylane") as never],
      ORG,
    )
    await rebuildFilesSelectPolicy() // what boot does: the received_file parent's files become readable
    await sql`INSERT INTO app_invoicing.einvoicing_settings
      (org_id, gate_mode, gate_mode_source, provider_app, cutover_date, send_enabled, book_enabled, changed_by)
      VALUES (${ORG}, 'enforce', 'config', 'pennylane', '2026-01-01', false, false, ${USER})`
    // The binding the kernel dispatches by: an administrator's audited kernel path (config apply).
    await withPrivilegedDb(ORG, "recv-test-binding", (tx) =>
      writeKernelContractBinding(tx as never, {
        orgId: ORG,
        contract: "einvoicing-pa@1",
        callerApp: "invoicing",
        provider: "pennylane",
        actorId: USER,
        actorType: "user",
        source: "test",
      }),
    )
    await withSystemDb("recv-test-connection", (db) =>
      db.insert(connectedAccounts).values({
        orgId: ORG,
        appName: "pennylane",
        connectionName: "pennylane",
        ownerType: "org",
        ownerId: null,
        providerType: "credentials",
        identifier: "test-company",
        displayName: "test-company",
        credentialsEncrypted: encryptSecret(
          JSON.stringify({ apiToken: "fake-token", scope: "company" }),
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountCredentials,
        ),
        status: "active",
        createdBy: USER,
      }),
    )
    const pl = JSON.parse(
      readFileSync(join(REPO_ROOT, "bundled-apps", "pennylane", "app.manifest.json"), "utf8"),
    ) as { connections: Record<string, never> }
    await storeAppHeldSecret({
      orgId: ORG,
      appName: "pennylane",
      key: "einvoicingWebhookSecret",
      value: HOOK_SECRET,
      manifestConnections: pl.connections,
    })
    fake.registrations = [
      { siren: OWN_SIREN, status: "activated", exchange_direction: "emission_and_reception" },
    ]
    SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === API_HOST || h === STORAGE_HOST)
    SandboxBridgeTestAccess.setFetch(fake.httpFetch as unknown as typeof fetch)
  }, 180_000)

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("an arrival webhook is mirrored by the next e-invoicing job run: facts, status, both files host-downloaded with the token on the API host only, sha256 recorded, XML figures read", async () => {
    const ref = await arrive("FS-2026-001")
    expect(await receivedRow(ref)).toBeUndefined() // the webhook only records which invoice to read
    await runJob("einvoicing-transmit")
    const row = await receivedRow(ref)
    expect(row).toMatchObject({
      provider_app: "pennylane",
      supplier_name: "Fournisseur Exemple",
      supplier_siren: "732829320",
      invoice_number: "FS-2026-001",
      currency: "EUR",
      total: "120.0",
      status: "received",
      parse_status: "parsed",
      totals_mismatch: null,
      files_pending: false,
    })
    const files = await sql<Array<{ id: string; kind: string; file_id: string; sha256: string }>>`
      SELECT id, kind, file_id::text, sha256 FROM app_invoicing.received_einvoice_files WHERE received_id = ${row!.id} ORDER BY kind`
    expect(files.map((f) => f.kind)).toEqual(["original", "rendering"])
    const original = files.find((f) => f.kind === "original")!
    expect(original.sha256).toBe(fake.originalSha256(ref))
    const stored = await getFileBytes(null, original.file_id)
    expect(createHash("sha256").update(stored).digest("hex")).toBe(original.sha256)
    const [k] = await sql<Array<{ app: string; entity_type: string; entity_id: string }>>`
      SELECT app, entity_type, entity_id::text FROM kernel.files WHERE id = ${original.file_id}`
    expect(k).toEqual({ app: "invoicing", entity_type: "received_file", entity_id: original.id })
    // Every hop: the token to the API host only, none to the storage host.
    const hops = fake.downloads.filter((d) => d.url.includes(`blob${ref}`))
    expect(
      hops.filter((d) => d.host === API_HOST).every((d) => d.authorization === "Bearer fake-token"),
    ).toBe(true)
    expect(hops.filter((d) => d.host === STORAGE_HOST)).toHaveLength(2)
    expect(hops.filter((d) => d.host === STORAGE_HOST).every((d) => d.authorization === null)).toBe(
      true,
    )
    // The received original is a legal record: the database refuses to delete it.
    const run = async (q: PromiseLike<unknown>) => {
      await q // postgres.js runs a query only once awaited
    }
    await expect(
      run(sql`DELETE FROM app_invoicing.received_einvoice_files WHERE id = ${original.id}`),
    ).rejects.toThrow(/immutable_retention/)
  }, 180_000)

  it("the tab's tools: list and get through the sandbox under the person's scopes", async () => {
    const list = await executeTool({
      toolName: "invoicing:received_einvoices_list",
      orgId: ORG,
      actor,
      params: {},
      threadId: THREAD,
      origin: "human-ui",
    })
    const items = (list.data as { items: Array<{ invoice_number: string; status: string }> }).items
    expect(items.some((i) => i.invoice_number === "FS-2026-001" && i.status === "received")).toBe(
      true,
    )
    const [row] = await sql<
      Array<{ id: string }>
    >`SELECT id FROM app_invoicing.received_einvoices WHERE org_id = ${ORG} AND invoice_number = 'FS-2026-001'`
    const got = await executeTool({
      toolName: "invoicing:received_einvoices_get",
      orgId: ORG,
      actor,
      params: { received_id: row!.id },
      threadId: THREAD,
      origin: "human-ui",
    })
    const d = got.data as {
      files: Array<{ kind: string; url: string }>
      actions: Array<{ action: string; reasons: Array<{ reason: string; afnor_code: string }> }>
    }
    expect(d.files.map((f) => f.kind).sort()).toEqual(["original", "rendering"])
    expect(d.files.every((f) => f.url.startsWith("/api/files/"))).toBe(true)
    expect(d.actions.map((a) => a.action)).toEqual(["refuse", "dispute"])
    expect(d.actions[0]!.reasons.find((r) => r.reason === "duplicate_invoice")?.afnor_code).toBe(
      "DOUBLON",
    )
  }, 120_000)

  it("a redirect to a host that is not listed is refused: the invoice is listed with files pending, nothing fetched from that host", async () => {
    const id = fake.receive({ number: "FS-2026-002", routing: OWN_SIREN })
    fake.redirects.set(`blob${id}o`, "https://files.elsewhere.example/stolen")
    await runJob("einvoicing-received-catchup")
    const row = await receivedRow(id)
    expect(row).toMatchObject({ files_pending: true })
    expect(row!.last_error.code).toBe("received_file_download_refused")
    expect(fake.downloads.some((d) => d.host === "files.elsewhere.example")).toBe(false)
    const [f] = await sql<
      Array<{ file_id: string | null }>
    >`SELECT file_id::text FROM app_invoicing.received_einvoice_files WHERE received_id = ${row!.id} AND kind = 'original'`
    expect(f!.file_id).toBeNull()
  }, 180_000)

  it("refusing: the agent's request creates ONE approval, an auto-approve policy changes nothing, the agent cannot run the action; the person's approval sends it once", async () => {
    const ref = await arrive("FS-2026-003")
    await runJob("einvoicing-transmit")
    const row = await receivedRow(ref)
    await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name, enabled, conditions, limits)
      VALUES (${ORG}, 'invoicing:received_einvoice_set_status', true, '[]'::jsonb, '{}'::jsonb) ON CONFLICT DO NOTHING`
    try {
      const before = puts()
      const req = await executeToolCore({
        toolName: "invoicing:received_einvoice_action_request",
        orgId: ORG,
        actor,
        params: {
          received_id: row!.id,
          action: "refuse",
          reason: "duplicate_invoice",
          comment: "Billed twice",
        },
        threadId: THREAD,
        origin: "in-app-agent",
      })
      const staged = ("data" in req ? req.data : null) as { status: string; approval_id: string }
      expect(staged.status).toBe("staged")
      const approvals = await sql<
        Array<{ id: string; status: string; current_payload: Record<string, unknown> }>
      >`
        SELECT id, status, current_payload FROM kernel.approval_requests WHERE org_id = ${ORG} AND tool_name = 'invoicing:received_einvoice_set_status'`
      expect(approvals).toHaveLength(1)
      expect(approvals[0]).toMatchObject({ id: staged.approval_id, status: "pending" })
      expect(approvals[0]!.current_payload).toEqual({
        received_id: row!.id,
        action: "refuse",
        reason: "duplicate_invoice",
        comment: "Billed twice",
      })
      // The gated action itself: never reachable by the agent, and the policy does not run it.
      const asAgent = await executeToolCore({
        toolName: "invoicing:received_einvoice_set_status",
        orgId: ORG,
        actor: agentActor as never,
        params: approvals[0]!.current_payload,
        threadId: THREAD,
        origin: "in-app-agent",
      })
      expect("error" in asAgent ? asAgent.error.code : "ran").toBe("forbidden")
      // From the agent's turn under the person's own context it parks (the policy cannot pass it).
      const viaTurn = await executeToolCore({
        toolName: "invoicing:received_einvoice_set_status",
        orgId: ORG,
        actor,
        params: approvals[0]!.current_payload,
        threadId: THREAD,
        origin: "in-app-agent",
      })
      expect("blocked" in viaTurn).toBe(true)
      expect(puts()).toBe(before)
      expect((await receivedRow(ref))!.pending_action).toMatchObject({
        action: "refuse",
        approval_id: staged.approval_id,
      })

      await decideApproval({
        orgId: ORG,
        requestId: staged.approval_id,
        actor,
        decision: "approve",
      })
      expect(puts()).toBe(before + 1)
      expect(fake.supplierInvoices.get(ref)!.e_invoicing).toMatchObject({
        status: "refused",
        reason: "duplicate_invoice",
      })
      const after = await receivedRow(ref)
      expect(after).toMatchObject({
        status: "refused",
        status_code: 210,
        actions: [],
        pending_action: null,
      })
      expect(
        (after!.lifecycle_log as Array<Record<string, unknown>>).find((e) => e.source === "action"),
      ).toMatchObject({
        action: "refuse",
        code: "DOUBLON",
        by: USER,
        approval_request_id: staged.approval_id,
        outcome: "sent",
      })
      // Nothing more can be asked for a refused invoice.
      const again = await executeToolCore({
        toolName: "invoicing:received_einvoice_action_request",
        orgId: ORG,
        actor,
        params: { received_id: row!.id, action: "dispute", reason: "delivery_issue" },
        threadId: THREAD,
        origin: "in-app-agent",
      })
      const code =
        "data" in again
          ? (again.data as { error?: { code?: string } })?.error?.code
          : "error" in again
            ? again.error.code
            : "blocked"
      expect(code).toBe("received_action_not_allowed")
    } finally {
      await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    }
  }, 180_000)
})

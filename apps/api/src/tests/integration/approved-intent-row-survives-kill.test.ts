// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An APPROVED gated call runs claim, handler and the approved mark in one
// transaction (run-approved-handler.ts). An app that must leave a record of an
// outside call it is about to make writes it with `ctx.db.insertNow`, which
// execute-tool hands its own transaction under the run's actor
// (`commitNowTx`), so the row commits at once and outlives that transaction's
// rollback when the sandbox kills the handler after the call.
//
// The bridge tests (sandbox/rpc-bridge-commit-now.test.ts) give the bridge a
// channel themselves. This file proves the wiring on the real path: Boxtal is
// installed from source in the real sandbox, a person approves its gated
// create_shipment (executeTool -> pending approval -> decideApproval ->
// executeApprovedToolHandlerInternal -> executeToolHandler -> sandbox ->
// bridge), Boxtal's fake API takes the paid POST and never answers, the
// sandbox kills the handler, and then:
//   - the label reservation Boxtal committed before the POST is still there
//     (link_state create_in_flight), although the run rolled back;
//   - boxtal:stuck_list, called like any tool, names it as a create orphan.
//
// Run it from apps/api:
//   bun run scripts/test-run.ts integration --file src/tests/integration/approved-intent-row-survives-kill.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  connectedAccounts,
  threadParticipants,
  threads,
  userScopeGrants,
  userThreadState,
} from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { EgressGrantsTestAccess } from "~/modules/apps/egress-grants"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps } from "~/modules/apps/runtime"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { insertAppRow, jsonCell } from "~/seed/factories/app-tables"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
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

const ORG = randomUUID()
const USER = randomUUID()
const THREAD = randomUUID()
const ORDER_NAME = "#4120"

const SCOPES = [
  "boxtal:shipments:read",
  "boxtal:shipments:write",
  "boxtal:quotes:read",
  "boxtal:catalog:read",
  "boxtal:approve",
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:settings:read",
]
const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}

/** The handler's whole budget: the POST below never answers, so the sandbox kills it at this. */
const KILL_AFTER_MS = 8_000
const prevMaxTimeout = process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS

const COTATION_XML = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>CHRP</code><label>Chronopost</label></operator><service><code>Chrono18</code><label>Chrono 18</label></service><price><currency>EUR</currency><tax-exclusive>7.80</tax-exclusive><tax-inclusive>9.36</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

const SENDER = {
  name: "Fabrikam SAS",
  company: "Fabrikam SAS",
  email: "ship@fabrikam.example",
  phone: "+33123456789",
  street: "10 Rue de Rivoli",
  city: "Paris",
  postalCode: "75001",
  countryIsoCode: "FR",
}
const RECIPIENT = {
  name: "Atelier Lumen",
  email: "ops@atelier-lumen.example",
  phone: "+33478000000",
  street: "4 Quai Victor Augagneur",
  city: "Lyon",
  postalCode: "69003",
  countryIsoCode: "FR",
}

/** Every request the sandbox sent Boxtal's hosts, in order. */
const calls: Array<{ url: string; method: string }> = []
/** The paid POST never answers (released when the file ends). */
const hangingPosts: Array<() => void> = []

function boxtalFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = (init?.method ?? "GET").toUpperCase()
  calls.push({ url, method })
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  if (url.includes("/iam/account-app/token"))
    return Promise.resolve(json({ accessToken: "tok", expiresIn: 3600 }))
  if (url.includes("/cotation"))
    return Promise.resolve(
      new Response(COTATION_XML, { status: 200, headers: { "content-type": "application/xml" } }),
    )
  if (url.endsWith("/shipping-order") && method === "POST") {
    // Boxtal has sold the label; its answer never reaches the handler. It ignores the
    // egress's own abort too, so what ends the run is the sandbox's kill, not a fetch error.
    return new Promise((_resolve, reject) => {
      hangingPosts.push(() => reject(new Error("test over")))
    })
  }
  return Promise.resolve(json({ status: 200, timestamp: "t", content: [] }))
}

let documentId = ""

describe("an approved call's commit-now row survives the sandbox kill (real approval path, Boxtal)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = String(KILL_AFTER_MS)
    await seedOrgRow({ id: ORG, name: "Intent Row Org", slug: `intent-row-${ORG.slice(0, 8)}` })
    await seedUserRow({
      id: USER,
      orgId: ORG,
      email: `intent-${USER.slice(0, 8)}@test.com`,
      passwordHash: "hash",
      name: "Shipper",
      status: "active",
    })
    await withSystemDb("intent-row-test-thread", async (db) => {
      await db.insert(threads).values({
        id: THREAD,
        orgId: ORG,
        handle: `intent-thread-${THREAD.slice(0, 8)}`,
        type: "agent_chat",
        createdBy: USER,
      })
      await db
        .insert(threadParticipants)
        .values({ threadId: THREAD, userId: USER, orgId: ORG, role: "admin" })
      await db.insert(userThreadState).values({ userId: USER, threadId: THREAD, orgId: ORG })
      await db
        .insert(userScopeGrants)
        .values(SCOPES.map((scope) => ({ userId: USER, orgId: ORG, scope })))
        .onConflictDoNothing()
    })
    await initSandboxPool()
    await initWorkerPool()
    await ensureAppsForOrg(ORG)
    await registerApps(
      [bundledDescriptor("invoicing") as never, bundledDescriptor("boxtal") as never],
      ORG,
    )
    await withSystemDb("intent-row-test-connection", (db) =>
      db.insert(connectedAccounts).values({
        orgId: ORG,
        appName: "boxtal",
        connectionName: "boxtal",
        ownerType: "org",
        ownerId: null,
        providerType: "credentials",
        identifier: "test-boxtal",
        displayName: "test-boxtal",
        credentialsEncrypted: encryptSecret(
          JSON.stringify({
            v1Key: "k1",
            v1Secret: "s1",
            v3Key: "k3",
            v3Secret: "s3",
            environment: "sandbox",
          }),
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountCredentials,
        ),
        status: "active",
        createdBy: USER,
      }),
    )
    // Registered from source, outside the catalog install that grants an app its declared
    // domains: grant Boxtal every domain its manifest declares, as a grandfathered install has.
    EgressGrantsTestAccess.setLookup(async () => null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(
      (h) => h === "api.boxtal.build" || h === "test.envoimoinscher.com",
    )
    SandboxBridgeTestAccess.setFetch(boxtalFetch as unknown as typeof fetch)

    // What Boxtal ships from: the invoice it ships, the sender, the product's parcel, the order.
    // An issuer profile is a gated configuration change, so the fixture writes the row.
    const issuerProfileId = randomUUID()
    await withSystemDb("intent-row-test-issuer", (db) =>
      insertAppRow(db, "invoicing", "issuer_profiles", {
        id: issuerProfileId,
        org_id: ORG,
        legal_name: "Fabrikam SAS",
        country: "FR",
        default_currency: "EUR",
      }),
    )
    const created = await executeTool({
      toolName: "invoicing:drafts_create",
      orgId: ORG,
      actor,
      params: {
        type: "invoice",
        issuer_profile_id: issuerProfileId,
        currency: "EUR",
        counterparty_name: RECIPIENT.name,
        counterparty_email: RECIPIENT.email,
        counterparty_country: "FR",
        counterparty_address: `${RECIPIENT.street}\n${RECIPIENT.postalCode} ${RECIPIENT.city}\nFrance`,
        items: [
          {
            description: "Field Preamp",
            quantity: 1,
            unit_price_minor: 39900,
            product_source: "shopify",
            external_id: "V1",
          },
        ],
      },
      threadId: THREAD,
      origin: "human-ui",
    })
    const draft = (created as { data?: { id?: string; document?: { id?: string } } }).data
    documentId = draft?.id ?? draft?.document?.id ?? ""
    if (!documentId) throw new Error(`drafts_create gave no document: ${JSON.stringify(created)}`)
    await withSystemDb("intent-row-test-boxtal", async (db) => {
      await insertAppRow(db, "boxtal", "app_config", {
        org_id: ORG,
        key: "sender_address",
        value: jsonCell(SENDER),
      })
      await insertAppRow(db, "boxtal", "shipping_profile", {
        org_id: ORG,
        product_source: "shopify",
        product_id: "V1",
        unit_weight: 0.5,
        solo_length: 30,
        solo_width: 20,
        solo_height: 10,
        content_category: "content:v1:10120",
      })
      await insertAppRow(db, "boxtal", "prep_meta", {
        org_id: ORG,
        document_ref: documentId,
        order_name: ORDER_NAME,
      })
    })
  }, 180_000)

  afterAll(async () => {
    for (const fail of hangingPosts) fail()
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    EgressGrantsTestAccess.setLookup(null)
    if (prevMaxTimeout === undefined) delete process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
    else process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = prevMaxTimeout
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("approving a label buy killed after the paid POST leaves the reservation, and stuck_list names it", async () => {
    const staged = await executeTool({
      toolName: "boxtal:create_shipment",
      orgId: ORG,
      actor,
      params: {
        draft_id: documentId,
        offer_code: "CHRP-Chrono18",
        recipient_phone: RECIPIENT.phone,
        recipient_address: RECIPIENT,
        quoted_price_ttc: 9.36,
      },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    const requestId = staged.blocked?.approvalRequestId
    if (!requestId)
      throw new Error(`create_shipment did not park an approval: ${JSON.stringify(staged)}`)
    expect(
      calls.filter((c) => c.method === "POST" && c.url.endsWith("/shipping-order")),
    ).toHaveLength(0)

    await decideApproval({ orgId: ORG, requestId, actor, decision: "approve" }).catch(
      (err: unknown) => err,
    )

    // The label was bought: one paid POST, never answered.
    expect(
      calls.filter((c) => c.method === "POST" && c.url.endsWith("/shipping-order")),
    ).toHaveLength(1)
    // The run did not finish: the request was not marked approved.
    const [request] = await sql<Array<{ status: string }>>`
      SELECT status FROM kernel.approval_requests WHERE id = ${requestId}`
    expect(request?.status).not.toBe("approved")
    // The reservation committed before the POST is still there, although the run rolled back.
    const rows = await sql<
      Array<{
        id: string
        link_state: string
        external_id: string | null
        boxtal_order_id: string | null
      }>
    >`SELECT id, link_state, external_id, boxtal_order_id FROM app_boxtal.shipment
      WHERE org_id = ${ORG} AND document_ref = ${documentId}`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      link_state: "create_in_flight",
      external_id: ORDER_NAME,
      boxtal_order_id: null,
    })

    // Twenty minutes on it is an orphan, and stuck_list, called like any tool, names it.
    await sql`UPDATE app_boxtal.shipment SET created_at = now() - interval '20 minutes'
      WHERE id = ${rows[0]!.id}`
    const stuck = await executeTool({
      toolName: "boxtal:stuck_list",
      orgId: ORG,
      actor,
      params: {},
      threadId: THREAD,
      origin: "in-app-agent",
    })
    const listed = (stuck as { data?: { rows?: Array<Record<string, unknown>> } }).data?.rows ?? []
    const orphan = listed.find((r) => r.id === rows[0]!.id)
    expect(orphan).toMatchObject({ family: "create_orphan", order_ref: ORDER_NAME })
    expect(String(orphan?.reason)).toContain("paid label may exist at Boxtal")
  }, 120_000)
})

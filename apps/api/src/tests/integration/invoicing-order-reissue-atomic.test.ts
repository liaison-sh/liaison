// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real-database proof for the `invoicing:order_reissue_apply` tool's
// `atomic: true` manifest declaration.
//
// The bundled invoicing app cannot host this test itself: it is sandboxed
// (bundled-apps/invoicing/src/test-db.ts is an in-memory mock with no real
// transactions), and scripts/check-bundled-app-purity.ts refuses any
// bundled-app source that imports host modules. mutations.test.ts already
// proves, against that mock, that the handler THROWS instead of returning a
// partial result when the replacement invoice step fails after the credit
// note issued -- but its own comment says the quiet part: "This mock has no
// real transactions ... in production the throw is what makes the whole call
// roll back." That production claim is what this file proves, against real
// Postgres, through the full approval -> executeApprovedToolHandlerInternal
// -> executeToolHandler path that execute-tool-atomic.test.ts already pins
// generically for the atomic mechanism itself.
//
// order_reissue_apply is BOTH gated and atomic, so exercising it for real
// means going through the actual approval lifecycle (executeTool -> blocked
// -> decideApproval), not a bare executeTool() call.
//
// What this test proves: on real Postgres, a failure in the replacement
// invoice half rolls back the credit note issued just before it, so an order
// edit reissue never leaves a customer credited with no replacement
// document. Verified falsifiable by transiently changing the explicit throw
// in the handler to a plain return (backed up and restored, not committed):
// the row set for the order went from two invoices only to a credit note
// plus two invoices, meaning the credit note persisted alone with the
// replacement never created, exactly the failure mode this test guards.
//
// What this test does NOT prove: that the manifest atomic flag on this tool
// does anything. It was also transiently removed and restored, and made no
// difference to either test. Tracing the dispatch confirmed why: this tool
// is unconditionally gated (no conditionalGate), so its only execution path
// is the approved re entry in run-approved-handler.ts, which always wraps
// the call in one ambient transaction built from a plain RLS transaction,
// never the bridge owned session that the atomic flag actually branches on
// in execute-tool.ts. The rollback proven above comes from the explicit
// throw in the handler plus that always ambient re entry path, not from the
// atomic flag. Do not read this green test as evidence the flag is load
// bearing here.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

// Read the manifest at call time rather than hardcoding the version -- it is
// moving as another agent works on bundled-apps/invoicing.
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

const ORG = "00000000-0000-4000-8000-0000000e5001"
const USER = "00000000-0000-4000-8000-0000000e5002"
const THREAD = "00000000-0000-4000-8000-0000000e5003"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [
    "invoicing:documents:write",
    "invoicing:documents:read",
    "invoicing:settings:write",
    "invoicing:approve",
  ],
  dimensionGrants: {},
}

async function grantScopes(): Promise<void> {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
  for (const scope of actor.scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

const counterparty = {
  contact_id: null,
  legal_name: "Buyer SARL",
  country: "FR",
  vat_id: null,
  address: "1 rue Buyer, 75002 Paris",
  email: "ap@buyersarl.example",
  // E-invoicing: the buyer's kind is stated, never guessed (the issuer here has no VAT id, so
  // the documents are out of scope either way).
  customer_kind: "individual",
}

/** Request a gated tool as an agent (always parks an approval for these two
 *  tools), then approve it as the same actor. Returns the decide call so the
 *  caller can assert success or a rejection. */
async function requestAndApprove(
  toolName: string,
  params: Record<string, unknown>,
): Promise<ReturnType<typeof decideApproval>> {
  const res = await executeTool({
    toolName,
    orgId: ORG,
    actor,
    params,
    threadId: THREAD,
    origin: "in-app-agent",
  })
  const approvalRequestId = res.blocked?.approvalRequestId
  if (!approvalRequestId) {
    throw new Error(`expected ${toolName} to park a pending approval, got ${JSON.stringify(res)}`)
  }
  return decideApproval({ orgId: ORG, requestId: approvalRequestId, actor, decision: "approve" })
}

/** Issue an original invoice for a fresh Shopify order id, returning its
 *  document id and number read back by SQL (decideApproval returns no
 *  handler payload). */
async function issueOriginalInvoice(
  issuerProfileId: string,
  shopifyOrderId: string,
): Promise<{ id: string; number: string }> {
  await requestAndApprove("invoicing:invoice_create_and_issue", {
    issuer_profile_id: issuerProfileId,
    counterparty,
    currency: "EUR",
    shopify_order_id: shopifyOrderId,
    shopify_order_number: "#1001",
    items: [{ description: "Widget", quantity: "2", unit_price_minor: 5000 }],
  })
  const rows = await sql<Array<{ id: string; number: string }>>`
    SELECT id, number FROM app_invoicing.documents
    WHERE org_id = ${ORG} AND shopify_order_id = ${shopifyOrderId} AND type = 'invoice'
    ORDER BY created_at DESC LIMIT 1`
  if (!rows[0]) throw new Error(`original invoice for order ${shopifyOrderId} was not persisted`)
  return rows[0]
}

async function documentTypesForOrder(shopifyOrderId: string): Promise<string[]> {
  const rows = await sql<Array<{ type: string }>>`
    SELECT type FROM app_invoicing.documents
    WHERE org_id = ${ORG} AND shopify_order_id = ${shopifyOrderId}
    ORDER BY type`
  return rows.map((r) => r.type)
}

describe("invoicing:order_reissue_apply -- atomic rollback against real Postgres", () => {
  let issuerProfileId: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Order Reissue Atomic Org', 'order-reissue-atomic-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'reissue-atomic@test.com', 'hash', 'Reissue Atomic Tester', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'reissue-atomic-thread', 'agent_chat', ${USER})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await grantScopes()

    await initSandboxPool()
    await initWorkerPool()

    await registerApps([bundledDescriptor("invoicing") as never], ORG)

    // Creating an issuer profile is a gated configuration change (it parks an
    // approval), so the fixture writes the row directly.
    issuerProfileId = crypto.randomUUID()
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, default_currency)
      VALUES (${issuerProfileId}, ${ORG}, 'Reissue Atomic Issuer SAS', 'FR', 'EUR')`
  }, 60_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await releaseTestLock()
  }, 60_000)

  it("replacement invoice failure rolls back the credit note too: neither document persists", async () => {
    const shopifyOrderId = "reissue-atomic-order-fail"
    const original = await issueOriginalInvoice(issuerProfileId, shopifyOrderId)

    // Honest production failure: a SECOND live (uncredited) invoice already
    // exists for this Shopify order -- the same decoy pattern
    // mutations.test.ts uses against its mock. When order_reissue_apply tries
    // to create the replacement, invoiceCreateAndIssue's
    // assertNoLiveInvoiceForOrder guard refuses it with "already_invoiced",
    // a real guard a duplicate webhook delivery would actually trip -- not a
    // monkey-patched transaction.
    await sql`INSERT INTO app_invoicing.documents
      (org_id, type, status, currency, issuer_profile_id, shopify_order_id, number,
       grand_total_minor, lifecycle_log, counterparty_name, counterparty_country)
      VALUES (${ORG}, 'invoice', 'issued', 'EUR', ${issuerProfileId}, ${shopifyOrderId},
       'INV-2026-DECOY', 5000, '[]'::jsonb, 'Buyer SARL', 'FR')`

    // The sandboxed handler throws (no protocol row recorded for an ambient-
    // transaction abort), so the approvals kernel classifies the outcome as
    // "ambiguous" rather than replaying the bare Error -- that reclassification
    // is itself real production behaviour (run-approved-handler.ts /
    // decide.ts), not a test artifact. The underlying handler message survives
    // in the thrown error's JSON payload either way.
    let caught: unknown
    try {
      await requestAndApprove("invoicing:order_reissue_apply", {
        original_document_id: original.id,
        shopify_order_id: shopifyOrderId,
        shopify_order_number: "#1001",
        billing_signature: "sig-2",
        dedupe_key: `${shopifyOrderId}:sig-2`,
        items: [{ description: "Widget", quantity: "3", unit_price_minor: 6000 }],
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(JSON.stringify(caught)).toMatch(/replacement invoice failed/)

    // SQL, not the tool's return value: the original invoice and the decoy
    // are the only two documents for this order. No credit note (would be a
    // customer credited with no replacement) and no replacement invoice
    // persisted.
    expect(await documentTypesForOrder(shopifyOrderId)).toEqual(["invoice", "invoice"])
  })

  it("a successful reissue persists BOTH the credit note and the replacement invoice", async () => {
    const shopifyOrderId = "reissue-atomic-order-success"
    const original = await issueOriginalInvoice(issuerProfileId, shopifyOrderId)

    await requestAndApprove("invoicing:order_reissue_apply", {
      original_document_id: original.id,
      shopify_order_id: shopifyOrderId,
      shopify_order_number: "#1001",
      billing_signature: "sig-2",
      dedupe_key: `${shopifyOrderId}:sig-2`,
      items: [{ description: "Widget", quantity: "3", unit_price_minor: 6000 }],
    })

    // The success companion that matters just as much as the rollback: this
    // must not pass merely because nothing ever ran.
    const types = await documentTypesForOrder(shopifyOrderId)
    expect(types.filter((t) => t === "invoice")).toHaveLength(2) // original + replacement
    expect(types.filter((t) => t === "credit_note")).toHaveLength(1)
  })
})

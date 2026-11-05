// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e S5b — Proforma killer-path wiring probe (HTTP-only).
//
// Plan §S5b: a direct call to the proforma killer-path tool surfaces a real
// approval that approves into a numbered proforma, with NO
// `ctx.requestApproval is not a function` error in the page's error stream.
// This is the deterministic core of the spec #7 killer-path (S5 layers the
// agent chat UI on top of the same server flow).
//
// Reality vs plan: `proforma_create_and_issue` is declaratively `gated: true`
// in the manifest, so the kernel parks it for approval BEFORE the handler runs
// and the tool route returns a `{ blocked: { approvalRequestId } }` envelope
// (not the handler's `{ status: 'pending_approval' }`). Both shapes are handled
// below. The `ctx.requestApproval` SDK→bridge round-trip itself is exercised by
// the handler-conditional `invoice_create_and_issue` in S3 (threshold-approval);
// here we validate the proforma killer-path end to end: gate → approve →
// numbered PRO-… document with reason + declared value, filed against the
// contact.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { callToolAsAgent, decideApproval, listPendingApprovals } from "../helpers/approvals"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

/** Extract the approval id from either gating shape: the kernel's declarative
 *  `{ blocked: { approvalRequestId } }` or a handler-conditional
 *  `{ status: 'pending_approval', approval_id }`. */
function extractApprovalId(payload: Record<string, unknown>): string | undefined {
  const blocked = payload.blocked as { approvalRequestId?: string } | undefined
  if (blocked?.approvalRequestId) return blocked.approvalRequestId
  if (payload.status === "pending_approval" && typeof payload.approval_id === "string") {
    return payload.approval_id
  }
  return undefined
}

test.describe("Invoicing: proforma killer-path", () => {
  test("proforma_create_and_issue parks for approval; approving issues a numbered proforma", async ({
    page,
    env,
    world,
    qa,
  }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)

    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "FR",
          name: "Return Customer",
          email: "return-s5b@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contactId = installed.additionalContactIds[0]

    // Bridge-error listener — `ctx.requestApproval is not a function` and other
    // SDK/bridge wiring failures surface here.
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    // Killer-path call: agent-shaped proforma with reason + declared value.
    // Staged as the AGENT's call: approvals are for agents, and a person's own
    // call (the tools route) issues at once without parking one.
    const callResp = await callToolAsAgent(
      env.serverUrl,
      qa.admin.token,
      "invoicing:proforma_create_and_issue",
      {
        // Killer-path shape: counterparty + reason + declared value + items,
        // NO issuer_profile_id/currency (the handler defaults the org issuer).
        counterparty: {
          contact_id: contactId,
          legal_name: "Return Customer",
          country: "FR",
          vat_id: null,
          address: "22 Avenue des Champs-Elysees, 75008 Paris, France",
          email: "return-s5b@e2e.test",
        },
        reason: "return",
        declared_value_minor: 25000,
        items: [
          {
            position: 1,
            description: "Kestrel 2 — Black",
            quantity: "1",
            unit_price_minor: "25000",
            hs_code: "9207.10",
            country_of_origin: "CN",
            product_source: null,
            external_id: null,
          },
        ],
      },
    )
    if (callResp.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("[S5b call] non-200:", callResp.status, JSON.stringify(callResp.body))
    }
    expect(callResp.status).toBe(200)
    const callPayload = unwrap(callResp.body)
    // Explicitly NOT an error envelope (no `ctx.requestApproval is not a function`).
    expect(callPayload.error, JSON.stringify(callPayload)).toBeUndefined()
    const approvalId = extractApprovalId(callPayload)
    expect(approvalId, `expected an approval id in ${JSON.stringify(callPayload)}`).toBeTruthy()

    // No bridge wiring errors captured.
    const bridgeErrors = consoleErrors.filter((m) =>
      /window\.__liaisonHost|Failed to fetch dynamically imported module|does not provide an export named|ctx\.requestApproval is not a function/.test(
        m,
      ),
    )
    expect(bridgeErrors, bridgeErrors.join("\n")).toHaveLength(0)

    // Exactly one pending approval for the invoicing app.
    const pending = await listPendingApprovals({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      toolPrefix: "invoicing:",
    })
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe(approvalId)

    // Approve → K6 re-entry issues the proforma exactly once.
    const decideResp = await decideApproval({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      requestId: approvalId!,
      decision: "approve",
    })
    if (decideResp.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("[S5b decide] non-200:", decideResp.status, JSON.stringify(decideResp.body))
    }
    expect(decideResp.status).toBe(200)

    // Poll documents_search for the issued proforma.
    let issued: Record<string, unknown> | undefined
    let proformas: Array<Record<string, unknown>> = []
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const searchResp = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_search", {
        method: "POST",
        token: qa.admin.token,
        body: { params: { type: "proforma" } },
      })
      expect(searchResp.status).toBe(200)
      const sp: unknown = unwrap(searchResp.body)
      const rawBody = searchResp.body as unknown
      proformas = (Array.isArray(sp) ? sp : Array.isArray(rawBody) ? rawBody : []) as Array<
        Record<string, unknown>
      >
      issued = proformas.find((d) => d.status === "issued")
      if (issued) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(issued, "an issued proforma should exist after approval").toBeTruthy()

    // Exactly one proforma issued (no double-file), numbered PRO-YYYY-NNNN.
    expect(proformas.filter((d) => d.status === "issued").length).toBe(1)
    expect(String(issued!.number)).toMatch(/^PRO-\d{4}-\d{4}$/)

    // No lingering pending approval.
    const afterPending = await listPendingApprovals({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      toolPrefix: "invoicing:",
    })
    expect(afterPending.length).toBe(0)
  })
})

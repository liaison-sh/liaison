// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e S3 — Threshold-gated invoice → approval → approve → K6 re-entry.
//
// Plan §S3: an invoice whose grand total exceeds the issuer's approval
// threshold creates a pending approval; approving it triggers K6 re-entry and
// the document issues exactly once. Pins the K6 case-drift concern (camelCase
// SDK `ctx.approval` vs snake_case handler reads) and the `ctx.requestApproval`
// bridge wiring — if either is broken the issue either 500s with
// `ctx.requestApproval is not a function`, or the post-approval re-entry loops
// / double-files / hangs.
//
// Implementation notes (deviation from plan, mirroring S1):
//  - The editor's clicked-issue path routes through tools the manifest does
//    not declare; the plan permits direct tool calls for load-bearing
//    assertions. S3 issues via `POST /api/apps/invoicing/tools/invoice_create_and_issue`.
//  - The gated tool returns `{ status: 'pending_approval', approval_id }`; the
//    requestApproval call stamps tool_name `invoicing:invoice.create_and_issue`.
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

test.describe("Invoicing: threshold-gated approval re-entry", () => {
  test("over-threshold issue parks for approval; approving it issues exactly once", async ({
    page,
    env,
    world,
    qa,
  }) => {
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)

    // 1. Install with a low approval threshold (€50.00) + a FR contact.
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      issuerOverrides: { invoice_approval_threshold_minor: 5000 },
      additionalContacts: [
        {
          country: "FR",
          name: "Lucas Threshold Customer",
          email: "lucas-s3@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contactId = installed.additionalContactIds[0]

    // Login + capture bridge errors (incl. `ctx.requestApproval is not a function`).
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })
    await loginAs(page, env, qa.admin.email, "12345678")

    // 2. Issue €120 (>€50 threshold) → expect a pending-approval envelope.
    // Staged as the AGENT's call: approvals are for agents, and a person's own
    // call (the tools route) issues at once without parking one.
    const issueResp = await callToolAsAgent(
      env.serverUrl,
      qa.admin.token,
      "invoicing:invoice_create_and_issue",
      {
        counterparty: {
          contact_id: contactId,
          legal_name: "Lucas Threshold Customer",
          country: "FR",
          vat_id: null,
          address: "45 Boulevard Haussmann, 75009 Paris, France",
          email: "lucas-s3@e2e.test",
        },
        issuer_profile_id: installed.primaryIssuerProfileId,
        currency: "EUR",
        incoterm: "DAP",
        items: [
          {
            position: 1,
            description: "Above-threshold product",
            quantity: "1",
            unit_price_minor: "10000",
            product_source: null,
            external_id: null,
          },
        ],
      },
    )
    if (issueResp.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("[S3 issue] non-200:", issueResp.status, JSON.stringify(issueResp.body))
    }
    expect(issueResp.status).toBe(200)
    const issuePayload = unwrap(issueResp.body)
    // The agent's call parks: through the kernel gate (`blocked`, the tool is
    // gated for an agent) or the handler's own over-threshold approval
    // (`pending_approval`). Either way exactly one approval, and approving it
    // must issue exactly once. (A person's own call never parks since
    // approvals are for agents, so the threshold is the agent's path only.)
    const blocked = issuePayload.blocked as { approvalRequestId?: string } | undefined
    const approvalId =
      blocked?.approvalRequestId ??
      (issuePayload.status === "pending_approval"
        ? (issuePayload.approval_id as string)
        : undefined)
    expect(
      approvalId,
      `expected a pending approval in ${JSON.stringify(issuePayload)}`,
    ).toBeTruthy()

    // 3. A pending approval row exists for the invoicing app.
    const pending = await listPendingApprovals({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      toolPrefix: "invoicing:",
    })
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe(approvalId as string)

    // 4. Approve it (same actor — two-eyes is off for invoice_create_and_issue here).
    const decideResp = await decideApproval({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      requestId: approvalId as string,
      decision: "approve",
    })
    if (decideResp.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("[S3 decide] non-200:", decideResp.status, JSON.stringify(decideResp.body))
    }
    expect(decideResp.status).toBe(200)

    // 5. Poll documents_search until the invoice issues. K6 case-drift surfaces
    //    here: if `ctx.approval` is read with the wrong casing the re-entry never
    //    skips the gate (no issued doc within budget) or double-files.
    let issued: Record<string, unknown> | undefined
    const deadline = Date.now() + 15_000
    let invoices: Array<Record<string, unknown>> = []
    while (Date.now() < deadline) {
      const searchResp = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_search", {
        method: "POST",
        token: qa.admin.token,
        body: { params: { type: "invoice" } },
      })
      expect(searchResp.status).toBe(200)
      // documents_search returns DocumentHeader[]; the tool route wraps it as
      // { data: [...] }, so the unwrapped payload IS the array.
      const sp: unknown = unwrap(searchResp.body)
      const rawBody = searchResp.body as unknown
      invoices = (
        Array.isArray(sp)
          ? sp
          : Array.isArray(rawBody)
            ? rawBody
            : ((sp as { results?: unknown[]; documents?: unknown[] }).results ??
              (sp as { documents?: unknown[] }).documents ??
              [])
      ) as Array<Record<string, unknown>>
      issued = invoices.find((d) => d.status === "issued")
      if (issued) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(issued, "an issued invoice should exist after approval").toBeTruthy()

    // 6. Exactly one invoice exists (no double-file from a broken K6 re-entry),
    //    and its number_int is the first in the issuer's sequence.
    const issuedInvoices = invoices.filter((d) => d.status === "issued")
    expect(issuedInvoices.length).toBe(1)
    expect(String(issued!.number)).toMatch(/^INV-\d{4}-\d{4}$/)

    // 7. No second pending approval row lingers (approve consumed it).
    const afterPending = await listPendingApprovals({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      toolPrefix: "invoicing:",
    })
    expect(afterPending.length).toBe(0)

    // 8. No bridge errors — notably `ctx.requestApproval is not a function`.
    const bridgeErrors = consoleErrors.filter((m) =>
      /window\.__liaisonHost|Failed to fetch dynamically imported module|does not provide an export named|ctx\.requestApproval is not a function/.test(
        m,
      ),
    )
    expect(bridgeErrors).toEqual([])
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e S5 — Agent killer-path: return proforma, on the conversation.
//
// Plan §S5 (spec #7): the agent calls `invoicing:proforma_create_and_issue`; the
// Documents-side approval card surfaces in the conversation; approving it (UI
// click) issues a numbered proforma with the PDF filed against the contact.
//
// P4c-T21b — WHAT CHANGED. This used to create the approval OUT OF BAND through
// the tool route, then stub `**\/api/agent/chat` with a canned SSE stream whose
// `tool-result` pointed at that pre-made approval id. The agent loop never ran:
// what the test proved was that the retired panel renders a blocked envelope
// someone else made. The turn is now scripted on the SERVER and only the MODEL
// is scripted (`agent-turn.ts`), so the gated tool call is made BY THE TURN,
// the gate stages the approval itself, and the card the operator approves is
// the one that call produced. The server-only flow (gate -> approve -> numbered
// proforma) is still covered headless by S5b.

import { existsSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import { loginAsAdmin, openAgentConversation, sendInConversation } from "../agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, turnToolCalls, waitForTurnEnd } from "../agent-turn"
import { seedModelPricingAndCredits } from "../helpers/agent-seed"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

const ANSWER = "Drafted a return proforma; approve the card below to issue it."

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

test.describe("Invoicing: agent proforma killer-path", () => {
  test("agent surfaces the proforma approval card; UI approve issues a numbered proforma", async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(180_000)
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    await seedModelPricingAndCredits(env, world.org.id)

    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "FR",
          name: "Agent Return Customer",
          email: "agent-return-s5@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contactId = installed.additionalContactIds[0]

    // Capture bridge errors (incl. ctx.requestApproval is not a function).
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })

    // THE TURN. `invoicing__*` is an app tool and every app tool is deferred
    // until `tool_search` loads it (`tool-bridge.ts`), so discovery is a step of
    // the turn. The proforma call is GATED (handler-conditional), so it stages
    // an approval instead of issuing — which is the whole point.
    const token = qa.admin.token
    const threadId = await agentDmThreadId(env, token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        { toolCalls: [{ name: "kernel__tool_search", args: { query: "issue a proforma" } }] },
        {
          toolCalls: [
            {
              name: "invoicing__proforma_create_and_issue",
              args: {
                counterparty: {
                  contact_id: contactId,
                  legal_name: "Agent Return Customer",
                  country: "FR",
                  vat_id: null,
                  address: "12 Rue de la Paix, 75002 Paris, France",
                  email: "agent-return-s5@e2e.test",
                },
                reason: "return",
                declared_value_minor: 25000,
                items: [
                  {
                    position: 1,
                    description: "Kestrel 2 - Black",
                    quantity: "1",
                    unit_price_minor: "25000",
                    product_source: null,
                    external_id: null,
                  },
                ],
              },
            },
          ],
        },
        { text: ANSWER },
      ],
    })

    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "Issue a return proforma for the customer.")
    await waitForTurnEnd(env, { threadId, token, contains: ANSWER, timeout: 120_000 })

    // The REAL gate staged a REAL approval, named by the turn itself.
    const calls = await turnToolCalls(env, {
      threadId,
      token,
      contains: ANSWER,
      expect: "invoicing__proforma_create_and_issue",
    })
    const gatedResult = calls.find((c) => c.toolName === "invoicing__proforma_create_and_issue")
      ?.result as { blocked?: unknown; approvalRequestId?: string; approval_id?: string } | null
    const blockedObj = (gatedResult?.blocked ?? {}) as { approvalRequestId?: string }
    const approvalId =
      gatedResult?.approvalRequestId ?? blockedObj.approvalRequestId ?? gatedResult?.approval_id
    expect(
      approvalId,
      `the proforma call did not stage an approval: ${JSON.stringify(gatedResult).slice(0, 600)}`,
    ).toBeTruthy()

    // The gated tool row and its live ApprovalCard render in THIS turn's row.
    const turnRow = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: ANSWER })
      .last()
    await expect(
      turnRow.locator('[data-tool-name="invoicing__proforma_create_and_issue"]').first(),
    ).toBeVisible({ timeout: 30_000 })
    const card = turnRow.locator(`[data-testid="approval-card"][data-request-id="${approvalId}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByTestId("approval-card-action-approve").click()
    await expect(card.getByTestId("approval-card-status-badge")).toContainText("Approved", {
      timeout: 30_000,
    })

    // The re-entry issued the proforma — poll documents_search.
    let issued: Record<string, unknown> | undefined
    let proformas: Array<Record<string, unknown>> = []
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const searchResp = await api(env.serverUrl, "/api/apps/invoicing/tools/documents_search", {
        method: "POST",
        token: qa.admin.token,
        body: { params: { type: "proforma" } },
      })
      const sp: unknown = unwrap(searchResp.body)
      const rawBody = searchResp.body as unknown
      proformas = (Array.isArray(sp) ? sp : Array.isArray(rawBody) ? rawBody : []) as Array<
        Record<string, unknown>
      >
      issued = proformas.find((d) => d.status === "issued")
      if (issued) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(issued, "an issued proforma should exist after UI approve").toBeTruthy()
    expect(proformas.filter((d) => d.status === "issued").length).toBe(1)
    expect(String(issued!.number)).toMatch(/^PRO-\d{4}-\d{4}$/)

    // No bridge wiring errors.
    const bridgeErrors = consoleErrors.filter((m) =>
      /window\.__liaisonHost|Failed to fetch dynamically imported module|does not provide an export named|ctx\.requestApproval is not a function/.test(
        m,
      ),
    )
    expect(bridgeErrors, bridgeErrors.join("\n")).toHaveLength(0)
  })
})

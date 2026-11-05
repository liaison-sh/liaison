// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e — agent driving the Shopify DRAFT ORDER mutation.
//
// `draft_orders_create` is GATED (`gated: true`, `approvalImpact: "internal"`),
// so the kernel must stage an approval instead of executing it. That is the
// property under test, and P4c-T21b is what makes it a test at all: the old
// version wrote its own `{ blocked: { approvalRequestId: "0000...a1" } }` into a
// canned SSE stream and asserted the panel echoed the id back, which is true of
// any string. The call now runs FOR REAL against the live dev store, so the
// blocked envelope, the approval row and the inline card all come from the
// kernel's real gate — and NOTHING is created on the store, because the
// scenario never approves it.
//
// The variant ids come from a REAL `products_search` run out of band: a static
// script cannot chain an id out of its own earlier step, and a made-up gid
// would make the gate refuse for the wrong reason.
//
// THE ARGUMENT SHAPE IS THE MANIFEST'S. `draft_orders_create` takes ONE required
// property, `input` (a Shopify `DraftOrderInput`), and the customer rides in it as
// `purchasingEntity.customerId`: there is no top-level `customerId` and no
// `customer` field. A flat `{ customerId, lineItems }` is refused by the schema
// before the gate is ever reached, which is what this scenario used to script.
// The envelope now names the reason it refused
// (`invalid_type ... "path":["input"]`), so a caller can read what broke.

import { loginAsAdmin, openAgentConversation, sendInConversation } from "../agent-bootstrap"
import { turnToolCalls, waitForTurnEnd } from "../agent-turn"
import { seedModelPricingAndCredits } from "../helpers/agent-seed"
import {
  installShopifyForAgent,
  runShopifyTool,
  scriptShopifyTurns,
} from "./_agent-shopify-harness"
import { expect, requireShopifyCreds, test } from "./_shopify-fixtures"

const ANSWER = "Drafted an order; it is waiting on your approval."

/** First variant id in a products_search payload, whatever nesting it uses. */
function firstVariantId(payload: unknown): string | null {
  const gids = JSON.stringify(payload ?? null).match(/gid:\/\/shopify\/ProductVariant\/\d+/g)
  return gids?.[0] ?? null
}

test.describe("Shopify: agent DRAFT ORDER mutation", () => {
  test("'draft an order for Lucas' lands as a gated approval card", async ({
    page,
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    test.setTimeout(180_000)
    requireShopifyCreds(shopifyConfig)
    await seedModelPricingAndCredits(env, world.org.id)

    await installShopifyForAgent({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      shopDomain: shopifyConfig.shopDomain,
      realOfflineToken: shopifyConfig.offlineToken,
      realWebhookSecret: shopifyConfig.webhookSecret,
    })

    const token = qa.admin.token

    // A REAL variant from the dev store — the gate must refuse to execute, not
    // refuse because the line item points at nothing.
    const products = await runShopifyTool(env.serverUrl, token, "variants_search", { query: "" })
    const variantId = firstVariantId(products)
    expect(
      variantId,
      `no variant on the dev store: ${JSON.stringify(products).slice(0, 400)}`,
    ).toBeTruthy()
    const customers = await runShopifyTool(env.serverUrl, token, "customers_search", {
      query: "Marie",
    })
    const customerId = (JSON.stringify(customers).match(/gid:\/\/shopify\/Customer\/\d+/) ?? [])[0]
    expect(
      customerId,
      `no customer on the dev store: ${JSON.stringify(customers).slice(0, 400)}`,
    ).toBeTruthy()

    const threadId = await scriptShopifyTurns(env, {
      token,
      turns: [
        {
          calls: [
            {
              name: "shopify__draft_orders_create",
              args: {
                input: {
                  purchasingEntity: { customerId },
                  lineItems: [{ variantId, quantity: 1 }],
                  // Physical goods: the preflight refuses a draft with no
                  // consignee, and that refusal would hide the gate under test.
                  shippingAddress: {
                    firstName: "Marie",
                    lastName: "Dupont",
                    address1: "12 Rue de Rivoli",
                    city: "Paris",
                    zip: "75004",
                    countryCode: "FR",
                  },
                },
              },
            },
          ],
          text: ANSWER,
        },
      ],
    })

    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "Draft an order with one of those units.")
    await waitForTurnEnd(env, { threadId, token, contains: ANSWER, timeout: 120_000 })

    // THE GATE HELD: a real approval request, from the real kernel.
    const calls = await turnToolCalls(env, {
      threadId,
      token,
      contains: ANSWER,
      expect: "shopify__draft_orders_create",
    })
    const gated = (calls.find((c) => c.toolName === "shopify__draft_orders_create")?.result ??
      {}) as { blocked?: boolean; approvalRequestId?: string }
    expect(
      gated.blocked === true && Boolean(gated.approvalRequestId),
      `draft_orders_create did not stage an approval. variantId=${variantId} call=${JSON.stringify(calls.find((c) => c.toolName === "shopify__draft_orders_create")).slice(0, 900)}`,
    ).toBe(true)

    // The gated row carries that request id, and the live card renders under it.
    const turnRow = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: ANSWER })
      .last()
    const gatedCall = turnRow.locator('[data-tool-name="shopify__draft_orders_create"]').first()
    await expect(gatedCall).toBeVisible({ timeout: 30_000 })
    await expect(gatedCall).toHaveAttribute("data-request-id", gated.approvalRequestId as string)
    await expect(turnRow.getByTestId("approval-card").first()).toBeVisible({ timeout: 30_000 })

    // Left PENDING on purpose: approving it would create a draft order on the
    // shared dev store. The approve path is `agent-approval-card.scenario.test.ts`.
  })
})

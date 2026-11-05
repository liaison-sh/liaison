// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e — agent driving the Shopify REFUND mutation.
//
// `refunds_create` is GATED with `approvalImpact: "external"` — it moves money
// — so the kernel must stage an approval instead of executing it, and the
// operator must see what they would be approving. P4c-T21b makes that a test
// rather than an assertion about a string the test itself wrote into a canned
// SSE stream: the call runs FOR REAL against the live dev store, the blocked
// envelope and the approval row come from the real gate, and NO REFUND IS
// ISSUED because the scenario never approves it.
//
// The order id comes from a REAL `orders_search` run out of band: a static
// script cannot chain an id out of its own earlier step.
//
// THE ORDER HAS TO EXIST. The dev store is shared, live world state: when it
// holds no orders there is no real id to script, so the scenario SKIPS with the
// reason and the remedy (seed an order by completing a draft with
// `paymentPending: false`) instead of failing or, worse, passing on nothing.

import { loginAsAdmin, openAgentConversation, sendInConversation } from "../agent-bootstrap"
import { turnToolCalls, waitForTurnEnd } from "../agent-turn"
import { seedModelPricingAndCredits } from "../helpers/agent-seed"
import {
  installShopifyForAgent,
  runShopifyTool,
  scriptShopifyTurns,
} from "./_agent-shopify-harness"
import { expect, requireShopifyCreds, test } from "./_shopify-fixtures"

const ANSWER = "Queued a refund; it is waiting on your approval."

/** First order gid in a search payload, whatever nesting it uses. */
function firstOrderId(payload: unknown): string | null {
  const gids = JSON.stringify(payload ?? null).match(/gid:\/\/shopify\/Order\/\d+/g)
  return gids?.[0] ?? null
}

test.describe("Shopify: agent REFUND mutation", () => {
  test("'refund that order' lands as a gated approval card", async ({
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
    const orders = await runShopifyTool(env.serverUrl, token, "orders_search", { limit: 5 })
    const orderId = firstOrderId(orders)
    // WORLD PRECONDITION, stated out loud: a refund needs an order to refund.
    // When the dev store holds none, this scenario has nothing to assert and
    // SKIPS with the reason and the remedy, rather than failing on world state
    // or passing on nothing.
    test.skip(
      !orderId,
      `The live dev store (${shopifyConfig.shopDomain}) has no orders to refund (orders_search: ${JSON.stringify(orders).slice(0, 300)}). Seed one: create a draft order for a real customer and complete it with paymentPending:false, then re-run.`,
    )

    const threadId = await scriptShopifyTurns(env, {
      token,
      turns: [
        {
          calls: [
            {
              name: "shopify__refunds_create",
              args: {
                orderId,
                note: "E2E gate check — never approved.",
                fullRefund: true,
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
    await sendInConversation(page, conversation, "Refund that order in full.")
    await waitForTurnEnd(env, { threadId, token, contains: ANSWER, timeout: 120_000 })

    // THE GATE HELD, on a money-moving tool: a real approval request.
    const calls = await turnToolCalls(env, {
      threadId,
      token,
      contains: ANSWER,
      expect: "shopify__refunds_create",
    })
    const gated = (calls.find((c) => c.toolName === "shopify__refunds_create")?.result ?? {}) as {
      blocked?: boolean
      approvalRequestId?: string
    }
    expect(
      gated.blocked === true && Boolean(gated.approvalRequestId),
      `refunds_create did not stage an approval: ${JSON.stringify(gated).slice(0, 600)}`,
    ).toBe(true)

    // The gated row correlates to that request, and the card the operator would
    // decide is on screen under it.
    const turnRow = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: ANSWER })
      .last()
    const gatedCall = turnRow.locator('[data-tool-name="shopify__refunds_create"]').first()
    await expect(gatedCall).toBeVisible({ timeout: 30_000 })
    await expect(gatedCall).toHaveAttribute("data-request-id", gated.approvalRequestId as string)
    await expect(turnRow.getByTestId("approval-card").first()).toBeVisible({ timeout: 30_000 })

    // Left PENDING on purpose: approving it would refund real money on the
    // shared dev store.
  })
})

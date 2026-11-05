// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e — agent driving Shopify READ tools.
//
// The operator resolves a customer (`shopify__customers_search`) and then pulls
// her orders (`shopify__orders_search`). Both calls are executed FOR REAL
// against the live dev store through the tool bridge — see
// `_agent-shopify-harness.ts` on why the canned SSE this used to replay proved
// nothing about Shopify, and why the two calls sit in two turns.
import { loginAsAdmin, openAgentConversation, sendInConversation } from "../agent-bootstrap"
import { turnToolCalls, waitForTurnEnd } from "../agent-turn"
import { seedModelPricingAndCredits } from "../helpers/agent-seed"
import { installShopifyForAgent, scriptShopifyTurns } from "./_agent-shopify-harness"
import { expect, requireShopifyCreds, test } from "./_shopify-fixtures"

const FOUND_CUSTOMER = "Found Marie Dupont in Shopify."
const FOUND_ORDERS = "Pulled Marie Dupont's recent orders from Shopify."

test.describe("Shopify: agent READ flows", () => {
  test("'show me Marie's recent orders' resolves contact + orders_search", async ({
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
    const threadId = await scriptShopifyTurns(env, {
      token,
      turns: [
        {
          calls: [{ name: "shopify__customers_search", args: { query: "Marie Dupont" } }],
          text: FOUND_CUSTOMER,
        },
        {
          calls: [
            {
              name: "shopify__orders_search",
              args: { query: "email:marie@example.com", limit: 5 },
            },
          ],
          text: FOUND_ORDERS,
        },
      ],
    })

    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)

    await sendInConversation(page, conversation, "Who is Marie Dupont in Shopify?")
    await waitForTurnEnd(env, { threadId, token, contains: FOUND_CUSTOMER, timeout: 120_000 })
    await sendInConversation(page, conversation, "Now show me her recent orders.")
    await waitForTurnEnd(env, { threadId, token, contains: FOUND_ORDERS, timeout: 120_000 })

    // Each tool rendered in ITS OWN turn's row. The DM is worker-scoped, so the
    // reads are anchored to those rows rather than to the conversation.
    const rowFor = (text: string) =>
      conversation.locator('[data-testid="message-row"]').filter({ hasText: text }).last()
    await expect(
      rowFor(FOUND_CUSTOMER).locator('[data-tool-name="shopify__customers_search"]').first(),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      rowFor(FOUND_ORDERS).locator('[data-tool-name="shopify__orders_search"]').first(),
    ).toBeVisible({ timeout: 30_000 })

    // THE DEV STORE ANSWERED, inside the turns: the real results the agent was
    // handed carry Marie. The payload shape varies by entity, so the assertion
    // is over the serialized result rather than a guessed field path.
    const customerCalls = await turnToolCalls(env, {
      threadId,
      token,
      contains: FOUND_CUSTOMER,
      expect: "shopify__customers_search",
    })
    const orderCalls = await turnToolCalls(env, {
      threadId,
      token,
      contains: FOUND_ORDERS,
      expect: "shopify__orders_search",
    })
    const customers = JSON.stringify(
      customerCalls.find((c) => c.toolName === "shopify__customers_search")?.result ?? null,
    )
    expect(customers, customers.slice(0, 600)).toContain("Marie")

    // The order search ANSWERED from the real Admin API — a well-formed search
    // payload, not an error envelope. Its CONTENT is deliberately not asserted:
    // the dev store is shared mutable state and which orders exist for a given
    // customer on a given day is not this scenario's claim. That the tool is
    // registered, permitted and reaching Shopify is.
    const orderResult = orderCalls.find((c) => c.toolName === "shopify__orders_search")?.result as {
      results?: unknown
      totalCount?: unknown
    } | null
    const orderJson = JSON.stringify(orderResult)
    expect(Array.isArray(orderResult?.results), orderJson.slice(0, 600)).toBe(true)
    expect(typeof orderResult?.totalCount, orderJson.slice(0, 600)).toBe("number")
    expect(orderJson).not.toContain('"error"')

    // Neither read is gated, so nothing waits on a human.
    await expect(conversation.getByTestId("approval-card")).toHaveCount(0)
  })
})

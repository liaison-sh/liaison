// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e — agent composing across SHOPIFY + KERNEL tools.
//
// "What did Marie buy and is there an open thread with her?" fans out across
// the Shopify plugin (`customers_search`, `orders_search`) and the kernel's own
// registries (`contacts_search`, `threads_search`). The point is the CROSS-
// BOUNDARY surface: plugin tools and kernel tools in one conversation, rendered
// side by side and executed by the same bridge.
//
// P4c-T21b: every "result" here used to be a literal the test wrote into a
// canned SSE stream, including ids that resolved to nothing. All four calls now
// run FOR REAL. The kernel pair share a turn (kernel tools declare `readOnly`
// and the taint guard honours it); the Shopify pair need one turn each — see
// `_agent-shopify-harness.ts`.
import { loginAsAdmin, openAgentConversation, sendInConversation } from "../agent-bootstrap"
import { turnToolCalls, waitForTurnEnd } from "../agent-turn"
import { seedModelPricingAndCredits } from "../helpers/agent-seed"
import { installShopifyForAgent, scriptShopifyTurns } from "./_agent-shopify-harness"
import { expect, requireShopifyCreds, test } from "./_shopify-fixtures"

const STORE_SIDE = "Shopify side: pulled Marie's customer record and orders."
const KERNEL_SIDE = "Kernel side: checked contacts and threads for Marie."

test.describe("Shopify: agent CROSS-APP composition", () => {
  test("'what did Marie buy + any open thread with her' fans out across Shopify + kernel", async ({
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
          calls: [{ name: "shopify__customers_search", args: { query: "Marie" } }],
          text: "Found Marie in Shopify.",
        },
        {
          calls: [
            {
              name: "shopify__orders_search",
              args: { query: "email:marie@example.com", limit: 5 },
            },
          ],
          text: STORE_SIDE,
        },
        {
          calls: [
            { name: "kernel__contacts_search", args: { query: "Marie" } },
            { name: "kernel__threads_search", args: { query: "Marie" } },
          ],
          text: KERNEL_SIDE,
        },
      ],
    })

    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const conversation = await openAgentConversation(page)

    await sendInConversation(page, conversation, "Who is Marie in Shopify?")
    await waitForTurnEnd(env, {
      threadId,
      token,
      contains: "Found Marie in Shopify.",
      timeout: 120_000,
    })
    await sendInConversation(page, conversation, "What did she buy this month?")
    await waitForTurnEnd(env, { threadId, token, contains: STORE_SIDE, timeout: 120_000 })
    await sendInConversation(page, conversation, "Is there an open thread with her?")
    await waitForTurnEnd(env, { threadId, token, contains: KERNEL_SIDE, timeout: 120_000 })

    const rowFor = (text: string) =>
      conversation.locator('[data-testid="message-row"]').filter({ hasText: text }).last()

    // Plugin-namespaced and kernel-namespaced tool rows render the same way,
    // each in the turn that made the call.
    await expect(
      rowFor(STORE_SIDE).locator('[data-tool-name="shopify__orders_search"]').first(),
    ).toBeVisible({ timeout: 30_000 })
    const kernelRow = rowFor(KERNEL_SIDE)
    for (const tool of ["kernel__contacts_search", "kernel__threads_search"]) {
      await expect(kernelRow.locator(`[data-tool-name="${tool}"]`).first()).toBeVisible({
        timeout: 30_000,
      })
    }

    // Both sides really answered: the plugin call reached the Admin API and the
    // kernel calls reached this org's own registries, in the same conversation.
    const storeCalls = await turnToolCalls(env, {
      threadId,
      token,
      contains: STORE_SIDE,
      expect: "shopify__orders_search",
    })
    const kernelCalls = await turnToolCalls(env, {
      threadId,
      token,
      contains: KERNEL_SIDE,
      expect: "kernel__threads_search",
    })
    const orders = storeCalls.find((c) => c.toolName === "shopify__orders_search")?.result as {
      results?: unknown
    } | null
    expect(Array.isArray(orders?.results), JSON.stringify(orders).slice(0, 400)).toBe(true)
    for (const tool of ["kernel__contacts_search", "kernel__threads_search"]) {
      const call = kernelCalls.find((c) => c.toolName === tool)
      expect(call?.status, `${tool}: ${JSON.stringify(call).slice(0, 400)}`).toBe("completed")
    }
  })
})

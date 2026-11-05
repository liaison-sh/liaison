// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 W6 — Self-hosted agent works with BYOK and existing credit balances
// (E2E plan 16-phase-14-e2e-plan.md; Success Criterion 10).
//
// The full LLM round-trip is exercised by the chat-dock suite (P4c-T21); W6
// focuses on the Phase 14 invariants — that the self-hosted billing extraction
// did not break the surfaces SC10 names: the agent conversation opens, credits
// + BYOK paths remain usable, and the managed-mode Plan tab + checkout
// controls stay hidden.
import type { WorkerEnv } from "@liaison/test-helpers"
import {
  BOOTSTRAP_ECB_RATE,
  MODEL_PRICING_SEED,
} from "../../../../../packages/shared/src/model-pricing-seed"
import { openAgentConversation } from "./agent-bootstrap"
import { expect, test } from "./fixtures/test"

async function seedModelPricing(env: WorkerEnv) {
  const ks = `${env.schemaPrefix}kernel`
  for (const m of MODEL_PRICING_SEED) {
    await env.db.sql.unsafe(
      `INSERT INTO "${ks}".model_pricing
         (id, provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (provider, model_id) DO NOTHING`,
      [
        m.provider,
        m.modelId,
        m.displayName,
        m.inputCostPerM,
        m.outputCostPerM,
        m.contextWindow,
        m.autoEligible,
        m.tierMinimum,
        m.source,
      ],
    )
  }
  await env.db.sql.unsafe(
    `INSERT INTO "${ks}".system_config (key, value)
     VALUES ('usd_eur_rate', '${JSON.stringify(BOOTSTRAP_ECB_RATE)}'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  )
}

async function seedCredits(
  env: WorkerEnv,
  orgId: string,
  opts: { included?: string; purchased?: string } = {},
) {
  const included = opts.included ?? "10.00000000"
  const purchased = opts.purchased ?? "0.00000000"
  const ks = `${env.schemaPrefix}kernel`
  await env.db.sql.unsafe(
    `INSERT INTO "${ks}".credit_balances (org_id, included_balance, purchased_balance, currency)
     VALUES ($1, $2, $3, 'EUR')
     ON CONFLICT (org_id) DO UPDATE SET
       included_balance = $2,
       purchased_balance = $3`,
    [orgId, included, purchased],
  )
}

test.describe("self-hosted agent surfaces remain intact", () => {
  test("the agent conversation opens, Usage monitoring + BYOK render, managed UX is absent", async ({
    authenticatedPage,
    env,
    world,
  }) => {
    await seedModelPricing(env)
    await seedCredits(env, world.org.id, { included: "10.00000000" })

    const page = authenticatedPage
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // The agent conversation is reached through `mod+.` since P4c-T17 retired
    // the panel. Its composer is the structural proof that the self-hosted
    // code path renders a usable input.
    const conversation = await openAgentConversation(page)
    await expect(conversation.getByTestId("compose-editor")).toBeVisible({ timeout: 15000 })

    // /settings: Plan tab must be absent in self-hosted mode.
    await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
    await expect(page.getByTestId("settings-content")).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole("link", { name: /^Plan$/ })).toHaveCount(0)

    // /settings/usage: self-hosted is a credit-free monitoring page — the
    // chart, computed-usage disclaimer, and Providers section render; there are
    // no balance cards and no buy/add-credits CTAs.
    await page.goto(`http://localhost:${env.ports[1]}/settings/usage`)
    await expect(page.getByTestId("usage-chart")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("computed-usage-disclaimer")).toBeVisible()
    await expect(page.getByTestId("providers-section")).toBeVisible()
    await expect(page.getByTestId("buy-credits-link")).toHaveCount(0)
    await expect(page.getByTestId("add-credits-link")).toHaveCount(0)
    await expect(page.getByTestId("usage-balance")).toHaveCount(0)

    // /settings/plan direct nav: fallback "plan-unavailable" target, no managed card.
    await page.goto(`http://localhost:${env.ports[1]}/settings/plan`)
    await expect(page.getByTestId("plan-unavailable")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("plan-card")).toHaveCount(0)
  })
})

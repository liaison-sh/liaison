// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import {
  BOOTSTRAP_ECB_RATE,
  MODEL_PRICING_SEED,
} from "../../../../../packages/shared/src/model-pricing-seed"
import { createProfiledE2ETest } from "./fixtures/profiled-test"
import { expect, loginAs, test } from "./fixtures/test"
import { seedBillingState } from "./helpers/billing-state-seed"
import { MANAGED_VITE_ENV, managedEditionAfterWorld } from "./helpers/managed-edition"

// ─────────────────────────────────────────────────────────────────────────────
// Settings > Usage, in both editions.
//
// Self-hosted (the default e2e server, no control plane): a credit-free
// monitoring page. AI use is shown as its real cost in currency (S19): the
// chart, the activity log and the spend per provider.
//
// Managed (a profiled server restarted as LIAISON_EDITION=managed): credits, never
// money (S18). Credits left, the period's use, the ledger in credits. Plans,
// card and top-ups live on Settings > Billing, not here.
// ─────────────────────────────────────────────────────────────────────────────

const ks = (env: WorkerEnv) => `${env.schemaPrefix}kernel`

/** Seed model pricing + ECB rate (the self-hosted chart costs rows with it). */
async function seedModelPricing(env: WorkerEnv) {
  for (const m of MODEL_PRICING_SEED) {
    await env.db.sql.unsafe(
      `INSERT INTO "${ks(env)}".model_pricing
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
    `INSERT INTO "${ks(env)}".system_config (key, value)
     VALUES ('usd_eur_rate', '${JSON.stringify(BOOTSTRAP_ECB_RATE)}'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  )
}

async function clearLedger(env: WorkerEnv, orgId: string) {
  await env.db.sql.unsafe(`DELETE FROM "${ks(env)}".credit_transactions WHERE org_id = $1`, [orgId])
}

async function clearProviderKeys(env: WorkerEnv, orgId: string) {
  await env.db.sql.unsafe(
    `UPDATE "${ks(env)}".organizations SET settings = settings - 'providerKeys' WHERE id = $1`,
    [orgId],
  )
}

/** Seed a BYOK key into org settings via direct SQL */
async function seedByokKey(env: WorkerEnv, orgId: string, provider: string, maskedHint: string) {
  const validatedAt = new Date().toISOString()
  await env.db.sql.unsafe(
    `UPDATE "${ks(env)}".organizations
     SET settings = jsonb_set(
       jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{providerKeys}',
         COALESCE(settings->'providerKeys', '{}'::jsonb),
         true
       ),
       '{providerKeys,${provider}}',
       '{"encrypted":"fake_encrypted_value_for_test","maskedHint":"${maskedHint}","validatedAt":"${validatedAt}"}'::jsonb,
       true
     )
     WHERE id = $1`,
    [orgId],
  )
}

/** Self-hosted BYOK usage: non-deducting `byok_usage` rows with their real cost. */
async function seedByokUsage(env: WorkerEnv, orgId: string, userId: string) {
  const rows = [
    { model: "claude-haiku-4-5", inp: 4000, out: 800, raw: "0.00800000", days: 1 },
    { model: "claude-sonnet-4-6", inp: 2000, out: 1500, raw: "0.02850000", days: 2 },
    { model: "claude-haiku-4-5", inp: 6000, out: 400, raw: "0.00800000", days: 4 },
    { model: "claude-sonnet-4-6", inp: 3000, out: 900, raw: "0.02250000", days: 6 },
    { model: "claude-haiku-4-5", inp: 1200, out: 300, raw: "0.00270000", days: 9 },
    { model: "claude-sonnet-4-6", inp: 5000, out: 2000, raw: "0.04500000", days: 13 },
  ]
  for (const [i, r] of rows.entries()) {
    const createdAt = new Date(Date.now() - r.days * 86400000 - i * 60000).toISOString()
    await env.db.sql.unsafe(
      `INSERT INTO "${ks(env)}".credit_transactions
         (id, org_id, user_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'byok_usage', $3, '0', $4, $5, $6, $7, $8)`,
      [orgId, userId, `-${r.raw}`, r.model, r.inp, r.out, r.raw, createdAt],
    )
  }
}

/** `n` self-hosted rows a minute apart (unique timestamps for the cursor). */
async function seedByokRows(env: WorkerEnv, orgId: string, userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(Date.now() - (n - i) * 60000).toISOString()
    await env.db.sql.unsafe(
      `INSERT INTO "${ks(env)}".credit_transactions
         (id, org_id, user_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'byok_usage', '-0.01000000', '0', 'claude-sonnet-4-6', 1000, 500, '0.01000000', $3)`,
      [orgId, userId, createdAt],
    )
  }
}

interface LedgerRow {
  type: "monthly_reset" | "top_up" | "usage"
  amount: string
  balanceAfter: string
  userId?: string | null
  model?: string | null
  minutesAgo: number
}

async function seedLedger(env: WorkerEnv, orgId: string, rows: LedgerRow[]) {
  const runId = randomUUID().slice(0, 8)
  for (const [i, r] of rows.entries()) {
    await env.db.sql.unsafe(
      `INSERT INTO "${ks(env)}".credit_transactions
         (id, org_id, user_id, type, amount, balance_after, model, description, external_payment_ref, cycle_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        orgId,
        r.userId ?? null,
        r.type,
        r.amount,
        r.balanceAfter,
        r.model ?? null,
        r.type === "top_up" ? "Top-up" : r.type === "monthly_reset" ? "Monthly reset" : null,
        r.type === "top_up" ? `pay_e2e_${runId}_${i}` : null,
        r.type === "monthly_reset" ? `cycle_e2e_${runId}_${i}` : null,
        new Date(Date.now() - r.minutesAgo * 60000).toISOString(),
      ],
    )
  }
}

async function setCreditBalance(
  env: WorkerEnv,
  orgId: string,
  included: string,
  purchased: string,
) {
  await env.db.sql.unsafe(
    `INSERT INTO "${ks(env)}".credit_balances (org_id, included_balance, purchased_balance, currency)
     VALUES ($1, $2, $3, 'EUR')
     ON CONFLICT (org_id) DO UPDATE SET included_balance = $2, purchased_balance = $3`,
    [orgId, included, purchased],
  )
}

/**
 * A managed period, consistent end to end: 500 included at the reset, a
 * 100-credit top-up, 150 credits of use (three rows). Available 600, used 150
 * (25%), 450 left (350 included + 100 purchased), period ends in 18 days.
 */
async function seedManagedPeriod(env: WorkerEnv, orgId: string, userId: string | null) {
  await clearLedger(env, orgId)
  await seedBillingState(env, orgId, {
    plan: "base",
    includedCredits: 500,
    periodEnd: new Date(Date.now() + 18 * 86400000 - 3600000),
  })
  await setCreditBalance(env, orgId, "350.00000000", "100.00000000")
  await seedLedger(env, orgId, [
    { type: "monthly_reset", amount: "500.00000000", balanceAfter: "500.00", minutesAgo: 60 },
    { type: "top_up", amount: "100.00000000", balanceAfter: "600.00", minutesAgo: 50 },
    {
      type: "usage",
      amount: "-50.00000000",
      balanceAfter: "550.00",
      userId,
      model: "claude-sonnet-4-6",
      minutesAgo: 40,
    },
    {
      type: "usage",
      amount: "-70.00000000",
      balanceAfter: "480.00",
      userId,
      model: "claude-sonnet-4-6",
      minutesAgo: 30,
    },
    {
      type: "usage",
      amount: "-30.00000000",
      balanceAfter: "450.00",
      userId,
      model: "claude-haiku-4-5",
      minutesAgo: 20,
    },
  ])
}

/** Settings > Usage through the sidebar. */
async function openUsage(page: Page) {
  await page.getByTestId("activity-settings").click()
  await page.waitForURL(/\/settings/, { timeout: 10000 })
  await page.getByTestId("settings-link-kernel:usage").click()
  await page.waitForURL(/\/settings\/usage/, { timeout: 10000 })
  await expect(page.getByTestId("usage-chart")).toBeVisible({ timeout: 15000 })
}

/** Settings > Usage on a managed cell: waits for the credit cards. */
async function openManagedUsage(page: Page) {
  await openUsage(page)
  await expect(page.getByTestId("usage-balance")).toBeVisible({ timeout: 15000 })
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
}

// ═════════════════════════════════════════════════════════════════════════════
// Self-hosted
// ═════════════════════════════════════════════════════════════════════════════

test.describe("Self-hosted usage: real cost in currency (S19)", () => {
  test("chart, activity log and provider spend in currency, no credits", async ({
    page,
    env,
    world,
    qa,
  }) => {
    await clearLedger(env, world.org.id)
    await clearProviderKeys(env, world.org.id)
    await seedModelPricing(env)
    await seedByokKey(env, world.org.id, "anthropic", "ant7k2")
    await seedByokUsage(env, world.org.id, qa.admin.id)

    await loginAs(page, env, "admin@test.com", "12345678")
    await openUsage(page)

    // No credits anywhere: no balance cards, no plan, no Billing link.
    await expect(page.getByTestId("usage-balance")).toHaveCount(0)
    await expect(page.getByTestId("plan-tier")).toHaveCount(0)
    await expect(page.getByTestId("settings-link-kernel:billing")).toHaveCount(0)

    // The chart is an estimate in currency.
    await expect(page.getByTestId("usage-chart-canvas")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("usage-chart-total")).toContainText("€")
    await expect(page.getByTestId("usage-chart-total")).not.toContainText("credits")
    await expect(page.getByTestId("computed-usage-disclaimer")).toBeVisible()

    // Activity log: one row per call, amounts in currency, no type column.
    const rows = page.getByTestId("transaction-row")
    await expect(rows).toHaveCount(6, { timeout: 10000 })
    await expect(rows.first().getByTestId("txn-amount")).toContainText("€")
    await expect(page.getByTestId("transaction-table").getByTestId("txn-type")).toHaveCount(0)
    await expect(page.getByTestId("filter-type")).toHaveCount(0)
    await expect(page.getByTestId("filter-user")).toBeVisible()
    await expect(page.getByTestId("filter-model")).toBeVisible()

    // Spend per provider, in currency.
    await expect(page.getByTestId("providers-section")).toBeVisible()
    await expect(page.getByTestId("provider-spend-anthropic")).toContainText("€")
    await expect(page.getByTestId("provider-spend-anthropic")).not.toHaveText("~€0.00")
    await expect(page.getByTestId("usage-manage-keys")).toBeVisible()
  })

  test("member without billing read has no Usage link and is redirected", async ({ page, env }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await page.getByTestId("activity-settings").click()
    await page.waitForURL(/\/settings/, { timeout: 10000 })
    await expect(page.getByTestId("settings-link-kernel:profile")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("settings-link-kernel:usage")).toHaveCount(0)

    await page.goto(`http://localhost:${env.ports[1]}/settings/usage`)
    await page.waitForURL((url) => url.pathname === "/settings", { timeout: 10000 })
    await expect(page.getByTestId("usage-chart")).toHaveCount(0)
  })

  test("sidebar link opens the Usage page", async ({ authenticatedPage }) => {
    await openUsage(authenticatedPage)
    await expect(authenticatedPage.getByTestId("usage-title")).toBeVisible()
  })

  test("activity log paginates by 20 and filters by model", async ({ page, env, world, qa }) => {
    await clearLedger(env, world.org.id)
    await seedByokRows(env, world.org.id, qa.admin.id, 25)

    await loginAs(page, env, "admin@test.com", "12345678")
    await openUsage(page)

    const rows = page.getByTestId("transaction-row")
    await expect(rows).toHaveCount(20, { timeout: 10000 })
    const loadMore = page.getByTestId("load-more-btn")
    await expect(loadMore).toBeVisible()
    await loadMore.click()
    await expect(rows).toHaveCount(25, { timeout: 5000 })
    await expect(loadMore).toHaveCount(0)

    // A model with no rows empties the log; clearing the filter restores it.
    await page.getByTestId("filter-model").selectOption("claude-haiku-4-5")
    await expect(page.getByTestId("transactions-empty")).toBeVisible({ timeout: 5000 })
    await page.getByTestId("filter-model").selectOption("claude-sonnet-4-6")
    await expect(rows).toHaveCount(20, { timeout: 5000 })
  })

  test("chart period toggle", async ({ page, env, world, qa }) => {
    await clearLedger(env, world.org.id)
    await seedModelPricing(env)
    await seedByokUsage(env, world.org.id, qa.admin.id)

    await loginAs(page, env, "admin@test.com", "12345678")
    await openUsage(page)

    const btn7 = page.getByTestId("chart-period-7d")
    const btn30 = page.getByTestId("chart-period-30d")
    const btn90 = page.getByTestId("chart-period-90d")
    await expect(btn30).toHaveAttribute("aria-pressed", "true")
    await btn7.click()
    await expect(btn7).toHaveAttribute("aria-pressed", "true")
    await expect(btn30).toHaveAttribute("aria-pressed", "false")
    await btn90.click()
    await expect(btn90).toHaveAttribute("aria-pressed", "true")
    await expect(btn7).toHaveAttribute("aria-pressed", "false")
    await expect(page.getByTestId("usage-chart-canvas")).toBeVisible({ timeout: 5000 })
  })

  test("empty ledger: empty chart and empty activity log", async ({ page, env, world }) => {
    await clearLedger(env, world.org.id)

    await loginAs(page, env, "admin@test.com", "12345678")
    await openUsage(page)

    await expect(page.getByTestId("usage-chart-empty")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("usage-chart-canvas")).toHaveCount(0)
    await expect(page.getByTestId("transactions-empty")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("transaction-table")).toHaveCount(0)
    await expect(page.getByTestId("load-more-btn")).toHaveCount(0)
  })

  test("visual: self-hosted monitoring page", async ({ page, env, world, qa }) => {
    await clearLedger(env, world.org.id)
    await clearProviderKeys(env, world.org.id)
    await seedModelPricing(env)
    await seedByokKey(env, world.org.id, "anthropic", "ant7k2")
    await seedByokUsage(env, world.org.id, qa.admin.id)

    await loginAs(page, env, "admin@test.com", "12345678")
    await openUsage(page)

    await expect(page.getByTestId("usage-balance")).toHaveCount(0)
    await expect(page.getByTestId("computed-usage-disclaimer")).toBeVisible()
    await expect(page.getByTestId("provider-spend-anthropic")).toBeVisible()
    await expect(page.getByTestId("transaction-table")).toBeVisible({ timeout: 15000 })
    await settle(page)

    await expect(page.getByTestId("settings-content")).toHaveScreenshot(
      "usage-page-self-hosted.png",
      { maxDiffPixelRatio: 0.05, mask: [page.getByTestId("usage-chart-canvas")] },
    )
  })
})

// ── Provider keys (Settings > AI models), self-hosted ───────────────────────

async function openAiModels(page: Page) {
  await page.getByTestId("activity-settings").click()
  await page.waitForURL(/\/settings/, { timeout: 10000 })
  await page.getByTestId("settings-link-kernel:ai-models").click()
  await page.waitForURL(/\/settings\/ai-models/, { timeout: 10000 })
  await expect(page.getByTestId("ai-models-providers")).toBeVisible({ timeout: 15000 })
}

const PROVIDER_IDS = ["anthropic", "openai", "google", "mistral", "openrouter"]

test.describe("Provider keys", () => {
  test("shows the provider cards, none with an org key", async ({ page, env, world }) => {
    await clearProviderKeys(env, world.org.id)
    await loginAs(page, env, "admin@test.com", "12345678")
    await openAiModels(page)

    // Providers section is always visible — no disclosure to expand.
    for (const provider of PROVIDER_IDS) {
      await expect(page.getByTestId(`provider-card-${provider}`)).toBeVisible()
    }

    // No org key anywhere. The e2e server carries a placeholder deployment key
    // for the four native providers (not OpenRouter), so those cards say so;
    // OpenRouter has no key at all, so its card sits with the locked providers
    // and asks for one. Every card still offers an org key.
    for (const provider of PROVIDER_IDS) {
      const card = page.getByTestId(`provider-card-${provider}`)
      await expect(card).toBeVisible()
      await expect(card).toHaveAttribute("data-key-set", "false")
      if (provider === "openrouter") {
        await expect(card).toHaveAttribute("data-locked", "true")
        await expect(page.getByTestId("provider-locked-openrouter")).toContainText(
          "OpenRouter: add an API key",
        )
      } else {
        await expect(card).toContainText("Deployment key")
      }
      await expect(page.getByTestId(`provider-configure-${provider}`)).toBeVisible()
      await expect(page.getByTestId(`provider-configure-${provider}`)).toHaveText("Configure")
    }
  })

  test("connected key shows its masked hint; remove asks first", async ({ page, env, world }) => {
    await clearProviderKeys(env, world.org.id)
    await seedByokKey(env, world.org.id, "anthropic", "abc123")

    await loginAs(page, env, "admin@test.com", "12345678")
    await openAiModels(page)

    const card = page.getByTestId("provider-card-anthropic")
    await expect(card).toContainText("Connected (abc123)")
    await expect(page.getByTestId("provider-card-openai")).toHaveAttribute("data-key-set", "false")

    await page.getByTestId("provider-remove-anthropic").click()
    await expect(page.getByTestId("provider-remove-confirm-anthropic")).toBeVisible()
    await page.getByTestId("provider-remove-cancel-anthropic").click()
    await expect(page.getByTestId("provider-remove-confirm-anthropic")).toHaveCount(0)
    await expect(card).toContainText("Connected (abc123)")

    await page.getByTestId("provider-remove-anthropic").click()
    await page.getByTestId("provider-remove-confirm-anthropic").click()
    await expect(card).toHaveAttribute("data-key-set", "false", { timeout: 5000 })
    await expect(card).toContainText("Deployment key")
    await expect(page.getByTestId("toast-success")).toContainText("API key removed", {
      timeout: 5000,
    })
  })

  test("configure opens one inline form at a time", async ({ page, env, world }) => {
    await clearProviderKeys(env, world.org.id)
    await loginAs(page, env, "admin@test.com", "12345678")
    await openAiModels(page)

    await page.getByTestId("provider-configure-openai").click()
    const input = page.getByTestId("provider-key-input-openai")
    await expect(input).toBeVisible()
    await expect(input).toHaveAttribute("type", "password")
    await expect(page.getByTestId("provider-key-save-openai")).toBeVisible()
    await page.getByTestId("provider-key-cancel-openai").click()
    await expect(input).toHaveCount(0)

    await page.getByTestId("provider-configure-google").click()
    await expect(page.getByTestId("provider-key-input-google")).toBeVisible()
    await page.getByTestId("provider-configure-mistral").click()
    await expect(page.getByTestId("provider-key-input-mistral")).toBeVisible()
    await expect(page.getByTestId("provider-key-input-google")).toHaveCount(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Managed
// ═════════════════════════════════════════════════════════════════════════════

// LIAISON_EDITION=managed makes the worker the managed edition; the control
// plane itself is unreachable, so the billing state comes from the seeded push.
const managed = createProfiledE2ETest({
  workerIdOffset: 260,
  portCount: 3,
  before: async () => ({
    env: {},
    teardowns: [],
    // Managed after the world exists (helpers/managed-edition.ts): the managed edition has no web bootstrap.
    viteEnv: MANAGED_VITE_ENV,
    envAfterWorld: managedEditionAfterWorld,
  }),
})

managed.describe.configure({ mode: "serial" })

managed.describe("Managed usage: credits, never money (S18)", () => {
  managed(
    "credits left, the period's use and the ledger in credits",
    async ({ authenticatedPage: page, env, world, qa }) => {
      await seedManagedPeriod(env, world.org.id, qa.admin.id)
      await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
      await openManagedUsage(page)

      await expect(page.getByTestId("credits-left")).toHaveText("450")
      await expect(page.getByTestId("credits-breakdown")).toContainText("350 included")
      await expect(page.getByTestId("credits-breakdown")).toContainText("100 purchased")
      await expect(page.getByTestId("credits-used-percent")).toContainText("25%")
      await expect(page.getByTestId("credits-period-used")).toHaveText(
        "150 of 600 credits used this period",
      )
      await expect(page.getByTestId("credits-resets-in")).toHaveText("Resets in 18 days")
      await expect(page.getByTestId("credits-used-bar")).toHaveAttribute("style", /width: 25%/)
      await expect(page.getByTestId("credits-running-low")).toHaveCount(0)
      await expect(page.getByTestId("credits-depleted")).toHaveCount(0)

      // No money on the page: the chart total and every ledger amount are credits.
      await expect(page.getByTestId("usage-chart-total")).toContainText("150 credits")
      await expect(page.getByTestId("usage-chart-canvas")).toBeVisible()
      await expect(page.getByTestId("computed-usage-disclaimer")).toHaveCount(0)
      await expect(page.getByTestId("settings-content")).not.toContainText("€")

      const table = page.getByTestId("transaction-table")
      await expect(page.getByTestId("transaction-row")).toHaveCount(5, { timeout: 10000 })
      const topUp = table.locator('[data-testid="transaction-row"][data-type="top_up"]')
      await expect(topUp.getByTestId("txn-type")).toHaveText("Top-up")
      await expect(topUp.getByTestId("txn-amount")).toHaveText("+100 credits")
      const reset = table.locator('[data-testid="transaction-row"][data-type="monthly_reset"]')
      await expect(reset.getByTestId("txn-type")).toHaveText("Reset")
      await expect(
        table.locator('[data-testid="transaction-row"][data-type="usage"]').first(),
      ).toContainText("-30 credits")
      await expect(page.getByTestId("txn-col-user")).toBeVisible()
      await expect(page.getByTestId("filter-type")).toBeVisible()

      // Spend per provider is a self-hosted view; payments live on Billing.
      await expect(page.getByTestId("providers-section")).toHaveCount(0)
      await expect(page.getByTestId("add-credits-link")).toHaveCount(0)
      await expect(page.getByTestId("buy-credits-link")).toHaveCount(0)
      await expect(page.getByTestId("settings-link-kernel:billing")).toBeVisible()
    },
  )

  managed("type filter narrows the ledger", async ({ authenticatedPage: page, env, world, qa }) => {
    await seedManagedPeriod(env, world.org.id, qa.admin.id)
    await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
    await openManagedUsage(page)

    const rows = page.getByTestId("transaction-row")
    await expect(rows).toHaveCount(5, { timeout: 10000 })
    await page.getByTestId("filter-type").selectOption("top_up")
    await expect(rows).toHaveCount(1, { timeout: 5000 })
    await expect(rows.first()).toHaveAttribute("data-type", "top_up")
    await page.getByTestId("filter-type").selectOption("usage")
    await expect(rows).toHaveCount(3, { timeout: 5000 })
    await page.getByTestId("filter-type").selectOption("")
    await expect(rows).toHaveCount(5, { timeout: 5000 })
  })

  managed(
    "running low past 80%, depleted at 100%",
    async ({ authenticatedPage: page, env, world, qa }) => {
      await clearLedger(env, world.org.id)
      await seedBillingState(env, world.org.id, {
        plan: "base",
        includedCredits: 100,
        periodEnd: new Date(Date.now() + 5 * 86400000 + 3600000),
      })
      await seedLedger(env, world.org.id, [
        { type: "monthly_reset", amount: "100.00000000", balanceAfter: "100.00", minutesAgo: 30 },
        {
          type: "usage",
          amount: "-90.00000000",
          balanceAfter: "10.00",
          userId: qa.admin.id,
          model: "claude-sonnet-4-6",
          minutesAgo: 20,
        },
      ])
      await setCreditBalance(env, world.org.id, "10.00000000", "0.00000000")
      await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
      await openManagedUsage(page)

      await expect(page.getByTestId("credits-used-percent")).toContainText("90%")
      await expect(page.getByTestId("credits-running-low")).toBeVisible()
      await expect(page.getByTestId("credits-depleted")).toHaveCount(0)

      await seedLedger(env, world.org.id, [
        {
          type: "usage",
          amount: "-10.00000000",
          balanceAfter: "0.00",
          userId: qa.admin.id,
          model: "claude-sonnet-4-6",
          minutesAgo: 10,
        },
      ])
      await setCreditBalance(env, world.org.id, "0.00000000", "0.00000000")
      await page.reload()
      await expect(page.getByTestId("usage-balance")).toBeVisible({ timeout: 15000 })
      await expect(page.getByTestId("credits-left")).toHaveText("0")
      await expect(page.getByTestId("credits-used-percent")).toContainText("100%")
      await expect(page.getByTestId("credits-depleted")).toBeVisible()
      await expect(page.getByTestId("credits-running-low")).toHaveCount(0)
    },
  )

  managed(
    "a top-up shows after reload, in every tab",
    async ({ authenticatedPage: page, env, world, qa }) => {
      await seedManagedPeriod(env, world.org.id, qa.admin.id)
      await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
      await openManagedUsage(page)
      await expect(page.getByTestId("credits-left")).toHaveText("450")

      const page2 = await page.context().newPage()
      await page2.goto(`http://localhost:${env.ports[1]}/settings/usage`)
      await expect(page2.getByTestId("credits-left")).toHaveText("450", { timeout: 15000 })

      // A processed top-up of 50 purchased credits.
      await setCreditBalance(env, world.org.id, "350.00000000", "150.00000000")
      await seedLedger(env, world.org.id, [
        { type: "top_up", amount: "50.00000000", balanceAfter: "500.00", minutesAgo: 1 },
      ])

      for (const p of [page2, page]) {
        await p.reload()
        await expect(p.getByTestId("credits-left")).toHaveText("500", { timeout: 15000 })
        await expect(p.getByTestId("credits-breakdown")).toContainText("150 purchased")
        await expect(p.getByTestId("credits-period-used")).toHaveText(
          "150 of 650 credits used this period",
        )
        await expect(
          p.locator('[data-testid="transaction-row"][data-type="top_up"]').first(),
        ).toContainText("+50 credits")
      }
      await page2.close()
    },
  )

  managed(
    "billing reader who is not an admin sees credits without admin controls",
    async ({ page, env, world }) => {
      const reader = await createUserWithScopes(
        env.serverUrl,
        env.db.sql,
        world.admin.token,
        world.org.id,
        {
          email: `usage-reader-${randomUUID().slice(0, 8)}@e2e.local`,
          password: "QaPass1!",
          name: "Usage Reader",
          scopes: ["kernel:billing:read", "kernel:threads:read", "kernel:threads:write"],
          schemaPrefix: env.schemaPrefix,
        },
      )
      await seedManagedPeriod(env, world.org.id, reader.id)

      await loginAs(page, env, reader.email, "QaPass1!")
      await openManagedUsage(page)

      await expect(page.getByTestId("credits-left")).toHaveText("450")
      // Their own use only; no user filter or column, no Billing link.
      await expect(page.getByTestId("transaction-row")).toHaveCount(3, { timeout: 10000 })
      await expect(page.getByTestId("filter-user")).toHaveCount(0)
      await expect(page.getByTestId("txn-col-user")).toHaveCount(0)
      await expect(page.getByTestId("filter-model")).toBeVisible()
      await expect(page.getByTestId("settings-link-kernel:billing")).toHaveCount(0)
    },
  )

  managed(
    "visual: managed usage page with a ledger",
    async ({ authenticatedPage: page, env, world, qa }) => {
      await seedManagedPeriod(env, world.org.id, qa.admin.id)
      await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
      await openManagedUsage(page)
      await expect(page.getByTestId("transaction-row")).toHaveCount(5, { timeout: 10000 })
      await settle(page)

      await expect(page.getByTestId("settings-content")).toHaveScreenshot(
        "usage-page-admin-loaded.png",
        {
          maxDiffPixelRatio: 0.05,
          mask: [
            page.getByTestId("usage-chart-canvas"),
            page.getByTestId("credits-resets-in"),
            page.getByTestId("txn-date"),
          ],
        },
      )
    },
  )

  managed(
    "visual: managed usage page with an empty ledger",
    async ({ authenticatedPage: page, env, world }) => {
      await clearLedger(env, world.org.id)
      await seedBillingState(env, world.org.id, {
        plan: "base",
        includedCredits: 500,
        periodEnd: new Date(Date.now() + 18 * 86400000 - 3600000),
      })
      await setCreditBalance(env, world.org.id, "500.00000000", "0.00000000")
      await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
      await openManagedUsage(page)
      await expect(page.getByTestId("transactions-empty")).toBeVisible({ timeout: 10000 })
      await settle(page)

      await expect(page.getByTestId("settings-content")).toHaveScreenshot(
        "usage-page-admin-empty.png",
        { maxDiffPixelRatio: 0.05, mask: [page.getByTestId("credits-resets-in")] },
      )
    },
  )
})

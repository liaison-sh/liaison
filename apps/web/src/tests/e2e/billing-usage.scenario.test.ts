// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import {
  BOOTSTRAP_ECB_RATE,
  MODEL_PRICING_SEED,
} from "../../../../../packages/shared/src/model-pricing-seed"
import { expect, loginAs, test } from "./fixtures/test"

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10: Usage Settings — Phase 4e E2E
// 15 functional scenarios (S1–S15) + 2 visual baselines (V1–V2)
// ─────────────────────────────────────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seed credit balance — idempotent */
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

/** Seed model pricing + ECB rate */
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

/** Set org tier */
async function setOrgTier(env: WorkerEnv, orgId: string, tier: string) {
  const ks = `${env.schemaPrefix}kernel`
  await env.db.sql.unsafe(`UPDATE "${ks}".organizations SET tier = $1 WHERE id = $2`, [tier, orgId])
}

/** Set org resetDate in settings */
async function setResetDate(env: WorkerEnv, orgId: string, daysFromNow: number) {
  const ks = `${env.schemaPrefix}kernel`
  const resetDate = new Date(Date.now() + daysFromNow * 86400000).toISOString()
  await env.db.sql.unsafe(
    `UPDATE "${ks}".organizations SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('resetDate', $1::text) WHERE id = $2`,
    [resetDate, orgId],
  )
}

/** Seed full usage data (credits + tier + reset) */
async function seedUsageData(
  env: WorkerEnv,
  orgId: string,
  opts?: {
    tier?: string
    included?: string
    purchased?: string
    resetDays?: number
  },
) {
  const tier = opts?.tier ?? "team"
  const included = opts?.included ?? "2.00000000"
  const purchased = opts?.purchased ?? "10.00000000"

  await setOrgTier(env, orgId, tier)
  await seedCredits(env, orgId, { included, purchased })
  if (opts?.resetDays !== undefined) {
    await setResetDate(env, orgId, opts.resetDays)
  }
}

/** Seed sample transactions */
async function seedTransactions(
  env: WorkerEnv,
  orgId: string,
  userId: string | null,
  count?: number,
) {
  const ks = `${env.schemaPrefix}kernel`
  const baseTxns = [
    {
      type: "top_up",
      amount: "10.00000000",
      balance_after: "10.00",
      description: "Top-up",
      external_pay: "pay_e2e_001",
    },
    {
      type: "monthly_reset",
      amount: "20.00000000",
      balance_after: "30.00",
      description: "Monthly reset",
      cycle: "cycle_e2e_001",
    },
    {
      type: "usage",
      amount: "-0.05000000",
      balance_after: "29.95",
      model: "claude-sonnet-4-6",
      input_tokens: 1000,
      output_tokens: 500,
    },
    {
      type: "usage",
      amount: "-0.12000000",
      balance_after: "29.83",
      model: "claude-sonnet-4-6",
      input_tokens: 2000,
      output_tokens: 1200,
    },
    {
      type: "usage",
      amount: "-0.03000000",
      balance_after: "29.80",
      model: "claude-haiku-4-5-20251001",
      input_tokens: 5000,
      output_tokens: 200,
    },
  ]

  // Random prefix for external refs to avoid unique constraint violations across tests
  const runId = Math.random().toString(36).slice(2, 8)
  const n = count ?? baseTxns.length
  for (let i = 0; i < n; i++) {
    const t = baseTxns[i % baseTxns.length]
    // Offset created_at so each has a unique timestamp for cursor pagination
    const createdAt = new Date(Date.now() - (n - i) * 60000).toISOString()
    await env.db.sql.unsafe(
      `INSERT INTO "${ks}".credit_transactions
         (id, org_id, user_id, type, amount, balance_after, model, input_tokens, output_tokens, description, external_payment_ref, cycle_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        orgId,
        t.type === "usage" ? userId : null,
        t.type,
        t.amount,
        t.balance_after,
        (t as any).model ?? null,
        (t as any).input_tokens ?? null,
        (t as any).output_tokens ?? null,
        (t as any).description ?? null,
        (t as any).external_pay ? `${(t as any).external_pay}_${runId}_${i}` : null,
        (t as any).cycle ? `${(t as any).cycle}_${runId}_${i}` : null,
        createdAt,
      ],
    )
  }
}

/** Seed a BYOK key into org settings via direct SQL */
async function seedByokKey(env: WorkerEnv, orgId: string, provider: string, maskedHint: string) {
  const ks = `${env.schemaPrefix}kernel`
  const validatedAt = new Date().toISOString()
  // Use a single UPDATE with literal JSON to avoid postgres.js parameter encoding issues
  await env.db.sql.unsafe(
    `UPDATE "${ks}".organizations
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

/** Seed self-hosted BYOK usage records — non-deducting `byok_usage` rows the
 * monitoring page reads for its chart, activity log, and per-provider spend. */
async function seedByokUsage(env: WorkerEnv, orgId: string, userId: string) {
  const ks = `${env.schemaPrefix}kernel`
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
      `INSERT INTO "${ks}".credit_transactions
         (id, org_id, user_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'byok_usage', $3, '0', $4, $5, $6, $7, $8)`,
      [orgId, userId, `-${r.raw}`, r.model, r.inp, r.out, r.raw, createdAt],
    )
  }
}

/** Stub `/api/billing/state` to `managed` mode so the plan-tier section and
 * managed-only UX render. Phase 14 D track hides the entire plan-management
 * surface in self_hosted mode (the e2e server default — no control plane
 * configured), so without this stub `getByTestId('plan-tier')` is correctly
 * never visible. Call this BEFORE navigateToUsage. */
async function stubManagedBillingState(page: Page): Promise<void> {
  await page.route("**/api/billing/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          mode: "managed",
          tier: "team",
          status: "active",
          billingPortalUrl: "https://billing.example/portal",
          checkoutUrl: "https://billing.example/checkout",
          includedCredits: "20.00",
          periodEnd: new Date(Date.now() + 18 * 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    })
  })
}

/** Navigate to Settings > Usage and wait for balance data to render */
async function navigateToUsage(page: Page) {
  await stubManagedBillingState(page)
  await page.getByTestId("activity-settings").click()
  await page.waitForURL(/\/settings/, { timeout: 10000 })
  await page.getByRole("link", { name: "Usage" }).click()
  await page.waitForURL(/\/settings\/usage/, { timeout: 10000 })
  // Wait for balance data to actually render (not just the heading)
  await expect(page.getByText("Included usage")).toBeVisible({ timeout: 15000 })
}

/** Navigate to Settings > Usage WITHOUT stubbing managed billing state — the
 * e2e server boots in self_hosted mode by default (no control plane), so this
 * exercises the credit-free monitoring page. */
async function navigateToUsageSelfHosted(page: Page) {
  await page.getByTestId("activity-settings").click()
  await page.waitForURL(/\/settings/, { timeout: 10000 })
  await page.getByRole("link", { name: "Usage" }).click()
  await page.waitForURL(/\/settings\/usage/, { timeout: 10000 })
  await expect(page.getByTestId("usage-chart")).toBeVisible({ timeout: 15000 })
}

/** Wait for fonts and settle (for visual tests) */
async function waitForFontsAndSettle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
}

// ── S1: Usage Page Loads with Balance, Chart, and Transaction History ─────────

test.describe("S1: Usage page loads with balance, chart, and transactions", () => {
  test("shows balance cards, chart, and transaction history", async ({ page, env, world, qa }) => {
    await seedModelPricing(env)
    // Phase 14 Amendment 2 set TIER_ALLOWANCE.team = "500" (was 20). Seed
    // `included: 50` so 90% of the 500-credit allowance is used.
    await seedUsageData(env, world.org.id, {
      tier: "team",
      included: "50.00000000",
      purchased: "10.00000000",
      resetDays: 18,
    })
    await seedTransactions(env, world.org.id, qa.admin.id, 5)

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    // Plan/Tier
    await expect(page.getByTestId("plan-tier")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("plan-tier")).toContainText("Team")
    await expect(page.getByTestId("plan-tier")).toContainText("included credits / month")

    // Balance cards — included card shows percentage used + allowance/month + reset
    await expect(page.getByTestId("balance-included")).toContainText("90%")
    await expect(page.getByTestId("balance-included")).toContainText("€500.00 / month")
    await expect(page.getByTestId("balance-included")).toContainText("Resets in")
    await expect(page.getByTestId("balance-purchased")).toContainText("€10.00")

    // Usage chart
    const chartSection = page.getByTestId("usage-chart")
    await expect(chartSection).toBeVisible()
    await expect(chartSection.getByTestId("chart-period-7d")).toBeVisible()
    await expect(chartSection.getByTestId("chart-period-30d")).toBeVisible()
    await expect(chartSection.getByTestId("chart-period-90d")).toBeVisible()

    // Transaction history — table visible with rows
    await expect(page.getByTestId("transaction-table")).toBeVisible({ timeout: 10000 })

    // Check for transaction type badges
    await expect(page.getByTestId("transaction-table").getByText("Top-up").first()).toBeVisible()
    await expect(page.getByTestId("transaction-table").getByText("Reset").first()).toBeVisible()
    await expect(page.getByTestId("transaction-table").getByText("Usage").first()).toBeVisible()

    // Admin elements — Phase 14 Track D replaced the in-app `add-usage-btn`
    // (the old embedded-billing form) with an outbound `add-credits-link` for
    // managed mode (this test stubs managed via navigateToUsage).
    await expect(page.getByTestId("add-credits-link")).toBeVisible()
    await expect(page.getByTestId("transaction-filters").locator("select").first()).toBeVisible()
    await expect(page.getByTestId("providers-section")).toBeVisible()
  })
})

// ── S2: Usage Page — Non-Admin View ──────────────────────────────────────────
//
// The Usage section is gated on `kernel:billing:read` (bootstrap.ts settings
// section, QA scenario 20-byok-keys): a member without it has no sidebar link
// and a direct /settings/usage lands on Profile. A billing reader who is not an
// org admin reaches the page and gets the member view: balance, chart and
// their own transactions, with no admin controls.

test.describe("S2: Usage page — non-admin view", () => {
  test("member without billing read has no Usage link and is redirected", async ({ page, env }) => {
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
    await page.getByTestId("activity-settings").click()
    await page.waitForURL(/\/settings/, { timeout: 10000 })
    await expect(page.getByTestId("settings-link-kernel:profile")).toBeVisible({ timeout: 10000 })
    // Kernel section ids are namespaced (`kernel:usage`); the bare id matched nothing.
    await expect(page.getByTestId("settings-link-kernel:usage")).toHaveCount(0)

    await page.goto(`http://localhost:${env.ports[1]}/settings/usage`)
    await page.waitForURL((url) => url.pathname === "/settings", { timeout: 10000 })
    await expect(page.getByTestId("usage-chart")).toHaveCount(0)
  })

  test("non-admin sees balance but not admin controls", async ({ page, env, world }) => {
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
    await seedModelPricing(env)
    await seedUsageData(env, world.org.id, {
      tier: "team",
      included: "2.00000000",
      purchased: "10.00000000",
    })
    await seedTransactions(env, world.org.id, reader.id, 5)

    await loginAs(page, env, reader.email, "QaPass1!")
    await navigateToUsage(page)

    // Balance visible
    await expect(page.getByTestId("balance-included")).toBeVisible()
    await expect(page.getByTestId("balance-purchased")).toBeVisible()

    // Admin controls NOT visible
    await expect(page.getByTestId("add-usage-btn")).not.toBeVisible()
    await expect(page.getByTestId("providers-section")).not.toBeVisible()

    // User filter NOT visible (admin-only) — check that first select is model filter, not user filter
    const filters = page.getByTestId("transaction-filters")
    await expect(filters).toBeVisible()
    // Model and type filters still visible
    await expect(filters.locator("select").first()).toBeVisible()

    // User column NOT visible in table header
    const table = page.getByTestId("transaction-table")
    await expect(table).toBeVisible({ timeout: 10000 })
    await expect(table.locator("th").filter({ hasText: "User" })).not.toBeVisible()

    // Chart still visible
    await expect(page.getByTestId("usage-chart")).toBeVisible()
  })
})

// ── S3: Add Usage — Amount Entry UI Flow ─────────────────────────────────────

// Phase 14 Track D removed the embedded payment-amount panel.
// Managed-mode top-ups now route to a hosted Checkout via `add-credits-link`;
// self-hosted shows `buy-credits-link` to liaison.app. The OLD `add-usage-btn`
// + `payment-amount-panel` UI no longer exists, so this test is obsolete.
test.describe
  .skip("S3: Add usage — amount entry UI flow (Phase 14 removed embedded payment panel)", () => {
    test("amount entry panel opens, validates min, and cancels cleanly", async ({
      page,
      env,
      world,
    }) => {
      await seedUsageData(env, world.org.id)
      await loginAs(page, env, "admin@test.com", "12345678")
      await navigateToUsage(page)

      // Idle state — Add usage button visible
      await expect(page.getByTestId("add-usage-btn")).toBeVisible()

      // Click Add usage
      await page.getByTestId("add-usage-btn").click()

      // Amount entry panel appears
      const panel = page.getByTestId("payment-amount-panel")
      await expect(panel).toBeVisible()

      // Default amount is 10
      const amountInput = page.getByTestId("topup-amount-input")
      await expect(amountInput).toHaveValue("10")

      // Min is 5
      await expect(amountInput).toHaveAttribute("min", "5")

      // Set below minimum
      await amountInput.fill("3")
      const continueBtn = page.getByTestId("continue-payment-btn")
      await expect(continueBtn).toBeDisabled()

      // Set valid amount
      await amountInput.fill("15")
      await expect(continueBtn).not.toBeDisabled()

      // Cancel (close button with aria-label="Close")
      await panel.getByRole("button", { name: "Close" }).click()

      // Back to idle
      await expect(page.getByTestId("add-usage-btn")).toBeVisible()
      await expect(panel).not.toBeVisible()
    })
  })

// ── S4: Payment Completion — Balance Refreshes After Credit Change ────────────

test.describe("S4: Balance updates after credit change", () => {
  test("balance card updates after DB change and page reload", async ({ page, env, world }) => {
    await seedUsageData(env, world.org.id, {
      tier: "team",
      included: "2.00000000",
      purchased: "10.00000000",
    })
    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    // Verify initial balance
    await expect(page.getByTestId("balance-purchased")).toContainText("€10.00")

    // Simulate a webhook-processed top-up: update the DB directly
    const ks = `${env.schemaPrefix}kernel`
    await env.db.sql.unsafe(
      `UPDATE "${ks}".credit_balances SET purchased_balance = '25.00000000' WHERE org_id = $1`,
      [world.org.id],
    )
    // Also insert the corresponding transaction
    await env.db.sql.unsafe(
      `INSERT INTO "${ks}".credit_transactions
         (id, org_id, type, amount, balance_after, description, external_payment_ref)
       VALUES (gen_random_uuid(), $1, 'top_up', '15.00000000', '27.00', 'Top-up (E2E)', 'pay_e2e_s4')`,
      [world.org.id],
    )

    // Reload the page to trigger a fresh balance fetch
    // (In production, the WS broadcast triggers a reactive refetch; here we reload to verify
    // that the server returns the correct updated balance.)
    await page.reload()
    await expect(page.getByText("Included usage")).toBeVisible({ timeout: 15000 })

    // Verify updated balance
    await expect(page.getByTestId("balance-purchased")).toContainText("€25.00", { timeout: 10000 })

    // Verify the new transaction appears
    await expect(page.getByTestId("transaction-table")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("transaction-table").getByText("Top-up").first()).toBeVisible()
  })
})

// ── S5: Transaction History — Pagination and Filtering ───────────────────────

test.describe("S5: Transaction history — pagination and filtering", () => {
  test("paginates and filters transactions", async ({ page, env, world, qa }) => {
    // Clear existing transactions to ensure deterministic counts
    const ks = `${env.schemaPrefix}kernel`
    await env.db.sql.unsafe(`DELETE FROM "${ks}".credit_transactions WHERE org_id = $1`, [
      world.org.id,
    ])

    await seedUsageData(env, world.org.id)
    // Seed 25 transactions for pagination test (default page size is 20)
    await seedTransactions(env, world.org.id, qa.admin.id, 25)

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    // Transaction table visible with rows
    const table = page.getByTestId("transaction-table")
    await expect(table).toBeVisible({ timeout: 10000 })

    // Load more button should be visible (>20 transactions)
    const loadMore = page.getByTestId("load-more-btn")
    await expect(loadMore).toBeVisible({ timeout: 5000 })

    // Count initial rows — should be 20
    const initialRows = await table.locator("tbody tr").count()
    expect(initialRows).toBe(20)

    // Click load more
    await loadMore.click()
    await expect(table.locator("tbody tr")).toHaveCount(25, { timeout: 5000 })

    // Should now have 25 rows
    const updatedRows = await table.locator("tbody tr").count()
    expect(updatedRows).toBe(25)

    // Load more should be gone now
    await expect(loadMore).not.toBeVisible()

    // Filter by type — Top-up
    const filters = page.getByTestId("transaction-filters")
    const typeFilter = filters.locator("select").last()
    await typeFilter.selectOption("top_up")
    await page.waitForTimeout(500)

    // Verify only top-up rows shown
    const filteredTable = page.getByTestId("transaction-table")
    await expect(filteredTable).toBeVisible({ timeout: 5000 })
    const topUpBadges = filteredTable.getByText("Top-up")
    expect(await topUpBadges.count()).toBeGreaterThan(0)

    // Clear type filter
    await typeFilter.selectOption("")
    await page.waitForTimeout(500)
  })
})

// ── S6: Usage Chart — Period Toggle ──────────────────────────────────────────

test.describe("S6: Usage chart — period toggle", () => {
  test("period buttons toggle and chart responds", async ({ page, env, world, qa }) => {
    await seedModelPricing(env)
    await seedUsageData(env, world.org.id)
    // Seed usage transactions across multiple days
    const ks = `${env.schemaPrefix}kernel`
    for (let i = 0; i < 10; i++) {
      const createdAt = new Date(Date.now() - i * 3 * 86400000).toISOString()
      await env.db.sql.unsafe(
        `INSERT INTO "${ks}".credit_transactions
           (id, org_id, user_id, type, amount, balance_after, model, input_tokens, output_tokens, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'usage', '-0.05000000', '9.50', 'claude-sonnet-4-6', 1000, 500, $3)`,
        [world.org.id, qa.admin.id, createdAt],
      )
    }

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    const chart = page.getByTestId("usage-chart")
    await expect(chart).toBeVisible()

    // 30d is default active
    const btn30 = page.getByTestId("chart-period-30d")
    await expect(btn30).toHaveClass(/bg-accent/)

    // Click 7d
    const btn7 = page.getByTestId("chart-period-7d")
    await btn7.click()
    await expect(btn7).toHaveClass(/bg-accent/)
    await expect(btn30).not.toHaveClass(/bg-accent/)

    // Click 90d
    const btn90 = page.getByTestId("chart-period-90d")
    await btn90.click()
    await expect(btn90).toHaveClass(/bg-accent/)
    await expect(btn7).not.toHaveClass(/bg-accent/)

    // Canvas should be present (chart rendered)
    await expect(chart.locator("canvas")).toBeVisible({ timeout: 5000 })
  })
})

// ── S7: BYOK Key Management — Configure and Display ─────────────────────────
// The provider keys live on Settings -> AI -> AI models (Usage keeps the spend
// per provider and links there), with the same card test ids and copy.

/** Navigate to Settings > AI models through the sidebar, as an admin would. */
async function navigateToAiModels(page: Page) {
  await page.getByTestId("activity-settings").click()
  await page.waitForURL(/\/settings/, { timeout: 10000 })
  await page.getByTestId("settings-link-kernel:ai-models").click()
  await page.waitForURL(/\/settings\/ai-models/, { timeout: 10000 })
  await expect(page.getByTestId("ai-models-providers")).toBeVisible({ timeout: 15000 })
}

test.describe("S7: Providers — initial unconnected state", () => {
  test("shows the provider cards, none with an org key", async ({ page, env, world }) => {
    await seedUsageData(env, world.org.id)
    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToAiModels(page)

    // Providers section is always visible — no disclosure to expand.
    for (const provider of ["anthropic", "openai", "google", "mistral", "openrouter"]) {
      await expect(page.getByTestId(`provider-card-${provider}`)).toBeVisible()
    }

    // No org key anywhere. The e2e server carries a placeholder deployment key
    // for the four native providers (not OpenRouter), so those cards say so;
    // OpenRouter has no key at all, so its card sits with the locked providers
    // and asks for one. Every card still offers an org key.
    for (const provider of ["anthropic", "openai", "google", "mistral", "openrouter"]) {
      const card = page.getByTestId(`provider-card-${provider}`)
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
})

// ── S8: BYOK Key Management — Pre-Seeded Key Display and Removal ─────────────

test.describe("S8: Providers — connected key display and removal", () => {
  test("shows connected key with masked hint, remove flow works", async ({
    page,
    env,
    world,
    qa,
  }) => {
    await seedUsageData(env, world.org.id)
    await seedByokKey(env, world.org.id, "anthropic", "abc123")

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToAiModels(page)

    // Anthropic shows "Connected (abc123)"
    const anthropicCard = page.getByTestId("provider-card-anthropic")
    await expect(anthropicCard).toContainText("Connected (abc123)")
    await expect(page.getByTestId("provider-remove-anthropic")).toBeVisible()

    // Others have no org key (only the deployment's placeholder)
    await expect(page.getByTestId("provider-card-openai")).toHaveAttribute("data-key-set", "false")
    await expect(page.getByTestId("provider-card-openai")).toContainText("Deployment key")

    // Click Remove
    await page.getByTestId("provider-remove-anthropic").click()

    // Inline confirmation
    await expect(anthropicCard).toContainText("Remove?")
    await expect(page.getByTestId("provider-remove-confirm-anthropic")).toBeVisible()
    await expect(page.getByTestId("provider-remove-cancel-anthropic")).toBeVisible()

    // Cancel dismisses confirmation
    await page.getByTestId("provider-remove-cancel-anthropic").click()
    await expect(anthropicCard).toContainText("Connected (abc123)")
    await expect(anthropicCard).not.toContainText("Remove?")
    await expect(page.getByTestId("provider-remove-confirm-anthropic")).toHaveCount(0)

    // Remove again, confirm this time
    await page.getByTestId("provider-remove-anthropic").click()
    await page.getByTestId("provider-remove-confirm-anthropic").click()

    // The org key is gone: the card falls back to the deployment key
    await expect(anthropicCard).toHaveAttribute("data-key-set", "false", { timeout: 5000 })
    await expect(anthropicCard).toContainText("Deployment key")

    // Toast notification
    await expect(page.getByTestId("toast-success")).toContainText("API key removed", {
      timeout: 5000,
    })
  })
})

// ── S9: BYOK Key Management — Configure Flow (UI Only) ──────────────────────

test.describe("S9: Providers — configure flow UI", () => {
  test("configure expands inline form and cancel collapses it", async ({ page, env, world }) => {
    await seedUsageData(env, world.org.id)
    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToAiModels(page)

    // Click Configure on OpenAI
    await page.getByTestId("provider-configure-openai").click()

    // Inline form visible: password input, Save, Cancel
    const passwordInput = page.getByTestId("provider-key-input-openai")
    await expect(passwordInput).toBeVisible()
    await expect(passwordInput).toHaveAttribute("type", "password")
    await expect(page.getByTestId("provider-key-save-openai")).toBeVisible()
    await expect(page.getByTestId("provider-key-cancel-openai")).toBeVisible()

    // Cancel collapses form
    await page.getByTestId("provider-key-cancel-openai").click()
    await expect(passwordInput).not.toBeVisible()
    await expect(page.getByTestId("provider-configure-openai")).toBeVisible()

    // Only one configure form at a time: open Google, then open Mistral
    await page.getByTestId("provider-configure-google").click()
    await expect(page.getByTestId("provider-key-input-google")).toBeVisible()

    // Open Mistral — Google form should close
    await page.getByTestId("provider-configure-mistral").click()
    await expect(page.getByTestId("provider-key-input-mistral")).toBeVisible()
    await expect(page.getByTestId("provider-key-input-google")).not.toBeVisible()
  })
})

// ── S10: Balance Card — Included Usage Progress Bar and Reset Countdown ──────

test.describe("S10: Balance card — progress bar and reset countdown", () => {
  test("shows correct balance ratio and reset days", async ({ page, env, world }) => {
    // Phase 14 Amendment 2: team-tier allowance is 500. Seed `included: 310`
    // so used = 500 − 310 = 190 → 190/500 = 38%.
    await seedUsageData(env, world.org.id, {
      tier: "team",
      included: "310.00000000",
      purchased: "5.00000000",
      resetDays: 18,
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    const card = page.getByTestId("balance-included")
    await expect(card).toContainText("38%")
    await expect(card).toContainText("€500.00 / month")
    await expect(card).toContainText("Resets in 18 days")

    // Progress bar exists — check the inner bar has non-zero width
    const progressBar = card.locator(".bg-accent")
    await expect(progressBar).toBeVisible()
  })
})

// ── S11: Balance Card — Depleted State ───────────────────────────────────────

test.describe("S11: Balance card — depleted state", () => {
  test("shows depleted label when balance is zero", async ({ page, env, world }) => {
    // Phase 14 Amendment 2: TIER_ALLOWANCE.starter = "0", so a depleted-state
    // assertion on starter degenerates to 0/0. Use team (allowance 500) with
    // included=0 to exercise the depleted path (100% used).
    await seedUsageData(env, world.org.id, {
      tier: "team",
      included: "0.00000000",
      purchased: "0.00000000",
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    const card = page.getByTestId("balance-included")
    await expect(card).toContainText("100%")
    await expect(card).toContainText("€500.00 / month")
    await expect(card).toContainText("Depleted")
  })
})

// ── S12: Settings Navigation — Usage Section Accessible ──────────────────────

test.describe("S12: Settings navigation — usage section accessible", () => {
  test("navigates to usage via settings sidebar", async ({ authenticatedPage }) => {
    const page = authenticatedPage

    await page.getByTestId("activity-settings").click()
    await page.waitForURL(/\/settings/, { timeout: 10000 })

    // Usage link visible in sidebar
    const usageLink = page.getByRole("link", { name: "Usage" })
    await expect(usageLink).toBeVisible()

    // Click and verify URL
    await usageLink.click()
    await page.waitForURL(/\/settings\/usage/, { timeout: 10000 })

    // Heading visible
    await expect(page.locator("h1").filter({ hasText: "Usage" })).toBeVisible({ timeout: 5000 })
  })
})

// ── S13: Transaction History — Empty State ───────────────────────────────────

test.describe("S13: Transaction history — empty state", () => {
  test("shows empty message when no transactions", async ({ page, env, world }) => {
    // Clear any leftover transactions from prior tests
    const ks = `${env.schemaPrefix}kernel`
    await env.db.sql.unsafe(`DELETE FROM "${ks}".credit_transactions WHERE org_id = $1`, [
      world.org.id,
    ])
    await seedUsageData(env, world.org.id)
    // No transactions seeded

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    // "No transactions yet." visible
    await expect(page.getByText("No transactions yet.")).toBeVisible({ timeout: 10000 })

    // No table rendered
    await expect(page.getByTestId("transaction-table")).not.toBeVisible()

    // No load more button
    await expect(page.getByTestId("load-more-btn")).not.toBeVisible()
  })
})

// ── S14: Usage Chart — Empty State ───────────────────────────────────────────

test.describe("S14: Usage chart — empty state", () => {
  test("shows empty state message when no usage data", async ({ page, env, world }) => {
    // Clear any leftover transactions from prior tests
    const ks = `${env.schemaPrefix}kernel`
    await env.db.sql.unsafe(`DELETE FROM "${ks}".credit_transactions WHERE org_id = $1`, [
      world.org.id,
    ])
    await seedUsageData(env, world.org.id)
    // No transactions — chart should show empty state

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    const chart = page.getByTestId("usage-chart")
    await expect(chart).toBeVisible()
    await expect(chart.getByText("No usage data for this period")).toBeVisible({ timeout: 5000 })

    // No canvas when no data
    await expect(chart.locator("canvas")).not.toBeVisible()
  })
})

// ── S15: Multi-Tab Balance Consistency ────────────────────────────────────────

test.describe("S15: Multi-tab balance consistency", () => {
  test("both tabs show the same balance data", async ({ page, env, world }) => {
    await seedUsageData(env, world.org.id, {
      tier: "team",
      included: "2.00000000",
      purchased: "10.00000000",
    })

    // Login in first page
    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)
    await expect(page.getByTestId("balance-purchased")).toContainText("€10.00")

    // Open second page in same context (shared auth cookies). The managed
    // billing stub is per-page, so page2 needs its own stub for the balance
    // cards to render.
    const page2 = await page.context().newPage()
    await stubManagedBillingState(page2)
    const vitePort = env.ports[1]
    await page2.goto(`http://localhost:${vitePort}/settings/usage`)
    await page2.waitForSelector("[data-shell]", { timeout: 30000 })
    await expect(page2.getByText("Included usage")).toBeVisible({ timeout: 15000 })
    await expect(page2.getByTestId("balance-purchased")).toContainText("€10.00", { timeout: 10000 })

    // Update balance in DB (simulating a webhook-processed top-up)
    const ks = `${env.schemaPrefix}kernel`
    await env.db.sql.unsafe(
      `UPDATE "${ks}".credit_balances SET purchased_balance = '25.00000000' WHERE org_id = $1`,
      [world.org.id],
    )

    // Reload page2 — it should pick up the new balance
    await page2.reload()
    await expect(page2.getByText("Included usage")).toBeVisible({ timeout: 15000 })
    await expect(page2.getByTestId("balance-purchased")).toContainText("€25.00", { timeout: 10000 })

    // Reload page1 — it should also show the updated balance
    await page.reload()
    await expect(page.getByText("Included usage")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("balance-purchased")).toContainText("€25.00", { timeout: 10000 })

    await page2.close()
  })
})

// ── V1: Visual Baseline — Usage Page (Admin, Loaded State) ───────────────────

test.describe("Visual: Usage page admin loaded", () => {
  test("visual: admin loaded state", async ({ page, env, world, qa }) => {
    await seedModelPricing(env)
    await seedUsageData(env, world.org.id, {
      tier: "team",
      included: "2.00000000",
      purchased: "10.00000000",
      resetDays: 18,
    })
    await seedTransactions(env, world.org.id, qa.admin.id, 5)

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    // Wait for all content
    await expect(page.getByTestId("balance-included")).toBeVisible()
    await expect(page.getByTestId("transaction-table")).toBeVisible({ timeout: 10000 })
    await waitForFontsAndSettle(page)

    const content = page.getByTestId("settings-content")
    await expect(content).toHaveScreenshot("usage-page-admin-loaded.png", {
      maxDiffPixelRatio: 0.05,
      mask: [
        page.locator("canvas"),
        page.locator("text=/resets in \\d+d/"),
        page.getByTestId("transaction-table").locator("td:first-child"),
      ],
    })
  })
})

// ── V2: Visual Baseline — Usage Page (Empty State) ───────────────────────────

test.describe("Visual: Usage page admin empty", () => {
  test("visual: admin empty state", async ({ page, env, world }) => {
    // Clear transactions and BYOK state for clean empty visual
    const ks = `${env.schemaPrefix}kernel`
    await env.db.sql.unsafe(`DELETE FROM "${ks}".credit_transactions WHERE org_id = $1`, [
      world.org.id,
    ])
    await env.db.sql.unsafe(
      `UPDATE "${ks}".organizations SET settings = settings - 'providerKeys' WHERE id = $1`,
      [world.org.id],
    )
    await seedUsageData(env, world.org.id, {
      tier: "team",
      included: "2.00000000",
      purchased: "10.00000000",
      resetDays: 18,
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await navigateToUsage(page)

    // Wait for page render
    await expect(page.getByTestId("balance-included")).toBeVisible()
    await expect(page.getByText("No transactions yet.")).toBeVisible({ timeout: 10000 })
    await waitForFontsAndSettle(page)

    const content = page.getByTestId("settings-content")
    await expect(content).toHaveScreenshot("usage-page-admin-empty.png", {
      maxDiffPixelRatio: 0.05,
      mask: [page.locator("text=/resets in \\d+d/")],
    })
  })
})

// ── V3: Visual Baseline — Usage Page (Self-Hosted, Credit-Free Monitoring) ────

test.describe("Visual: Usage page self-hosted", () => {
  test("visual: self-hosted credit-free monitoring page", async ({ page, env, world, qa }) => {
    const ks = `${env.schemaPrefix}kernel`
    // Start clean, then seed a realistic populated self-hosted state: a
    // connected BYOK provider + metered usage records — so the snapshot shows
    // the monitoring page doing its job (chart, activity log, per-provider
    // computed spend), not an empty shell.
    await env.db.sql.unsafe(`DELETE FROM "${ks}".credit_transactions WHERE org_id = $1`, [
      world.org.id,
    ])
    await env.db.sql.unsafe(
      `UPDATE "${ks}".organizations SET settings = settings - 'providerKeys' WHERE id = $1`,
      [world.org.id],
    )
    await seedModelPricing(env)
    await seedByokKey(env, world.org.id, "anthropic", "ant7k2")
    await seedByokUsage(env, world.org.id, qa.admin.id)

    await loginAs(page, env, "admin@test.com", "12345678")
    // Self-hosted mode is the e2e server default — no managed-state stub.
    await navigateToUsageSelfHosted(page)

    // Credit surfaces absent; populated monitoring surfaces present.
    await expect(page.getByTestId("usage-balance")).toHaveCount(0)
    await expect(page.getByTestId("plan-tier")).toHaveCount(0)
    await expect(page.getByTestId("computed-usage-disclaimer")).toBeVisible()
    await expect(page.getByTestId("providers-section")).toBeVisible()
    // Connected Anthropic provider renders its computed spend; activity log has rows.
    await expect(page.getByTestId("provider-spend-anthropic")).toBeVisible()
    await expect(page.getByTestId("transaction-table")).toBeVisible({ timeout: 15000 })
    await waitForFontsAndSettle(page)

    const content = page.getByTestId("settings-content")
    await expect(content).toHaveScreenshot("usage-page-self-hosted.png", {
      maxDiffPixelRatio: 0.05,
      mask: [page.locator("canvas")],
    })
  })
})

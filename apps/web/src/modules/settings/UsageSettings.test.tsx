// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import UsageSettings from "~/modules/settings/UsageSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { mockApiClient } from "~/tests/helpers/mock-api"

function makeAdminJwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Admin",
      roles: ["admin"],
      scopes: ["kernel:org:admin"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function renderUsage() {
  render(() => (
    <I18nProvider initialLocale="en">
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <UsageSettings />
            </ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

const BALANCE_DATA = {
  included: "10",
  purchased: "5",
  currency: "USD",
  tier: "team",
  includedAllowance: "500",
  resetDate: "2026-06-19",
}

/** The managed edition's balance (S18): credits and the period's use, no currency. */
const MANAGED_BALANCE = {
  mode: "managed",
  credits: { included: "85.00000000", purchased: "25.00000000", total: "110.00000000" },
  period: {
    start: "2026-04-01T00:00:00.000Z",
    end: "2026-06-19T00:00:00.000Z",
    availableThisPeriod: "125.00000000",
    usedThisPeriod: "15.00000000",
    usedPercent: 12,
  },
}

const MANAGED_STATE = {
  mode: "managed",
  plan: "base",
  tier: "team",
  status: "active",
  periodEnd: "2026-06-19T00:00:00.000Z",
  includedCredits: "100",
  previewEndsAt: null,
  autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
}

/** Money in any currency (S18 discriminator on the rendered screen). */
const MONEY_TEXT = /€|EUR|USD|\$|currency/

describe("UsageSettings — edition-conditional UX", () => {
  beforeEach(() => {
    setTokens(makeAdminJwt(), "refresh")
  })
  afterEach(() => {
    cleanup()
    clearAuth()
  })

  it("self_hosted: hides all credit surfaces, shows the computed-usage disclaimer", async () => {
    mockApiClient({
      "/billing/state": {
        mode: "self_hosted",
        byokEnabled: true,
      },
      "/credits/balance": BALANCE_DATA,
      "/credits/usage?period=daily&from=": { buckets: [], totalCost: "0" },
      "/credits/transactions?limit=20": { items: [], cursor: null, hasMore: false },
      "/admin/users": [],
      "/settings/ai/keys": [],
    })
    renderUsage()

    // Chart is always present — wait on it, then assert the credit surfaces are gone.
    await screen.findByTestId("usage-chart")
    expect(screen.queryByTestId("usage-balance")).toBeNull()
    expect(screen.queryByTestId("balance-included")).toBeNull()
    expect(screen.queryByTestId("balance-purchased")).toBeNull()
    expect(screen.queryByTestId("buy-credits-link")).toBeNull()
    expect(screen.queryByTestId("add-credits-link")).toBeNull()
    // plan-tier is already managed-gated, so it is absent in self-hosted —
    // regression guard, not part of the red.
    expect(screen.queryByTestId("plan-tier")).toBeNull()

    // The computed-usage disclaimer is shown.
    expect(screen.getByTestId("computed-usage-disclaimer")).toBeInTheDocument()
  })

  it("managed: still shows the balance cards", async () => {
    mockApiClient({
      "/billing/state": {
        mode: "managed",
        plan: "base",
        tier: "team",
        status: "active",
        periodEnd: "2026-06-19T00:00:00.000Z",
        includedCredits: "500",
        previewEndsAt: null,
        autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
      },
      "/credits/balance": MANAGED_BALANCE,
      "/credits/usage?period=daily&from=": { buckets: [], totalCost: "0" },
      "/credits/transactions?limit=20": { items: [], cursor: null, hasMore: false },
      "/admin/users": [],
      "/settings/ai/keys": [],
    })
    renderUsage()
    expect(await screen.findByTestId("usage-balance")).toBeInTheDocument()
    expect(screen.getByTestId("balance-included")).toBeInTheDocument()
  })

  it("managed: links to no payment page and shows no payment form", async () => {
    mockApiClient({
      "/billing/state": {
        mode: "managed",
        plan: "base",
        tier: "team",
        status: "active",
        periodEnd: "2026-06-19T00:00:00.000Z",
        includedCredits: "500",
        previewEndsAt: null,
        autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
      },
      "/credits/balance": MANAGED_BALANCE,
      "/credits/usage?period=daily&from=": { buckets: [], totalCost: "0" },
      "/credits/transactions?limit=20": { items: [], cursor: null, hasMore: false },
      "/admin/users": [],
      "/settings/ai/keys": [],
    })
    renderUsage()
    expect(await screen.findByTestId("usage-balance")).toBeInTheDocument()
    expect(screen.queryByTestId("add-credits-link")).toBeNull()
    expect(screen.queryByTestId("payment-amount-panel")).toBeNull()
  })

  it("self_hosted: Providers section is always visible with per-provider computed spend", async () => {
    mockApiClient({
      "/billing/state": {
        mode: "self_hosted",
        byokEnabled: true,
      },
      "/credits/balance": BALANCE_DATA,
      "/credits/usage?period=daily&from=": {
        buckets: [
          {
            date: "2026-05-10",
            total: "0.50000000",
            models: { "claude-haiku-4-5": "0.50000000" },
          },
        ],
        totalCost: "0.50000000",
      },
      "/credits/transactions?limit=20": { items: [], cursor: null, hasMore: false },
      "/admin/users": [],
      "/settings/ai/keys": [
        { provider: "anthropic", maskedHint: "abc123", validatedAt: "2026-05-01T00:00:00Z" },
      ],
    })
    renderUsage()

    // Providers section visible WITHOUT expanding a disclosure.
    const section = await screen.findByTestId("providers-section")
    expect(section).toBeInTheDocument()

    // Every provider row carries its computed spend for the period.
    expect(await screen.findByTestId("provider-spend-anthropic")).toBeInTheDocument()
    expect(screen.getByTestId("provider-spend-openai")).toBeInTheDocument()
    expect(screen.getByTestId("provider-spend-openrouter")).toBeInTheDocument()

    // S9: the keys moved to Settings -> AI models. Usage keeps the spend and
    // points there; it has no key form of its own any more.
    expect(screen.getByTestId("usage-manage-keys").getAttribute("href")).toBe("/settings/ai-models")
    expect(section.querySelector('input[type="password"]')).toBeNull()
  })

  it("attributes a dated/variant model ID to its provider via prefix match", async () => {
    mockApiClient({
      "/billing/state": { mode: "self_hosted", byokEnabled: true },
      "/credits/balance": BALANCE_DATA,
      "/credits/usage?period=daily&from=": {
        buckets: [
          {
            date: "2026-05-10",
            total: "0.40000000",
            models: { "claude-haiku-4-5-20251001": "0.40000000" },
          },
        ],
        totalCost: "0.40000000",
      },
      "/credits/transactions?limit=20": { items: [], cursor: null, hasMore: false },
      "/admin/users": [],
      "/settings/ai/keys": [
        { provider: "anthropic", maskedHint: "abc123", validatedAt: "2026-05-01T00:00:00Z" },
      ],
    })
    renderUsage()
    await screen.findByTestId("provider-card-anthropic")
    const spend = await screen.findByTestId("provider-spend-anthropic")
    await waitFor(() => expect(spend.textContent).not.toMatch(/0\.00/))
    // Spend prefix-matched onto anthropic, not dropped to zero.
    expect(spend.textContent).not.toMatch(/0\.00/)
  })

  it("managed unavailable: renders stale-state banner with retry", async () => {
    mockApiClient({
      "/billing/state": { mode: "managed", billingUnavailable: true, stale: true },
      "/credits/balance": BALANCE_DATA,
      "/credits/usage?period=daily&from=": { buckets: [], totalCost: "0" },
      "/credits/transactions?limit=20": { items: [], cursor: null, hasMore: false },
      "/admin/users": [],
      "/settings/ai/keys": [],
    })
    renderUsage()
    await waitFor(() => expect(screen.getByTestId("billing-state-unavailable")).toBeInTheDocument())
    expect(screen.getByTestId("billing-state-retry")).toBeInTheDocument()
  })

  it("managed: credits left and the period's use as a percentage, never money (S18)", async () => {
    mockApiClient({
      "/billing/state": MANAGED_STATE,
      "/credits/balance": MANAGED_BALANCE,
      "/credits/usage?period=daily&from=": {
        mode: "managed",
        buckets: [
          { date: "2026-05-10", total: "15.00000000", models: { "claude-haiku-4-5": "15" } },
        ],
        totalCredits: "15.00000000",
      },
      "/credits/transactions?limit=20": {
        items: [
          {
            id: "t1",
            type: "usage",
            amount: "-10.00000000",
            model: "claude-haiku-4-5",
            userId: "u1",
            userName: "Admin",
            description: null,
            createdAt: "2026-05-10T10:00:00.000Z",
          },
          {
            id: "t2",
            type: "top_up",
            amount: "20.00000000",
            model: null,
            userId: null,
            userName: null,
            description: null,
            createdAt: "2026-05-09T10:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      },
      "/admin/users": [],
      "/settings/ai/keys": [],
    })
    renderUsage()
    const card = await screen.findByTestId("usage-balance")
    expect(screen.getByTestId("credits-left").textContent).toContain("110")
    expect(screen.getByTestId("credits-used-percent").textContent).toContain("12")
    expect(card.textContent).toContain("85")
    expect(card.textContent).toContain("25")
    const table = await screen.findByTestId("transaction-table")
    await waitFor(() => expect(table.textContent).toContain("10"))
    expect(table.textContent).toContain("+20")
    await waitFor(() => expect(screen.getByTestId("usage-chart").textContent).toContain("15"))
    // No money anywhere on the managed Usage screen, and no BYOK provider spend.
    expect(document.body.textContent ?? "").not.toMatch(MONEY_TEXT)
    expect(screen.queryByTestId("providers-section")).toBeNull()
  })

  it("self_hosted: the money values read exactly as before (S19)", async () => {
    mockApiClient({
      "/billing/state": { mode: "self_hosted", byokEnabled: true },
      "/credits/balance": BALANCE_DATA,
      "/credits/usage?period=daily&from=": {
        buckets: [
          {
            date: "2026-05-10",
            total: "0.41200000",
            models: { "claude-haiku-4-5": "0.41200000" },
          },
        ],
        totalCost: "0.41200000",
      },
      "/credits/transactions?limit=20": {
        items: [
          {
            id: "t1",
            type: "byok_usage",
            amount: "-0.40000000",
            model: "claude-haiku-4-5",
            inputTokens: 90000,
            outputTokens: 4000,
            userId: "u1",
            userName: "Admin",
            description: null,
            createdAt: "2026-05-10T10:00:00.000Z",
          },
          {
            id: "t2",
            type: "byok_usage",
            amount: "-0.00300000",
            model: "voice-transcribe",
            inputTokens: 0,
            outputTokens: 0,
            userId: "u1",
            userName: "Admin",
            description: null,
            createdAt: "2026-05-10T09:00:00.000Z",
          },
        ],
        cursor: null,
        hasMore: false,
      },
      "/admin/users": [],
      "/settings/ai/keys": [],
    })
    renderUsage()
    const table = await screen.findByTestId("transaction-table")
    const amounts = [...table.querySelectorAll("tbody tr td:last-child")].map(
      (td) => td.textContent,
    )
    expect(amounts).toEqual(["€0.40", "<€0.01"])
    await waitFor(() =>
      expect(screen.getByTestId("provider-spend-anthropic").textContent).toBe("~€0.41"),
    )
    expect(screen.getByTestId("usage-chart").textContent).toContain("Total: €0.41")
  })
})

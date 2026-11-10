// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared Playwright pieces for the Stripe page scenarios: the frozen bundle, the install through the
// test-only route (the API mock answers Stripe), and a host shim that answers the page's read tools.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { bundledAppTarball } from "../bundled-app-tarball"

// __dirname = liaison/apps/web/src/tests/e2e/stripe, six levels up is liaison/.
export const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
export const STRIPE_BUNDLE = bundledAppTarball(LIAISON_ROOT, "stripe")

export function assertStripeBundle(): void {
  if (!existsSync(STRIPE_BUNDLE)) {
    throw new Error(
      `Stripe bundle missing at ${STRIPE_BUNDLE}, run \`bash scripts/build-bundled-app.sh stripe --skip-sign\``,
    )
  }
}

export async function installStripeApp(opts: {
  serverUrl: string
  token: string
  orgId: string
}): Promise<void> {
  const res = await api(opts.serverUrl, "/api/_test/stripe/install-for-test", {
    method: "POST",
    token: opts.token,
    body: { orgId: opts.orgId, bundlePath: STRIPE_BUNDLE },
  })
  if (res.status !== 200) throw new Error(`stripe install failed: ${JSON.stringify(res.body)}`)
}

const IN = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

/** What the Stripe tools answer for a healthy, busy account (fictional customers). */
export function homeMocks(): Record<string, unknown> {
  const sub = (id: string, over: Record<string, unknown>) => ({
    id,
    customerId: `cus_${id}`,
    status: "past_due",
    plan: "Team",
    mrrMinor: 49000,
    currency: "eur",
    trialEnd: null,
    pastDueSince: IN(-6),
    card: { brand: "visa", last4: "4242", exp: "01/27" },
    ...over,
  })
  return {
    "stripe:home_load": {
      connection: {
        state: "connected",
        base: "connected",
        overlay: null,
        mode: "live",
        lastEventAt: IN(0),
        lastEventType: "invoice.paid",
        connectedAt: IN(-9),
      },
      sync: { importing: false, partial: false, missing: [], resources: [] },
      counts: {
        customers: 214,
        subscriptions: 178,
        invoices: 900,
        payments: 900,
        refunds: 2,
        disputes: 1,
      },
      attention: null,
      summary: "",
    },
    "stripe:subscriptions_search": {
      items: [
        sub("sub_a", { pastDueSince: IN(-6) }),
        sub("sub_b", {
          pastDueSince: IN(-3),
          plan: "A rather long plan name that has to wrap on a phone screen",
        }),
        sub("sub_c", { status: "trialing", pastDueSince: null, trialEnd: IN(3), card: null }),
        sub("sub_d", { status: "trialing", pastDueSince: null, trialEnd: IN(6) }),
      ],
    },
    "stripe:invoices_search": {
      items: [
        {
          id: "in_a",
          customerId: "cus_sub_a",
          subscriptionId: "sub_a",
          status: "open",
          amountDueMinor: 174000,
          currency: "eur",
          nextPaymentAttempt: null,
        },
      ],
    },
    "stripe:disputes_list": {
      items: [
        {
          id: "dp_1",
          paymentId: "ch_1",
          amountMinor: 58800,
          currency: "eur",
          reason: "unrecognized",
          status: "needs_response",
          evidenceDueBy: IN(10),
        },
      ],
    },
    "stripe:customers_get": { customer: { name: "Maison Arlon Longname Hospitality Group" } },
    "stripe:mrr_query": {
      partial: false,
      asOf: IN(0),
      rules: [],
      lines: [
        {
          currency: "eur",
          mrrMinor: 8470800,
          pastDueMinor: 336700,
          activeCount: 169,
          byPlan: [{ plan: "Team", mrrMinor: 5000000, count: 83 }],
          movements: {
            newMinor: 294000,
            upgradeMinor: 96000,
            downgradeMinor: -34100,
            cancelledMinor: -127800,
            netMinor: 228100,
            startMinor: 8242700,
          },
          monthStart: "2026-11-01",
        },
        {
          currency: "usd",
          mrrMinor: 12000,
          pastDueMinor: 0,
          activeCount: 1,
          byPlan: [{ plan: "Team", mrrMinor: 12000, count: 1 }],
          movements: {
            newMinor: 0,
            upgradeMinor: 0,
            downgradeMinor: 0,
            cancelledMinor: 0,
            netMinor: 0,
            startMinor: 12000,
          },
          monthStart: "2026-11-01",
        },
      ],
    },
  }
}

/** Answer the page's tool calls from `mocks` and pass every other tool through. */
export async function installToolMocks(page: Page, mocks: Record<string, unknown>): Promise<void> {
  await page.addInitScript((m: Record<string, unknown>) => {
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    let real: any
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    Object.defineProperty(window as any, "__liaisonHost", {
      configurable: true,
      get() {
        return real
      },
      set(h: unknown) {
        const original = h as Record<string, unknown>
        real = {
          ...original,
          invokeTool: async (appName: string, toolName: string, args: Record<string, unknown>) => {
            const key = `${appName}:${toolName}`
            if (Object.hasOwn(m, key)) return m[key]
            const orig = original.invokeTool as
              | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
              | undefined
            if (orig) return orig.call(original, appName, toolName, args)
            throw new Error(`unmocked tool: ${key}`)
          },
        }
      },
    })
  }, mocks)
}

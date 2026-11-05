// SPDX-License-Identifier: FSL-1.1-ALv2
// Settings > Billing while a renewal is unpaid (D17, P3R-19): a banner says to
// pay the open invoice, its button opens the payment frame on that invoice, and
// the top-up and auto top-up controls are hidden until it is paid.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import BillingSettings, { type BillingSummary } from "~/modules/settings/BillingSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

const SUMMARY: BillingSummary = {
  plan: "base",
  status: "active",
  periodEnd: "2026-12-01T00:00:00.000Z",
  previewEndsAt: null,
  cancelAt: null,
  nextInvoice: null,
  plans: [{ id: "base", priceDisplay: "€31.11", includedCredits: "250", caps: {} }],
  card: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2031 },
  topUp: { minCredits: 13, unitPriceCents: 117, currency: "EUR" },
  autoTopUp: { enabled: false, thresholdCredits: 20, amountCredits: 50 },
}

const OPEN = { invoiceId: "in_open_7", amountDisplay: "€31.11", dueAt: "2026-11-18T00:00:00.000Z" }

function stub(summary: BillingSummary, frameBodies: unknown[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    let body: unknown = { error: { message: "mock", code: "mock_miss" } }
    let status = 404
    if (url.includes("/billing/managed/summary")) {
      body = { data: { ok: true, ...summary } }
      status = 200
    } else if (url.includes("/billing/managed/invoices")) {
      body = { data: { invoices: [], hasMore: false } }
      status = 200
    } else if (url.includes("/credits/balance")) {
      body = { data: {} }
      status = 200
    } else if (url.includes("/billing/managed/frame-session")) {
      frameBodies.push(JSON.parse(String(init?.body)))
      body = {
        data: { frameOrigin: "https://frame.test", frameUrl: "https://frame.test/f", token: "t" },
      }
      status = 200
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  })
}

function renderPage() {
  render(() => (
    <I18nProvider initialLocale="en">
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <BillingSettings />
            </ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

describe("Billing while payment failed", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  for (const status of ["past_due", "suspended"] as const) {
    it(`${status}: the banner, the open invoice, and no top-up or auto top-up`, async () => {
      stub({ ...SUMMARY, status, openInvoice: OPEN }, [])
      renderPage()
      expect(await screen.findByTestId("billing-past-due")).toHaveTextContent(
        "Payment failed: pay the open invoice to keep using AI features.",
      )
      expect(screen.getByTestId("billing-open-invoice")).toHaveTextContent("€31.11")
      expect(screen.queryByTestId("billing-topup")).toBeNull()
      expect(screen.queryByTestId("billing-auto-topup")).toBeNull()
      // The rest of Billing stays: card, invoices, plan.
      expect(screen.getByTestId("billing-card")).toBeInTheDocument()
    })
  }

  it("a subscription that ran out says so, with no failed-payment line and no 'until then'", async () => {
    stub({ ...SUMMARY, status: "suspended", cancelAt: "2026-12-05T09:00:00.000Z" }, [])
    renderPage()
    const banner = await screen.findByTestId("billing-past-due")
    expect(banner).toHaveTextContent("Your subscription has ended")
    expect(banner).not.toHaveTextContent("Payment failed")
    expect(screen.queryByTestId("billing-cancel-at")).toBeNull()
    expect(screen.getByTestId("billing-plan")).not.toHaveTextContent("Renews on")
  })

  it("past due with a cancellation set: says the cancel date, not a renewal", async () => {
    stub(
      { ...SUMMARY, status: "past_due", openInvoice: OPEN, cancelAt: "2026-12-05T09:00:00.000Z" },
      [],
    )
    renderPage()
    expect(await screen.findByTestId("billing-cancel-at")).toBeInTheDocument()
    expect(screen.getByTestId("billing-plan")).not.toHaveTextContent("Renews on")
  })

  it("the button opens the payment frame on the open invoice", async () => {
    const frames: unknown[] = []
    stub({ ...SUMMARY, status: "past_due", openInvoice: OPEN }, frames)
    renderPage()
    fireEvent.click(await screen.findByTestId("billing-pay-open-invoice"))
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(frames[0]).toEqual({ action: "confirm_invoice", invoiceId: "in_open_7" })
  })

  it("active: no banner, top-up and auto top-up shown", async () => {
    stub(SUMMARY, [])
    renderPage()
    expect(await screen.findByTestId("billing-topup")).toBeInTheDocument()
    expect(screen.getByTestId("billing-auto-topup")).toBeInTheDocument()
    expect(screen.queryByTestId("billing-past-due")).toBeNull()
  })

  it("closed is a known status with its own label", async () => {
    stub({ ...SUMMARY, status: "closed" }, [])
    renderPage()
    expect(await screen.findByTestId("billing-plan")).toHaveTextContent("Closed")
    expect(screen.queryByTestId("billing-topup")).toBeNull()
  })
})

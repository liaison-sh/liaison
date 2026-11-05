// SPDX-License-Identifier: FSL-1.1-ALv2
// Settings > Billing (managed, S17): every amount on the page is the control
// plane's (display strings, top-up terms), never a product constant; a refused
// plan change lists the exceeded caps; the payment frame accepts a message only
// from its own origin, window and session token.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { Suspense } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import BillingSettings, {
  type BillingSummary,
  topUpPrice,
} from "~/modules/settings/BillingSettings"
import {
  isPayFrameMessage,
  PAY_FRAME_MAX_HEIGHT,
  PAY_FRAME_MIN_HEIGHT,
  payFrameHeightFrom,
} from "~/modules/settings/PayFrame"
import { ApiProvider } from "~/modules/shell/ApiContext"

/** Amounts no product constant could produce by accident. */
const SUMMARY: BillingSummary = {
  plan: "base",
  status: "active",
  periodEnd: "2026-12-01T00:00:00.000Z",
  previewEndsAt: null,
  cancelAt: null,
  nextInvoice: { amountDisplay: "€41.37", date: "2026-12-01T00:00:00.000Z" },
  plans: [
    { id: "base", priceDisplay: "€31.11", includedCredits: "250", caps: {} },
    { id: "pro", priceDisplay: "€77.77", includedCredits: "1000", caps: {} },
  ],
  card: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2031 },
  topUp: { minCredits: 13, unitPriceCents: 117, currency: "EUR" },
  autoTopUp: { enabled: false, thresholdCredits: 20, amountCredits: 50 },
}

type Reply = { status?: number; body: unknown } | undefined
type Handler = (url: string, init?: RequestInit) => Reply | Promise<Reply>

function stubApi(handler: Handler) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const r = (await handler(url, init)) ?? {
      status: 404,
      body: { error: { message: "mock not configured", code: "mock_miss" } },
    }
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  })
}

function baseRoutes(url: string): { status?: number; body: unknown } | undefined {
  if (url.includes("/billing/managed/summary")) return { body: { data: { ok: true, ...SUMMARY } } }
  if (url.includes("/billing/managed/invoices")) {
    return {
      body: {
        data: {
          invoices: [
            {
              id: "in_1",
              number: "LS-0001",
              kind: "invoice",
              issuedAt: "2026-11-01T00:00:00.000Z",
              amountDisplay: "€41.37",
              status: "paid",
            },
          ],
          hasMore: false,
        },
      },
    }
  }
  if (url.includes("/credits/balance")) {
    return { body: { data: { credits: { total: "180" }, period: { usedPercent: 28 } } } }
  }
  return undefined
}

function renderPage() {
  render(() => (
    <I18nProvider initialLocale="en">
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <Suspense fallback={<div data-testid="outer-fallback" />}>
                <BillingSettings />
              </Suspense>
            </ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

describe("BillingSettings", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("on a server without managed billing (404), says so instead of a transient error with a retry", async () => {
    // A self-hosted server answers /billing/managed/* with 404: the page is
    // reachable only by typing its address, and nothing will come back later.
    stubApi((url) =>
      url.includes("/billing/managed/")
        ? { status: 404, body: { error: { message: "Not Found", code: "not_found" } } }
        : baseRoutes(url),
    )
    renderPage()
    expect(await screen.findByTestId("billing-not-on-this-server")).toHaveTextContent(
      "This server has no billing",
    )
    expect(screen.queryByTestId("billing-unavailable")).toBeNull()
    expect(screen.queryByText("Try again")).toBeNull()
  })

  it("renders plan, next invoice, plans, card, credits and top-up from the summary only", async () => {
    stubApi(baseRoutes)
    renderPage()
    expect(await screen.findByTestId("billing-plan-name")).toHaveTextContent("Base")
    expect(screen.getByTestId("billing-next-invoice")).toHaveTextContent("€41.37")
    expect(screen.getByTestId("billing-plan-pro")).toHaveTextContent("€77.77")
    expect(screen.getByTestId("billing-card")).toHaveTextContent("4242")
    expect(await screen.findByTestId("billing-credits-left")).toHaveTextContent("180")
    expect(screen.getByTestId("billing-credits-used")).toHaveTextContent("28%")
    // The top-up starts at Control's minimum and is priced at Control's unit price.
    expect(screen.getByTestId("billing-topup-credits")).toHaveValue(13)
    expect(screen.getByTestId("billing-topup-price")).toHaveTextContent(
      topUpPrice(13, SUMMARY.topUp),
    )
    expect(topUpPrice(13, SUMMARY.topUp)).toContain("15.21")
    expect(await screen.findByTestId("billing-invoice-in_1")).toHaveTextContent("LS-0001")
    // No link anywhere on the page.
    expect(screen.getByTestId("billing-settings").querySelectorAll("a")).toHaveLength(0)
  })

  it("shows the credit balance like the rest of the UI, without trailing zeros", async () => {
    stubApi((url) =>
      url.includes("/credits/balance")
        ? { body: { data: { credits: { total: "15.00000000" }, period: { usedPercent: 0 } } } }
        : baseRoutes(url),
    )
    renderPage()
    expect(await screen.findByTestId("billing-credits-left")).toHaveTextContent(/^15 credits left$/)
  })

  it("says when the preview ends on the preview plan only", async () => {
    const at = "2026-12-24T00:00:00.000Z"
    stubApi((url) =>
      url.includes("/billing/managed/summary")
        ? { body: { data: { ok: true, ...SUMMARY, previewEndsAt: at } } }
        : baseRoutes(url),
    )
    renderPage()
    expect(await screen.findByTestId("billing-plan-name")).toHaveTextContent("Base")
    expect(screen.queryByTestId("billing-preview-ends")).toBeNull()
    cleanup()
    stubApi((url) =>
      url.includes("/billing/managed/summary")
        ? { body: { data: { ok: true, ...SUMMARY, plan: "preview", previewEndsAt: at } } }
        : baseRoutes(url),
    )
    renderPage()
    expect(await screen.findByTestId("billing-preview-ends")).toBeInTheDocument()
  })

  it("below Control's minimum the buy button is disabled", async () => {
    stubApi(baseRoutes)
    renderPage()
    const input = await screen.findByTestId("billing-topup-credits")
    fireEvent.input(input, { target: { value: "12" } })
    expect(screen.getByTestId("billing-topup-buy")).toBeDisabled()
    expect(screen.getByTestId("billing-topup-price")).toHaveTextContent("At least 13 credits")
  })

  it("a refused plan change lists the exceeded caps", async () => {
    stubApi((url, init) => {
      if (url.includes("/billing/managed/change-plan") && init?.method === "POST") {
        return {
          status: 409,
          body: {
            error: {
              message: "too small",
              code: "caps_exceeded",
              details: { caps: ["seats", "sharedMailboxes"] },
            },
          },
        }
      }
      if (url.includes("/billing/managed/summary")) {
        return {
          body: {
            data: {
              ok: true,
              ...SUMMARY,
              plans: [
                ...SUMMARY.plans,
                { id: "preview", priceDisplay: "€0.00", includedCredits: "50", caps: {} },
              ],
            },
          },
        }
      }
      return baseRoutes(url)
    })
    renderPage()
    fireEvent.click(await screen.findByTestId("billing-switch-preview"))
    const problem = await screen.findByTestId("billing-problem")
    expect(problem).toHaveTextContent("members")
    expect(problem).toHaveTextContent("shared mailboxes")
  })

  it("an unpaid upgrade shows 'waiting for payment' and a confirm action", async () => {
    stubApi((url) =>
      url.includes("/billing/managed/summary")
        ? {
            body: {
              data: {
                ok: true,
                ...SUMMARY,
                pendingChange: {
                  targetPlan: "pro",
                  effectiveAt: "2026-11-02T00:00:00.000Z",
                  kind: "upgrade_unpaid",
                  invoiceId: "in_9",
                },
              },
            },
          }
        : baseRoutes(url),
    )
    renderPage()
    expect(await screen.findByTestId("billing-pending-change")).toHaveTextContent(
      "waiting for payment",
    )
  })

  /** Records every requestId posted to `path`; answers each call from `replies` in turn. */
  function recordIds(
    path: string,
    replies: Array<"down" | "offline" | { status?: number; body: unknown }>,
  ) {
    const ids: string[] = []
    let n = 0
    stubApi((url, init) => {
      if (url.includes(path) && (init?.method === "POST" || init?.method === "PUT")) {
        ids.push((JSON.parse(String(init.body)) as { requestId: string }).requestId)
        const r = replies[Math.min(n++, replies.length - 1)]
        if (r === "offline") throw new TypeError("Failed to fetch")
        if (r === "down") {
          return { status: 503, body: { error: { message: "x", code: "billing_unavailable" } } }
        }
        return r
      }
      return baseRoutes(url)
    })
    return ids
  }

  const waitCalls = async (ids: string[], n: number) => {
    await vi.waitFor(() => expect(ids).toHaveLength(n))
    await vi.waitFor(() => expect(screen.queryByTestId("billing-topup-buy")).not.toBeDisabled())
  }

  it("keeps the page header on screen while Control is slow", async () => {
    stubApi((url) => {
      if (url.includes("/billing/managed/summary")) return new Promise(() => {}) as never
      return baseRoutes(url)
    })
    renderPage()
    await screen.findByTestId("billing-settings")
    expect(screen.queryByTestId("outer-fallback")).toBeNull()
  })

  it("a paid top-up re-reads the credits and the invoices", async () => {
    let balanceReads = 0
    let invoiceReads = 0
    stubApi((url, init) => {
      if (url.includes("/credits/balance")) balanceReads++
      if (url.includes("/billing/managed/invoices")) invoiceReads++
      if (url.includes("/billing/managed/topup") && init?.method === "POST") {
        return { body: { data: { ok: true, result: "paid", invoiceId: "in_1", credits: 13 } } }
      }
      return baseRoutes(url)
    })
    renderPage()
    await screen.findByTestId("billing-topup-credits")
    await vi.waitFor(() => expect(balanceReads).toBeGreaterThan(0))
    const beforeBalance = balanceReads
    const beforeInvoices = invoiceReads
    await vi.waitFor(() => expect(screen.getByTestId("billing-topup-buy")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("billing-topup-buy"))
    await vi.waitFor(() => expect(balanceReads).toBeGreaterThan(beforeBalance))
    expect(invoiceReads).toBeGreaterThan(beforeInvoices)
  })

  it("a re-read after a payment leaves the page on screen: the notice stays while Control answers", async () => {
    let balanceReads = 0
    let hold: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      hold = resolve
    })
    stubApi(async (url, init) => {
      if (url.includes("/credits/balance")) {
        balanceReads++
        if (balanceReads > 1) await held
      }
      if (url.includes("/billing/managed/topup") && init?.method === "POST") {
        return { body: { data: { ok: true, result: "paid", invoiceId: "in_1", credits: 13 } } }
      }
      return baseRoutes(url)
    })
    renderPage()
    await screen.findByTestId("billing-topup-credits")
    await vi.waitFor(() => expect(balanceReads).toBe(1))
    await vi.waitFor(() => expect(screen.getByTestId("billing-topup-buy")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("billing-topup-buy"))
    await vi.waitFor(() => expect(balanceReads).toBe(2))
    expect(await screen.findByTestId("billing-notice")).toBeInTheDocument()
    expect(screen.getByTestId("billing-plan")).toBeInTheDocument()
    hold()
  })

  it("a top-up retried after a timeout or a network error keeps its requestId; a new amount or a success mints a new one", async () => {
    const paid = { body: { data: { result: "paid", invoiceId: "in_2", credits: 20 } } }
    const ids = recordIds("/billing/managed/topup", ["down", "offline", paid, paid, "down", paid])
    renderPage()
    const input = await screen.findByTestId("billing-topup-credits")
    fireEvent.input(input, { target: { value: "20" } })
    const buy = () => fireEvent.click(screen.getByTestId("billing-topup-buy"))
    buy()
    await waitCalls(ids, 1)
    expect(await screen.findByTestId("billing-problem")).toBeInTheDocument()
    buy()
    await waitCalls(ids, 2)
    buy()
    await waitCalls(ids, 3)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).toBe(ids[0])
    // After a success the same amount is a new purchase.
    buy()
    await waitCalls(ids, 4)
    expect(ids[3]).not.toBe(ids[0])
    // A changed amount after a failure is a new intent too.
    buy()
    await waitCalls(ids, 5)
    fireEvent.input(input, { target: { value: "21" } })
    buy()
    await waitCalls(ids, 6)
    expect(ids[4]).not.toBe(ids[3])
    expect(ids[5]).not.toBe(ids[4])
    expect(new Set(ids).size).toBe(4)
  })

  it("a plan change retried after a timeout keeps its requestId; another target mints a new one", async () => {
    const ids = recordIds("/billing/managed/change-plan", ["down"])
    renderPage()
    fireEvent.click(await screen.findByTestId("billing-switch-pro"))
    await waitCalls(ids, 1)
    fireEvent.click(screen.getByTestId("billing-switch-pro"))
    await waitCalls(ids, 2)
    expect(ids[1]).toBe(ids[0])
    // A definitive refusal ends the intent: the next try is a new request.
    stubApi((url, init) => {
      if (url.includes("/billing/managed/change-plan") && init?.method === "POST") {
        ids.push((JSON.parse(String(init.body)) as { requestId: string }).requestId)
        return { status: 409, body: { error: { message: "x", code: "change_pending" } } }
      }
      return baseRoutes(url)
    })
    fireEvent.click(screen.getByTestId("billing-switch-pro"))
    await waitCalls(ids, 3)
    expect(ids[2]).toBe(ids[0])
    fireEvent.click(screen.getByTestId("billing-switch-pro"))
    await waitCalls(ids, 4)
    expect(ids[3]).not.toBe(ids[0])
  })

  it("an auto top-up save retried after a network error keeps its requestId; edited settings mint a new one", async () => {
    const ids = recordIds("/billing/managed/auto-topup", ["offline"])
    renderPage()
    const threshold = await screen.findByTestId("billing-auto-topup-threshold")
    fireEvent.input(threshold, { target: { value: "30" } })
    const save = () => fireEvent.click(screen.getByTestId("billing-auto-topup-save"))
    save()
    await waitCalls(ids, 1)
    save()
    await waitCalls(ids, 2)
    expect(ids[1]).toBe(ids[0])
    fireEvent.input(threshold, { target: { value: "31" } })
    save()
    await waitCalls(ids, 3)
    expect(ids[2]).not.toBe(ids[0])
  })

  it("Control down: says billing is unavailable", async () => {
    stubApi((url) =>
      url.includes("/billing/managed/summary")
        ? { status: 503, body: { error: { message: "x", code: "billing_unavailable" } } }
        : baseRoutes(url),
    )
    renderPage()
    expect(await screen.findByTestId("billing-unavailable")).toBeInTheDocument()
  })
})

describe("isPayFrameMessage", () => {
  const session = { frameOrigin: "https://pay.frame.test", token: "T".repeat(43) }
  const frameWindow = {} as MessageEventSource
  const good = { type: "liaison-pay-frame", token: session.token, ok: true, action: "card" }

  it("accepts the frame's own message", () => {
    expect(
      isPayFrameMessage(
        { origin: session.frameOrigin, source: frameWindow, data: good },
        session,
        frameWindow,
      ),
    ).toBe(true)
  })

  it("ignores another origin, another window, or another session's token", () => {
    expect(
      isPayFrameMessage(
        { origin: "https://evil.test", source: frameWindow, data: good },
        session,
        frameWindow,
      ),
    ).toBe(false)
    expect(
      isPayFrameMessage(
        { origin: session.frameOrigin, source: {} as MessageEventSource, data: good },
        session,
        frameWindow,
      ),
    ).toBe(false)
    expect(
      isPayFrameMessage(
        {
          origin: session.frameOrigin,
          source: frameWindow,
          data: { ...good, token: "U".repeat(43) },
        },
        session,
        frameWindow,
      ),
    ).toBe(false)
    expect(
      isPayFrameMessage(
        { origin: session.frameOrigin, source: frameWindow, data: "ok" },
        session,
        frameWindow,
      ),
    ).toBe(false)
  })
})

describe("payFrameHeightFrom", () => {
  const session = { frameOrigin: "https://pay.frame.test", token: "T".repeat(43) }
  const frameWindow = {} as MessageEventSource
  const msg = (height: unknown, over: Record<string, unknown> = {}) => ({
    origin: session.frameOrigin,
    source: frameWindow,
    data: { type: "liaison-pay-frame-height", token: session.token, height, ...over },
  })

  it("takes the frame's own height, clamped to sane bounds", () => {
    expect(payFrameHeightFrom(msg(512), session, frameWindow)).toBe(512)
    expect(payFrameHeightFrom(msg(512.2), session, frameWindow)).toBe(513)
    expect(payFrameHeightFrom(msg(3), session, frameWindow)).toBe(PAY_FRAME_MIN_HEIGHT)
    expect(payFrameHeightFrom(msg(1e9), session, frameWindow)).toBe(PAY_FRAME_MAX_HEIGHT)
  })

  it("ignores another origin, window or token, a result message and a non-number", () => {
    expect(
      payFrameHeightFrom({ ...msg(500), origin: "https://evil.test" }, session, frameWindow),
    ).toBeNull()
    expect(
      payFrameHeightFrom({ ...msg(500), source: {} as MessageEventSource }, session, frameWindow),
    ).toBeNull()
    expect(payFrameHeightFrom(msg(500, { token: "U".repeat(43) }), session, frameWindow)).toBeNull()
    expect(payFrameHeightFrom(msg("500"), session, frameWindow)).toBeNull()
    expect(payFrameHeightFrom(msg(Number.NaN), session, frameWindow)).toBeNull()
    expect(
      payFrameHeightFrom(msg(500, { type: "liaison-pay-frame" }), session, frameWindow),
    ).toBeNull()
  })
})

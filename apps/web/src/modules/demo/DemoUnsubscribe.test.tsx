// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The unsubscribe page: opening it does nothing, the button POSTs the token.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import DemoUnsubscribe from "~/modules/demo/DemoUnsubscribe"
import { I18nProvider } from "~/modules/i18n/i18n-context"

const TOKEN = "t".repeat(43)

function serve(status: number): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = status === 200 ? { data: { optedOut: true } } : { error: { message: "down" } }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  })
  return { calls }
}

function renderAt(search: string) {
  window.history.replaceState(null, "", `/demo/unsubscribe${search}`)
  render(() => (
    <I18nProvider initialLocale="en">
      <Router>
        <Route path="/demo/unsubscribe" component={DemoUnsubscribe} />
      </Router>
    </I18nProvider>
  ))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the unsubscribe page", () => {
  it("does nothing on open, and opts out on the button", async () => {
    const { calls } = serve(200)
    renderAt(`?token=${TOKEN}`)
    await screen.findByTestId("demo-unsubscribe-button")
    expect(calls).toHaveLength(0)

    fireEvent.click(screen.getByTestId("demo-unsubscribe-button"))
    await screen.findByTestId("demo-unsubscribe-done")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain("/demo/leads/opt-out")
    expect(calls[0].body).toEqual({ token: TOKEN })
  })

  it("says so when the server fails, and keeps the button", async () => {
    serve(503)
    renderAt(`?token=${TOKEN}`)
    fireEvent.click(await screen.findByTestId("demo-unsubscribe-button"))
    await screen.findByTestId("demo-unsubscribe-failed")
    expect(screen.getByTestId("demo-unsubscribe-button")).toBeTruthy()
  })

  it("offers no button for a link without a token", async () => {
    const { calls } = serve(200)
    renderAt("")
    await screen.findByTestId("demo-unsubscribe-missing")
    expect(screen.queryByTestId("demo-unsubscribe-button")).toBeNull()
    await waitFor(() => expect(calls).toHaveLength(0))
  })
})

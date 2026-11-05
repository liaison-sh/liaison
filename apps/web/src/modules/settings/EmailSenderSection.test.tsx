// SPDX-License-Identifier: FSL-1.1-ALv2
// Settings → Organization → Email sender (S29): no domain → the fallback line
// and the add form; a domain → its DNS records table (type, name, value,
// priority, copy buttons), status, Verify and Remove; the three refusals
// (domain_limit, domain_invalid, domain_taken) each get their own sentence,
// with no account detail; French renders too.

import type { ShippedLocale } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import EmailSenderSection from "~/modules/settings/EmailSenderSection"
import { ApiProvider } from "~/modules/shell/ApiContext"

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const DOMAIN = {
  id: "d_1",
  name: "mail.fabrikam.example",
  status: "pending",
  records: [
    { type: "MX", name: "send.mail", value: "feedback-smtp.example", priority: 10 },
    { type: "TXT", name: "resend._domainkey.mail", value: "p=MIGfMA0" },
  ],
}

type Handler = (url: string, init?: RequestInit) => Response | null

function renderWith(status: unknown, extra?: Handler, locale: ShippedLocale = "en") {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const hit = extra?.(String(url), init)
    if (hit) return hit
    if (String(url).endsWith("/mail-sender/status")) return jsonResp({ data: status })
    return jsonResp({})
  })
  vi.stubGlobal("fetch", fetchMock)
  window.history.pushState({}, "", "/settings/admin/org")
  render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <I18nProvider initialLocale={locale}>
            <ApiProvider>
              <EmailSenderSection orgName="Fabrikam" />
            </ApiProvider>
          </I18nProvider>
        )}
      />
    </Router>
  ))
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe("EmailSenderSection", () => {
  it("no domain: says mail goes out 'via Liaison' and offers the add form", async () => {
    renderWith({ domain: null })
    expect(await screen.findByTestId("email-sender-fallback")).toHaveTextContent(
      /Fabrikam via Liaison/,
    )
    expect(screen.getByTestId("email-sender-add")).toBeDisabled()
    expect(screen.queryByTestId("email-sender-records")).toBeNull()
  })

  it("add: posts the domain, then shows the records table with copy buttons", async () => {
    const fetchMock = renderWith({ domain: null }, (url, init) =>
      url.endsWith("/mail-sender/domain") && init?.method === "POST"
        ? jsonResp({ data: { domain: DOMAIN } })
        : null,
    )
    const input = (await screen.findByTestId("email-sender-domain-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "mail.fabrikam.example" } })
    fireEvent.click(screen.getByTestId("email-sender-add"))
    expect(await screen.findByTestId("email-sender-records")).toBeInTheDocument()
    const post = fetchMock.mock.calls.find(
      ([u, i]) =>
        String(u).endsWith("/mail-sender/domain") && (i as RequestInit)?.method === "POST",
    )
    expect(post).toBeDefined()
    const init = post?.[1] as RequestInit | undefined
    expect(JSON.parse(String(init?.body)).domain).toBe("mail.fabrikam.example")
    const row0 = screen.getByTestId("email-sender-record-0")
    expect(row0).toHaveTextContent("MX")
    expect(row0).toHaveTextContent("send.mail")
    expect(row0).toHaveTextContent("feedback-smtp.example")
    expect(screen.getByTestId("email-sender-priority-0")).toHaveTextContent("10")
    expect(screen.getByTestId("email-sender-priority-1")).toHaveTextContent("")
    expect(screen.getByTestId("email-sender-copy-value-1")).toBeInTheDocument()
    expect(screen.getByTestId("email-sender-copy-name-0")).toBeInTheDocument()
    expect(screen.getByTestId("email-sender-status")).toHaveAttribute("data-status", "pending")
  })

  it("copy puts the record value on the clipboard", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    renderWith({ domain: DOMAIN })
    fireEvent.click(await screen.findByTestId("email-sender-copy-value-0"))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("feedback-smtp.example"))
  })

  it("verify: a verified domain hides Verify and says mail now uses it", async () => {
    renderWith({ domain: DOMAIN }, (url, init) =>
      url.endsWith("/mail-sender/verify") && init?.method === "POST"
        ? jsonResp({ data: { domain: { ...DOMAIN, status: "verified" } } })
        : null,
    )
    fireEvent.click(await screen.findByTestId("email-sender-verify"))
    await waitFor(() =>
      expect(screen.getByTestId("email-sender-status")).toHaveAttribute("data-status", "verified"),
    )
    expect(screen.queryByTestId("email-sender-verify")).toBeNull()
    expect(screen.getByTestId("email-sender-verified-help")).toBeInTheDocument()
  })

  it("remove: back to the add form", async () => {
    renderWith({ domain: DOMAIN }, (url, init) =>
      url.endsWith("/mail-sender/domain") && init?.method === "DELETE"
        ? jsonResp({ data: { removed: true } })
        : null,
    )
    fireEvent.click(await screen.findByTestId("email-sender-remove"))
    expect(await screen.findByTestId("email-sender-fallback")).toBeInTheDocument()
  })

  for (const [code, status, pattern] of [
    ["domain_limit", 409, /cannot be added right now; we have been told/],
    ["domain_invalid", 422, /not a domain/],
    ["domain_taken", 409, /another organization/],
  ] as const) {
    it(`${code}: its own sentence, no account detail`, async () => {
      renderWith({ domain: null }, (url, init) =>
        url.endsWith("/mail-sender/domain") && init?.method === "POST"
          ? jsonResp({ error: { message: "x", code } }, status)
          : null,
      )
      const input = (await screen.findByTestId("email-sender-domain-input")) as HTMLInputElement
      fireEvent.input(input, { target: { value: "mail.fabrikam.example" } })
      fireEvent.click(screen.getByTestId("email-sender-add"))
      const error = await screen.findByTestId("email-sender-error")
      expect(error.textContent).toMatch(pattern)
      expect(error.textContent).not.toMatch(/resend|plan|account/i)
    })
  }

  it("control plane down: says so", async () => {
    renderWith(null, (url) =>
      url.endsWith("/mail-sender/status")
        ? jsonResp({ error: { message: "x", code: "billing_unavailable" } }, 503)
        : null,
    )
    expect(await screen.findByTestId("email-sender-unavailable")).toBeInTheDocument()
  })

  it("French renders", async () => {
    renderWith({ domain: null }, undefined, "fr")
    expect(await screen.findByTestId("email-sender-fallback")).toHaveTextContent(/via Liaison/)
    expect(screen.getByTestId("email-sender-add").textContent).not.toBe("")
    expect(screen.getByTestId("email-sender-add").textContent).not.toMatch(/cloud-limits/)
  })
})

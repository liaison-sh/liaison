// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SsoProviders from "~/modules/settings/SsoProviders"
import { ApiProvider } from "~/modules/shell/ApiContext"

function WrappedSsoProviders() {
  return (
    <ApiProvider>
      <SsoProviders />
    </ApiProvider>
  )
}

function renderWithRouter() {
  return render(() => (
    <Router>
      <Route path="*" component={WrappedSsoProviders} />
    </Router>
  ))
}

// The SSO block of Security > Sign-in methods: the provider cards of the
// former Integrations page and the add form of the former SSO Providers page.
describe("SsoProviders", () => {
  let providers: Array<Record<string, unknown>>

  beforeEach(() => {
    providers = [
      {
        id: "provider-1",
        name: "Acme OIDC",
        issuerUrl: "https://idp.acme.test",
        scopes: "openid email profile",
        autoProvision: true,
        configured: true,
        connectedAccountCount: 2,
      },
    ]

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (
          url.endsWith("/api/admin/oauth-providers") &&
          (!init?.method || init.method === "GET")
        ) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: providers }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }
        if (url.endsWith("/api/admin/oauth-providers/provider-1") && init?.method === "DELETE") {
          providers = []
          return Promise.resolve(
            new Response(JSON.stringify({ data: { deleted: true } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }
        if (url.endsWith("/api/admin/oauth-providers") && init?.method === "POST") {
          const body = JSON.parse(String(init.body))
          providers = [
            ...providers,
            {
              id: "provider-2",
              name: body.name,
              issuerUrl: body.issuerUrl,
              scopes: null,
              autoProvision: false,
              configured: true,
              connectedAccountCount: 0,
            },
          ]
          return Promise.resolve(
            new Response(JSON.stringify({ data: { id: "provider-2" } }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }),
          )
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`))
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("renders OAuth provider status from the admin provider contract", async () => {
    renderWithRouter()

    expect(await screen.findByText("Acme OIDC")).toBeInTheDocument()
    expect(screen.getByText("https://idp.acme.test")).toBeInTheDocument()
    expect(screen.getByText("Configured")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /connect/i })).toHaveAttribute(
      "href",
      "/api/auth/oauth/provider-1/authorize",
    )
  })

  it("opens the add form from Add provider, and lists the new provider once added", async () => {
    renderWithRouter()
    expect(await screen.findByText("Acme OIDC")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    await waitFor(() => {
      expect(screen.getByText("Add SSO Provider")).toBeInTheDocument()
      expect(screen.getByLabelText(/provider name/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/issuer url/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/client id/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/client secret/i)).toBeInTheDocument()
    })
    fireEvent.input(screen.getByLabelText(/provider name/i), { target: { value: "Okta" } })
    fireEvent.input(screen.getByLabelText(/issuer url/i), {
      target: { value: "https://okta.example" },
    })
    fireEvent.input(screen.getByLabelText(/client id/i), { target: { value: "cid" } })
    fireEvent.input(screen.getByLabelText(/client secret/i), { target: { value: "sec" } })
    const submit = screen
      .getAllByRole("button", { name: /add provider/i })
      .find((b) => b.getAttribute("type") === "submit")
    if (!submit) throw new Error("no submit button")
    fireEvent.click(submit)
    expect(await screen.findByTestId("sso-provider-provider-2")).toBeInTheDocument()
  })

  it("disconnects a provider immediately and refetches the list", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>

    renderWithRouter()

    expect(await screen.findByText("Acme OIDC")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))
    expect(screen.getByText("Disconnect OAuth Provider")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }))

    await waitFor(() => {
      expect(screen.getByText("No OAuth providers configured")).toBeInTheDocument()
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/oauth-providers/provider-1",
      expect.objectContaining({ method: "DELETE" }),
    )
  })
})

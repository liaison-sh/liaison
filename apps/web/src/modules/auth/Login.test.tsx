// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authApiUrl } from "~/lib/env"
import Login from "~/modules/auth/Login"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { _resetBranding, ensureBrandingLoaded } from "~/modules/shell/branding-store"

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })

const emptyProviders = () => jsonResponse({ data: [] })

function renderWithRouter() {
  return render(() => (
    <Router>
      <Route path="*" component={Login} />
    </Router>
  ))
}

describe("Login", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    // Default first call: provider list (empty).
    fetchMock.mockResolvedValueOnce(emptyProviders())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders brand text", () => {
    renderWithRouter()
    expect(screen.getByText("Liaison")).toBeInTheDocument()
    expect(screen.getByText("Sign in to your workspace")).toBeInTheDocument()
  })

  it("defaults to passwordless email entry (no password field shown)", () => {
    renderWithRouter()
    expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /continue with email/i })).toBeInTheDocument()
    // Password field is not part of the default view.
    expect(screen.queryByPlaceholderText("••••••••")).not.toBeInTheDocument()
  })

  it("requests a magic-link code and advances to the code entry step", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { challengeId: "chal-1", message: "sent" } }),
    )
    renderWithRouter()
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "test@test.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /continue with email/i }))

    await waitFor(() => {
      expect(screen.getByText(/6-digit code/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText("000000")).toBeInTheDocument()
    })
  })

  it("shows a rate-limit message when the code request is throttled", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Too many requests" } }, 429, { "Retry-After": "10" }),
    )
    renderWithRouter()
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "test@test.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /continue with email/i }))

    await waitFor(() => {
      expect(screen.getByText(/too many attempts/i)).toBeInTheDocument()
    })
  })

  it("reveals the retained password form (with forgot-password) via the toggle", async () => {
    renderWithRouter()
    fireEvent.click(screen.getByRole("button", { name: /sign in with a password/i }))
    await waitFor(() => {
      expect(screen.getByPlaceholderText("••••••••")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument()
      expect(screen.getByText(/forgot password/i)).toBeInTheDocument()
    })
  })

  it("reaches the password form in one tap from the code step, keeping the email", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { challengeId: "chal-1", message: "sent" } }),
    )
    renderWithRouter()
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "owner@test.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /continue with email/i }))
    await waitFor(() => expect(screen.getByPlaceholderText("000000")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /sign in with a password/i }))
    await waitFor(() => expect(screen.getByPlaceholderText("••••••••")).toBeInTheDocument())
    expect(screen.getByPlaceholderText("you@company.com")).toHaveValue("owner@test.com")
  })

  it("surfaces an auth error from password login", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid credentials" } }, 401),
    )
    renderWithRouter()
    fireEvent.click(screen.getByRole("button", { name: /sign in with a password/i }))
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "test@test.com" },
    })
    fireEvent.input(screen.getByPlaceholderText("••••••••"), { target: { value: "wrong" } })
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }))

    await waitFor(() => {
      expect(screen.getByText(/that didn't work/i)).toBeInTheDocument()
    })
  })

  it("shows the existing-account message when a provider login matches an unlinked account", async () => {
    const message = "An account with this email exists. Sign in with your existing method"
    window.history.replaceState(null, "", `/login?error=${encodeURIComponent(message)}`)
    try {
      renderWithRouter()
      await waitFor(() => {
        expect(screen.getByText(message)).toBeInTheDocument()
      })
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })

  it("renders a Google provider button when providers exist", async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "google", name: "Google" }] }))
    renderWithRouter()
    await waitFor(() => {
      expect(screen.getByText("Continue with Google")).toBeInTheDocument()
    })
    const href = screen.getByRole("link", { name: /continue with google/i }).getAttribute("href")!
    expect(href).toContain(authApiUrl("/oauth/google/authorize"))
    expect(href).toContain("state=")
  })

  it("shows one unreachable message and no provider buttons when the API cannot be reached", async () => {
    fetchMock.mockReset()
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    renderWithRouter()
    // A read retries a network error twice (up to about 3 s of waits) before it fails.
    await waitFor(
      () => {
        expect(screen.getByTestId("providers-unreachable")).toBeInTheDocument()
      },
      { timeout: 5_000 },
    )
    expect(screen.getAllByTestId("providers-unreachable")).toHaveLength(1)
    expect(screen.queryAllByRole("link", { name: /continue with/i })).toHaveLength(0)
  })

  it("renders no provider buttons when the providers response is not a provider list", async () => {
    // The Capacitor webview serves its own index.html for an unreachable API
    // origin: a 200 text/html body, which the client returns as a STRING.
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(
      new Response('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    )
    renderWithRouter()
    await waitFor(() => {
      expect(screen.getByTestId("providers-unreachable")).toBeInTheDocument()
    })
    expect(screen.queryAllByRole("link", { name: /continue with/i })).toHaveLength(0)
  })

  it("never renders a provider button for an entry without a display name", async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "nameless", name: "" },
          { id: "blank", name: "   " },
          { id: "missing" },
          { id: "google", name: "Google" },
        ],
      }),
    )
    renderWithRouter()
    await waitFor(() => {
      expect(screen.getByText("Continue with Google")).toBeInTheDocument()
    })
    expect(screen.queryAllByRole("link", { name: /continue with/i })).toHaveLength(1)
    expect(screen.queryByTestId("providers-unreachable")).not.toBeInTheDocument()
  })

  it("pads the login page with the top safe-area inset", () => {
    renderWithRouter()
    expect(screen.getByTestId("auth-page").className).toContain("env(safe-area-inset-top)")
  })
  // P6d-T15: on a desktop that does not know which Liaison it is talking to,
  // the same card asks for the server address first, then for this device to
  // be approved. One card, two steps, never two panels at once.
  describe("desktop steps", () => {
    afterEach(() => uninstallFakeBridge())

    it("login asks for a server address first on the desktop", () => {
      installFakeBridge({}, { serverAddress: null })
      renderWithRouter()
      expect(screen.getByLabelText("Liaison org URL")).toBeInTheDocument()
      expect(screen.queryByPlaceholderText("you@company.com")).not.toBeInTheDocument()
      expect(screen.queryByPlaceholderText("••••••••")).not.toBeInTheDocument()
    })

    it("the device code step replaces the address step and does not stack over it", () => {
      installFakeBridge(
        { deviceApproval: "https://liaison.fabrikam.example/auth/device?code=58KNBUY8" },
        { serverAddress: null },
      )
      renderWithRouter()
      expect(screen.getByTestId("device-approval-code")).toBeInTheDocument()
      expect(screen.queryByLabelText("Liaison org URL")).not.toBeInTheDocument()
    })

    it("a desktop already bound to a server gets the ordinary login", () => {
      installFakeBridge({}, { serverAddress: "https://liaison.fabrikam.example" })
      renderWithRouter()
      expect(screen.queryByLabelText("Liaison org URL")).not.toBeInTheDocument()
      expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument()
    })

    it("login is the ordinary login in a browser", () => {
      uninstallFakeBridge()
      renderWithRouter()
      expect(screen.queryByLabelText("Liaison org URL")).not.toBeInTheDocument()
      expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /continue with email/i })).toBeInTheDocument()
    })
  })
})

// The demo doors replace this card only when the SERVER says so. Same bundle,
// same route: a self-hosted install must never see any of it.
describe("Login on a demo deployment", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  async function serverSays(demo: boolean): Promise<void> {
    _resetBranding()
    await ensureBrandingLoaded(
      (async () =>
        ({
          ok: true,
          json: async () => ({
            data: { orgName: "Resonant Audio Labs", flags: demo ? { demo: true } : {} },
          }),
        }) as unknown as Response) as unknown as typeof fetch,
    )
  }

  beforeEach(() => {
    fetchMock = vi.fn(async () => emptyProviders())
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    _resetBranding()
  })

  it("shows the ordinary card when the server raised no demo flag", async () => {
    await serverSays(false)
    renderWithRouter()
    expect(screen.getByTestId("auth-card")).toBeInTheDocument()
    expect(screen.queryByTestId("demo-entry")).toBeNull()
  })

  it("shows the demo door in place of the card when it did", async () => {
    await serverSays(true)
    renderWithRouter()
    expect(screen.getByTestId("demo-entry")).toBeInTheDocument()
    expect(screen.getByTestId("demo-pick-step")).toBeInTheDocument()
    expect(screen.queryByTestId("auth-card")).toBeNull()
  })

  it("offers no account creation where the server says accounts come by invitation", async () => {
    _resetBranding()
    await ensureBrandingLoaded(
      (async () =>
        ({
          ok: true,
          json: async () => ({ data: { orgName: "Managed", flags: { noAccountEntry: true } } }),
        }) as unknown as Response) as unknown as typeof fetch,
    )
    renderWithRouter()
    expect(screen.getByTestId("auth-card")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /create an account/i })).toBeNull()
  })

  it("offers it everywhere else", async () => {
    await serverSays(false)
    renderWithRouter()
    expect(screen.getByRole("link", { name: /create an account/i })).toBeInTheDocument()
  })

  it("keeps an ordinary sign in one click away", async () => {
    await serverSays(true)
    renderWithRouter()
    fireEvent.click(screen.getByTestId("demo-sign-in-instead"))
    await waitFor(() => expect(screen.getByTestId("auth-card")).toBeInTheDocument())
  })

  // A demo box sends no mail at all, so an emailed code can never arrive: the
  // owner's phone sat on "enter the 6-digit code" for a code that never came.
  it("leads with the password form and offers no email code on a demo box", async () => {
    await serverSays(true)
    // The previous test left `?signin=1` in the URL; start from the door.
    window.history.replaceState(null, "", "/login")
    renderWithRouter()
    fireEvent.click(screen.getByTestId("demo-sign-in-instead"))
    await waitFor(() => expect(screen.getByPlaceholderText("••••••••")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /continue with email/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /email code/i })).toBeNull()
  })

  it("says mail can't go out, stays on the email step, and never claims a code was sent", async () => {
    await serverSays(false)
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes("/magic-link/request")
        ? jsonResponse(
            {
              error: {
                message: "We can't send email right now.",
                code: "EMAIL_PROVIDER_UNAVAILABLE",
              },
            },
            403,
          )
        : emptyProviders(),
    )
    renderWithRouter()
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "owner@test.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /continue with email/i }))
    await waitFor(() =>
      expect(screen.getByTestId("email-provider-unavailable")).toBeInTheDocument(),
    )
    expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument()
    expect(screen.queryByText(/code/i)).toBeNull()
  })

  it("opens the password form with the reason when the server refuses to send a code", async () => {
    // The flag has not landed (or the app is bound to a box it never read):
    // the server's instance-wide refusal still lands the user on the password.
    await serverSays(false)
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes("/magic-link/request")
        ? jsonResponse(
            {
              error: {
                message: "This demo can't send email. Sign in with your password.",
                code: "EMAIL_SIGN_IN_UNAVAILABLE",
              },
            },
            403,
          )
        : emptyProviders(),
    )
    renderWithRouter()
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "owner@test.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /continue with email/i }))

    await waitFor(() => expect(screen.getByPlaceholderText("••••••••")).toBeInTheDocument())
    expect(screen.getByText(/can't send email/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText("you@company.com")).toHaveValue("owner@test.com")
    expect(screen.queryByPlaceholderText("000000")).toBeNull()
  })
})

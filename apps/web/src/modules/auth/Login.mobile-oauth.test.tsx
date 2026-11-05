// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "CONTINUE WITH GOOGLE" IN THE iOS SHELL runs in ASWebAuthenticationSession,
// reached through the native bridge's `authenticate`, with the same PKCE flow
// the desktop uses (`client=mobile`). The session hands the callback URL back
// to the call that opened it, and the page redeems the code with its verifier.
//
// The native shell also offers no way to create an account: no "Create an
// account" link and no demo visitor door, whatever the server says.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authApiUrl } from "~/lib/env"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { accessToken, clearAuth } from "~/modules/auth/auth-store"
import { DESKTOP_OAUTH_STORAGE_KEY, resetDesktopOAuth } from "~/modules/auth/desktop-oauth"
import Login from "~/modules/auth/Login"
import { _resetBranding, ensureBrandingLoaded } from "~/modules/shell/branding-store"

const SERVER = "https://liaison.fabrikam.example"
const CODE = "b".repeat(64)

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

function renderLogin() {
  return render(() => (
    <Router>
      <Route path="*" component={Login} />
    </Router>
  ))
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  let binary = ""
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

type Authenticate = (options: { url: string; callbackScheme: string }) => Promise<string | null>

describe("Login in the native mobile shell", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let navigationErrors: string[]
  let authenticate: ReturnType<typeof vi.fn<Authenticate>>

  const exchanges = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/auth/oauth/exchange"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))

  /** The session's answer: the handoff link for the state the page minted. */
  function completesWith(query: (state: string) => string) {
    authenticate.mockImplementation(async ({ url }) => {
      const state = new URL(url).searchParams.get("state")!
      return `liaison://oauth-complete?${query(state)}`
    })
  }

  beforeEach(() => {
    clearAuth()
    resetDesktopOAuth()
    _resetBranding()
    fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/oauth/providers")) {
        return jsonResponse({ data: [{ id: "google", name: "Google" }] })
      }
      if (url.endsWith("/auth/oauth/exchange")) {
        return jsonResponse({ data: { accessToken: "at-mobile", refreshToken: "rt-mobile" } })
      }
      return jsonResponse({ data: null })
    })
    vi.stubGlobal("fetch", fetchMock)
    navigationErrors = []
    const original = console.error
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(" ")
      if (text.includes("navigation")) navigationErrors.push(text)
      else original(...args)
    })
    window.history.replaceState(null, "", "/login")
    authenticate = vi.fn<Authenticate>()
    const slot = globalThis as Record<string, unknown>
    slot.__LIAISON_SERVER_ADDRESS__ = SERVER
    slot[NATIVE_BRIDGE_GLOBAL] = { authenticate }
  })

  afterEach(() => {
    const slot = globalThis as Record<string, unknown>
    delete slot.__LIAISON_SERVER_ADDRESS__
    delete slot[NATIVE_BRIDGE_GLOBAL]
    resetDesktopOAuth()
    clearAuth()
    _resetBranding()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.history.replaceState(null, "", "/")
  })

  async function clickGoogle() {
    renderLogin()
    fireEvent.click(await screen.findByRole("link", { name: /continue with google/i }))
    await waitFor(() => expect(authenticate).toHaveBeenCalledTimes(1))
    const [options] = authenticate.mock.calls[0]!
    return { opened: new URL(options.url), callbackScheme: options.callbackScheme }
  }

  it("provider button calls authenticate and completes", async () => {
    completesWith((state) => `code=${CODE}&state=${state}`)
    const { opened, callbackScheme } = await clickGoogle()

    expect(callbackScheme).toBe("liaison")
    expect(`${opened.origin}${opened.pathname}`).toBe(authApiUrl("/oauth/google/authorize"))
    expect(opened.searchParams.get("client")).toBe("mobile")
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256")
    expect(opened.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)

    await waitFor(() => expect(accessToken()).toBe("at-mobile"))
    const [body] = exchanges()
    expect(body.code).toBe(CODE)
    expect(body.state).toBe(opened.searchParams.get("state"))
    expect(await s256(body.code_verifier)).toBe(opened.searchParams.get("code_challenge"))
    expect(sessionStorage.getItem(DESKTOP_OAUTH_STORAGE_KEY)).toBeNull()
    expect(navigationErrors).toEqual([])
  })

  it("stays on the card, quietly, when the user closes the sheet", async () => {
    authenticate.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "cancelled" }))
    await clickGoogle()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(exchanges()).toEqual([])
    expect(accessToken()).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("link", { name: /continue with google/i })).toBeInTheDocument()
    expect(sessionStorage.getItem(DESKTOP_OAUTH_STORAGE_KEY)).toBeNull()
  })

  it("tells an unknown address to ask for an invite", async () => {
    completesWith((state) => `error=No+matching+account&state=${state}`)
    await clickGoogle()

    await waitFor(() =>
      expect(screen.getByText(/ask your admin for an invite/i)).toBeInTheDocument(),
    )
    expect(exchanges()).toEqual([])
  })

  it("ignores a callback whose state the page did not mint", async () => {
    authenticate.mockResolvedValue(`liaison://oauth-complete?code=${CODE}&state=${"z".repeat(43)}`)
    await clickGoogle()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(exchanges()).toEqual([])
    expect(accessToken()).toBeNull()
  })

  it("no Create an account", async () => {
    renderLogin()
    await screen.findByRole("link", { name: /continue with google/i })
    expect(screen.queryByRole("link", { name: "Create an account" })).toBeNull()
    // The password step still works: email and password sign in stays.
    fireEvent.click(screen.getByTestId("password-login-toggle"))
    expect(screen.getByTestId("password-login-submit")).toBeInTheDocument()
  })

  it("no demo entry, even on a demo deployment", async () => {
    await ensureBrandingLoaded(
      (async () =>
        ({
          ok: true,
          json: async () => ({ data: { orgName: "Demo", flags: { demo: true } } }),
        }) as unknown as Response) as unknown as typeof fetch,
    )
    renderLogin()
    expect(screen.queryByTestId("demo-entry")).toBeNull()
    expect(screen.getByTestId("auth-card")).toBeInTheDocument()
  })
})

describe("Login in a browser keeps account creation", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("still links Create an account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "google", name: "Google" }] })),
    )
    renderLogin()
    await screen.findByRole("link", { name: /continue with google/i })
    expect(screen.getByRole("link", { name: "Create an account" })).toBeInTheDocument()
  })
})

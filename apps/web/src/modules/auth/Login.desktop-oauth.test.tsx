// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "CONTINUE WITH GOOGLE" IN THE DESKTOP APP opens the SYSTEM browser and
// comes back through a `liaison://oauth-complete` link (RFC 8252). The window
// itself must never navigate to the provider: Google refuses embedded user
// agents and its passkey sign-in cannot reach the platform passkey store from
// an embedded webview, which is how users with a passkey or 2FA were locked out.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authApiUrl } from "~/lib/env"
import { accessToken, clearAuth } from "~/modules/auth/auth-store"
import { DESKTOP_OAUTH_STORAGE_KEY, resetDesktopOAuth } from "~/modules/auth/desktop-oauth"
import Login from "~/modules/auth/Login"
import {
  type FakeBridgeHandle,
  installFakeBridge,
  uninstallFakeBridge,
} from "~/modules/desktop/fake-bridge"

const SERVER = "https://liaison.fabrikam.example"
const CODE = "a".repeat(64)

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

describe("Login: desktop sign-in through the system browser", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let shell: FakeBridgeHandle
  let navigationErrors: string[]

  /** The exchange calls the page made, with their bodies. */
  const exchanges = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/auth/oauth/exchange"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))

  beforeEach(() => {
    clearAuth()
    resetDesktopOAuth()
    fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/oauth/providers")) {
        return jsonResponse({ data: [{ id: "google", name: "Google" }] })
      }
      if (url.endsWith("/auth/oauth/exchange")) {
        return jsonResponse({ data: { accessToken: "at-desktop", refreshToken: "rt-desktop" } })
      }
      return jsonResponse({ data: null })
    })
    vi.stubGlobal("fetch", fetchMock)
    // jsdom reports a real navigation (which it cannot perform) on the
    // console: that is how "the window navigated" is observable here.
    navigationErrors = []
    const original = console.error
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(" ")
      if (text.includes("navigation")) navigationErrors.push(text)
      else original(...args)
    })
    window.history.replaceState(null, "", "/login")
    // What the shell publishes before the page loads: the bound server.
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = SERVER
    shell = installFakeBridge({}, { serverAddress: SERVER })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
    uninstallFakeBridge()
    resetDesktopOAuth()
    clearAuth()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.history.replaceState(null, "", "/")
  })

  async function clickGoogle() {
    renderLogin()
    const button = await screen.findByRole("link", { name: /continue with google/i })
    fireEvent.click(button)
    await waitFor(() => expect(shell.calls.openedAuthUrls).toHaveLength(1))
    return new URL(shell.calls.openedAuthUrls[0]!)
  }

  it("opens the authorize URL in the system browser with PKCE, and does not navigate the window", async () => {
    const opened = await clickGoogle()

    expect(`${opened.origin}${opened.pathname}`).toBe(authApiUrl("/oauth/google/authorize"))
    expect(opened.searchParams.get("client")).toBe("desktop")
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256")
    expect(opened.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(opened.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // The verifier stays in this window, and is what the challenge was made of.
    const stored = JSON.parse(sessionStorage.getItem(DESKTOP_OAUTH_STORAGE_KEY)!)
    expect(stored.state).toBe(opened.searchParams.get("state"))
    expect(await s256(stored.verifier)).toBe(opened.searchParams.get("code_challenge"))
    expect(opened.search).not.toContain(stored.verifier)

    expect(navigationErrors).toEqual([])
    expect(window.location.pathname).toBe("/login")
    await waitFor(() => expect(screen.getByTestId("desktop-oauth-waiting")).toBeInTheDocument())
    expect(screen.getByText("Continue in your browser…")).toBeInTheDocument()
    expect(screen.queryByPlaceholderText("you@company.com")).not.toBeInTheDocument()
  })

  it("redeems the code from the deep link with the verifier and signs in", async () => {
    const opened = await clickGoogle()
    const state = opened.searchParams.get("state")!

    shell.deliverOAuthLink(`liaison://oauth-complete?code=${CODE}&state=${state}`)

    await waitFor(() => expect(accessToken()).toBe("at-desktop"))
    const [body] = exchanges()
    expect(body.code).toBe(CODE)
    expect(body.state).toBe(state)
    expect(await s256(body.code_verifier)).toBe(opened.searchParams.get("code_challenge"))
    // The exchange goes to THIS install's server, where the shell's refresh
    // bridge keeps the refresh token the body carries.
    const exchangeUrl = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/auth/oauth/exchange"),
    )![0]
    expect(String(exchangeUrl)).toBe(authApiUrl("/oauth/exchange"))
    expect(sessionStorage.getItem(DESKTOP_OAUTH_STORAGE_KEY)).toBeNull()
  })

  it("refuses a link whose state this window did not mint, and keeps waiting", async () => {
    await clickGoogle()

    shell.deliverOAuthLink(`liaison://oauth-complete?code=${CODE}&state=${"x".repeat(43)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(exchanges()).toEqual([])
    expect(accessToken()).toBeNull()
    expect(screen.getByTestId("desktop-oauth-waiting")).toBeInTheDocument()
  })

  it("refuses a link when nothing is waiting", async () => {
    renderLogin()
    await screen.findByRole("link", { name: /continue with google/i })
    shell.deliverOAuthLink(`liaison://oauth-complete?code=${CODE}&state=${"y".repeat(43)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(exchanges()).toEqual([])
  })

  it("says why when the server handed back a refusal", async () => {
    const opened = await clickGoogle()
    const state = opened.searchParams.get("state")!

    shell.deliverOAuthLink(`liaison://oauth-complete?error=Account+deactivated&state=${state}`)

    await waitFor(() => expect(screen.getByText("Account deactivated")).toBeInTheDocument())
    expect(exchanges()).toEqual([])
    expect(screen.queryByTestId("desktop-oauth-waiting")).not.toBeInTheDocument()
  })

  it("opens the same sign-in again, and cancel stops waiting for it", async () => {
    const opened = await clickGoogle()
    fireEvent.click(await screen.findByRole("button", { name: "Open the browser again" }))
    await waitFor(() => expect(shell.calls.openedAuthUrls).toHaveLength(2))
    expect(shell.calls.openedAuthUrls[1]).toBe(opened.toString())

    fireEvent.click(screen.getByTestId("desktop-oauth-cancel"))
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-oauth-waiting")).not.toBeInTheDocument(),
    )
    shell.deliverOAuthLink(
      `liaison://oauth-complete?code=${CODE}&state=${opened.searchParams.get("state")}`,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(exchanges()).toEqual([])
  })

  it("says so when the browser could not be opened", async () => {
    uninstallFakeBridge()
    shell = installFakeBridge({}, { serverAddress: SERVER, refuseOpenAuth: true })
    renderLogin()
    fireEvent.click(await screen.findByRole("link", { name: /continue with google/i }))
    await waitFor(() =>
      expect(screen.getByText("The browser could not be opened. Try again.")).toBeInTheDocument(),
    )
    expect(navigationErrors).toEqual([])
  })
})

describe("Login: the browser keeps its plain navigation", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("links the provider button to the authorize route with only the web state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "google", name: "Google" }] })),
    )
    renderLogin()
    const link = await screen.findByRole("link", { name: /continue with google/i })
    const href = new URL(link.getAttribute("href")!, "http://x")
    expect([...href.searchParams.keys()]).toEqual(["state"])
  })
})

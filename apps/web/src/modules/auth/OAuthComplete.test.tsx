// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  accessToken,
  clearAuth,
  consumeChallengeToken,
  hasSession,
} from "~/modules/auth/auth-store"
import OAuthComplete from "~/modules/auth/OAuthComplete"

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }))

vi.mock("~/lib/api-client", () => ({
  anonApiClient: { post: postMock },
}))

function renderWithRouter() {
  return render(() => (
    <Router>
      <Route path="*" component={OAuthComplete} />
    </Router>
  ))
}

const TEST_STATE = "test-state-nonce"

describe("OAuthComplete", () => {
  beforeEach(() => {
    clearAuth()
    postMock.mockReset()
    sessionStorage.setItem("oauth_state", TEST_STATE)
  })

  afterEach(() => {
    clearAuth()
    sessionStorage.removeItem("oauth_state")
    vi.restoreAllMocks()
    window.history.replaceState({}, "", "/")
  })

  it("exchanges code for access token and navigates to /", async () => {
    postMock.mockResolvedValueOnce({ accessToken: "at-from-exchange" })

    window.history.replaceState({}, "", `/login/oauth-complete?code=test-code&state=${TEST_STATE}`)

    renderWithRouter()

    await waitFor(
      () => {
        expect(window.location.pathname).toBe("/")
        expect(accessToken()).toBe("at-from-exchange")
      },
      { timeout: 15000 },
    )

    expect(hasSession()).toBe(true)
    expect(postMock).toHaveBeenCalledWith("/auth/oauth/exchange", {
      code: "test-code",
      state: TEST_STATE,
    })
    // The URL-scrub + state-consume effect runs after navigation resolves;
    // under parallel-worker CPU pressure it can lag the navigation waitFor,
    // so assert it in its own waitFor rather than synchronously.
    await waitFor(
      () => {
        // Code param should be scrubbed from URL
        expect(window.location.search).toBe("")
        // State should be consumed from sessionStorage
        expect(sessionStorage.getItem("oauth_state")).toBeNull()
      },
      { timeout: 15000 },
    )
  })

  it("takes an account with two-factor sign-in to the TOTP step, with no session", async () => {
    postMock.mockResolvedValueOnce({ totpRequired: true, challengeToken: "challenge-from-oauth" })

    window.history.replaceState({}, "", `/login/oauth-complete?code=test-code&state=${TEST_STATE}`)

    renderWithRouter()

    await waitFor(
      () => {
        expect(window.location.pathname).toBe("/login/totp")
      },
      { timeout: 15000 },
    )
    expect(accessToken()).toBeNull()
    expect(consumeChallengeToken()).toBe("challenge-from-oauth")
  })

  it("redirects to login when no code param is present", async () => {
    window.history.replaceState({}, "", "/login/oauth-complete")

    renderWithRouter()

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login")
      expect(window.location.search).toBe("?error=OAuth+authentication+failed")
    })

    expect(accessToken()).toBeNull()
    expect(hasSession()).toBe(false)
  })

  it("redirects to login when state param is missing", async () => {
    window.history.replaceState({}, "", "/login/oauth-complete?code=test-code")

    renderWithRouter()

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login")
      expect(window.location.search).toBe("?error=OAuth+authentication+failed")
    })

    expect(accessToken()).toBeNull()
  })

  it("redirects to login when state param mismatches", async () => {
    window.history.replaceState({}, "", "/login/oauth-complete?code=test-code&state=wrong-state")

    renderWithRouter()

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login")
      expect(window.location.search).toBe("?error=OAuth+authentication+failed")
    })

    expect(accessToken()).toBeNull()
  })

  it("redirects to login when exchange fails", async () => {
    postMock.mockRejectedValueOnce(new Error("Invalid or expired code"))

    window.history.replaceState(
      {},
      "",
      `/login/oauth-complete?code=expired-code&state=${TEST_STATE}`,
    )

    renderWithRouter()

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login")
      expect(window.location.search).toBe("?error=OAuth+authentication+failed")
    })

    expect(accessToken()).toBeNull()
  })

  it("redirects to login on network error", async () => {
    postMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    window.history.replaceState({}, "", `/login/oauth-complete?code=test-code&state=${TEST_STATE}`)

    renderWithRouter()

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login")
      expect(window.location.search).toBe("?error=OAuth+authentication+failed")
    })
  })
})

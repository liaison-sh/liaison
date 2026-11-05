// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setChallengeToken } from "~/modules/auth/auth-store"
import TotpVerify from "~/modules/auth/TotpVerify"

function renderWithRouter() {
  return render(() => (
    <Router>
      <Route path="*" component={TotpVerify} />
    </Router>
  ))
}

describe("TotpVerify", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    // Set a challenge token so the page doesn't redirect
    setChallengeToken("test-challenge-token")
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearAuth()
  })

  it("renders TOTP heading", () => {
    renderWithRouter()
    expect(screen.getByText("Two-factor authentication")).toBeInTheDocument()
  })

  it("renders 6-digit code input", () => {
    renderWithRouter()
    const input = screen.getByPlaceholderText("000000")
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute("maxLength", "6")
  })

  it("shows recovery code toggle", () => {
    renderWithRouter()
    expect(screen.getByText(/use recovery code/i)).toBeInTheDocument()
  })

  it("toggles to recovery code input", async () => {
    renderWithRouter()
    fireEvent.click(screen.getByText(/use recovery code/i))
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/recovery code/i)).toBeInTheDocument()
    })
  })

  it("displays error on invalid code", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Invalid TOTP code" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    )

    renderWithRouter()
    const input = screen.getByPlaceholderText("000000")
    fireEvent.input(input, { target: { value: "123456" } })

    await waitFor(() => {
      expect(screen.getByText(/invalid code/i)).toBeInTheDocument()
    })
  })

  it("returns to the original destination after successful verification", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { accessToken: "access-token", refreshToken: "refresh-token" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    window.history.pushState({}, "", "/login/totp?returnTo=%2Fsettings%2Fsecurity")

    renderWithRouter()
    const input = screen.getByPlaceholderText("000000")
    fireEvent.input(input, { target: { value: "123456" } })

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/security")
    })
  })
})

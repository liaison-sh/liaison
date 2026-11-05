// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ResetPasswordConfirm from "~/modules/auth/ResetPasswordConfirm"

function renderWithRouter(url = "/reset-password?token=valid-token") {
  window.history.replaceState({}, "", url)
  return render(() => (
    <Router>
      <Route path="*" component={ResetPasswordConfirm} />
    </Router>
  ))
}

describe("ResetPasswordConfirm", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState({}, "", "/")
  })

  it("renders the reset form with password fields when token is present", () => {
    renderWithRouter()
    expect(screen.getByText("Set new password")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /reset password/i })).toBeInTheDocument()
    // Two password inputs (new + confirm)
    const passwordInputs = screen.getAllByPlaceholderText("••••••••")
    expect(passwordInputs).toHaveLength(2)
  })

  it("shows error message when token param is missing", () => {
    renderWithRouter("/reset-password")
    expect(screen.getByText("Invalid reset link")).toBeInTheDocument()
    // Form should not be rendered
    expect(screen.queryByRole("button", { name: /reset password/i })).not.toBeInTheDocument()
  })

  it("shows validation error when password is too short", async () => {
    renderWithRouter()
    const [passwordInput, confirmInput] = screen.getAllByPlaceholderText("••••••••")
    fireEvent.input(passwordInput, { target: { value: "short" } })
    fireEvent.input(confirmInput, { target: { value: "short" } })
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }))

    await waitFor(() => {
      expect(screen.getByText("Password must be at least 8 characters")).toBeInTheDocument()
    })
    // Should not have made a fetch call
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows validation error when passwords do not match", async () => {
    renderWithRouter()
    const [passwordInput, confirmInput] = screen.getAllByPlaceholderText("••••••••")
    fireEvent.input(passwordInput, { target: { value: "validpassword1" } })
    fireEvent.input(confirmInput, { target: { value: "differentpassword" } })
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }))

    await waitFor(() => {
      expect(screen.getByText("Passwords do not match")).toBeInTheDocument()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("navigates to login on successful submission", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    renderWithRouter()
    const [passwordInput, confirmInput] = screen.getAllByPlaceholderText("••••••••")
    fireEvent.input(passwordInput, { target: { value: "newpassword123" } })
    fireEvent.input(confirmInput, { target: { value: "newpassword123" } })
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }))

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login")
      expect(window.location.search).toBe("?reset=success")
    })
  })

  it("displays server error message on API failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Token expired" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    )

    renderWithRouter()
    const [passwordInput, confirmInput] = screen.getAllByPlaceholderText("••••••••")
    fireEvent.input(passwordInput, { target: { value: "newpassword123" } })
    fireEvent.input(confirmInput, { target: { value: "newpassword123" } })
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }))

    await waitFor(() => {
      expect(screen.getByText("This reset link is invalid or has expired")).toBeInTheDocument()
    })
  })
})

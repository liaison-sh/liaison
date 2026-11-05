// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ResetPassword from "~/modules/auth/ResetPassword"

function renderWithRouter() {
  return render(() => (
    <Router>
      <Route path="*" component={ResetPassword} />
    </Router>
  ))
}

describe("ResetPassword", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders email input and submit button", () => {
    renderWithRouter()
    expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /send reset link/i })).toBeInTheDocument()
  })

  it("shows success message after submit (no email enumeration)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { message: "If the email exists, a reset link has been sent" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    renderWithRouter()
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "test@test.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }))

    await waitFor(() => {
      expect(screen.getByText(/reset link has been sent/i)).toBeInTheDocument()
    })
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth } from "~/modules/auth/auth-store"
import Register from "~/modules/auth/Register"

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

function renderWithRouter() {
  // Start at /register so the "/" Home route doesn't match initially
  window.history.pushState(null, "", "/register")
  return render(() => (
    <Router>
      <Route path="/" component={() => <div>Home</div>} />
      <Route path="*" component={Register} />
    </Router>
  ))
}

describe("Register", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    clearAuth()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders a name field and no password fields (passwordless)", () => {
    renderWithRouter()
    expect(screen.getByPlaceholderText("Your name")).toBeInTheDocument()
    expect(screen.queryByPlaceholderText("••••••••")).not.toBeInTheDocument()
  })

  it("shows email field in bootstrap mode (no invite token)", () => {
    renderWithRouter()
    expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument()
  })

  it("successful passwordless registration sets tokens and navigates to /", async () => {
    const jwt = [
      btoa(JSON.stringify({ alg: "HS256" })),
      btoa(
        JSON.stringify({
          userId: "u1",
          orgId: "o1",
          name: "Test User",
          roles: [],
          scopes: [],
          dimensionGrants: {},
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
      "sig",
    ].join(".")
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { bootstrapped: false } }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { accessToken: jwt } }))
    renderWithRouter()
    fireEvent.input(screen.getByPlaceholderText("Your name"), { target: { value: "Test User" } })
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "test@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create account/i }))

    await waitFor(() => {
      expect(screen.getByText("Home")).toBeInTheDocument()
    })
  })

  it("displays an error when registration is rejected", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { bootstrapped: false } }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid" } }, 400))
    renderWithRouter()
    fireEvent.input(screen.getByPlaceholderText("Your name"), { target: { value: "User" } })
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "test@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create account/i }))

    await waitFor(() => {
      expect(screen.getByText(/invalid registration details/i)).toBeInTheDocument()
    })
  })

  it("asks for the setup token up front when the fresh instance requires one, and sends it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { bootstrapped: false, setupTokenRequired: true } }),
    )
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid" } }, 400))
    renderWithRouter()
    const input = (await screen.findByTestId("setup-token-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "abc123" } })
    fireEvent.input(screen.getByPlaceholderText("Your name"), { target: { value: "User" } })
    fireEvent.input(screen.getByPlaceholderText("you@company.com"), {
      target: { value: "test@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create account/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))
    expect(body.setupToken).toBe("abc123")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import DeviceApproval from "~/modules/auth/DeviceApproval"

const { postMock, getMock } = vi.hoisted(() => ({ postMock: vi.fn(), getMock: vi.fn() }))

vi.mock("~/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api-client")>("~/lib/api-client")
  return { ...actual, createApiClient: () => ({ post: postMock, get: getMock }) }
})

/** A token that never expires, so `ensureFreshToken` is a no-op in the card. */
function signIn() {
  const payload = {
    sub: "user-1",
    orgId: "org-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "")
  setTokens(`${b64({ alg: "none" })}.${b64(payload)}.sig`)
}

function renderAt(url: string) {
  window.history.replaceState({}, "", url)
  return render(() => (
    <Router>
      <Route path="/auth/device" component={DeviceApproval} />
      <Route path="/login" component={() => <div data-testid="login-stub" />} />
    </Router>
  ))
}

const scoped = {
  clientId: "liaison-desktop",
  kind: "session",
  deviceLabel: "Ada's laptop, macOS",
  scopes: ["threads:read", "knowledge:read"],
  agent: null,
  agentInvalid: false,
  fullAccess: false,
  requestIp: "203.0.113.9",
  expiresAt: "2030-01-01T00:00:00.000Z",
}

describe("DeviceApproval", () => {
  beforeEach(() => {
    clearAuth()
    postMock.mockReset()
    getMock.mockReset()
    getMock.mockResolvedValue(scoped)
  })

  afterEach(() => {
    clearAuth()
    vi.restoreAllMocks()
    window.history.replaceState({}, "", "/")
  })

  it("renders the code from the query string", async () => {
    signIn()
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    const input = (await findByTestId("device-approval-code-input")) as HTMLInputElement
    expect(input.value).toBe("TC9NYDAJ")
  })

  it("approves through the device-flow approve endpoint and shows the approved state", async () => {
    signIn()
    postMock.mockResolvedValueOnce({ approved: true, clientId: "liaison-desktop" })
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    await findByTestId("device-approval-details")
    fireEvent.click(await findByTestId("device-approval-approve"))

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/auth/device-flow/approve/TC9NYDAJ",
        {},
        { suppressGlobalError: true },
      )
    })
    const approved = await findByTestId("device-approval-approved")
    expect(approved.textContent).toContain("Approved. You can go back to the app.")
    expect(approved.textContent).toContain("liaison-desktop")
  })

  it("denies through the device-flow deny endpoint and shows the denied state", async () => {
    signIn()
    postMock.mockResolvedValueOnce({ denied: true })
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    fireEvent.click(await findByTestId("device-approval-deny"))

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/auth/device-flow/deny/TC9NYDAJ",
        {},
        { suppressGlobalError: true },
      )
    })
    const denied = await findByTestId("device-approval-denied")
    expect(denied.textContent).toContain("Denied. No session was started.")
  })

  it("shows the error state when the server rejects the code", async () => {
    signIn()
    postMock.mockRejectedValueOnce(
      new ApiError("Pending device flow request not found", 404, "not_found"),
    )
    const { findByTestId } = renderAt("/auth/device?code=AAAA2345")
    await findByTestId("device-approval-details")
    fireEvent.click(await findByTestId("device-approval-approve"))

    const error = await findByTestId("device-approval-error")
    expect(error.textContent).toBe("That code is not valid or has expired.")
  })

  // The server mints codes from "23456789ABCDEFGHJKLMNPQRSTUVWXYZ": an O is a
  // misread of a 0 that is not in it either. Approve and deny are brute-force
  // limited per user code, so a typo must not spend a strike.
  it("refuses a code carrying a glyph the server never mints, with no request", async () => {
    signIn()
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAO")
    fireEvent.click(await findByTestId("device-approval-approve"))

    const error = await findByTestId("device-approval-error")
    expect(error.textContent).toBe("That code is not valid or has expired.")
    expect(postMock).not.toHaveBeenCalled()
    expect(getMock).not.toHaveBeenCalled()
  })

  it("names the session, not the code, when the token lapsed mid approval", async () => {
    signIn()
    postMock.mockRejectedValueOnce(new ApiError("Unauthorized", 401, "unauthorized"))
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    await findByTestId("device-approval-details")
    fireEvent.click(await findByTestId("device-approval-approve"))

    const error = await findByTestId("device-approval-error")
    expect(error.textContent).toBe("Your session ended. Sign in again to approve this device.")
    const link = (await findByTestId("device-approval-signin-again")) as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe(
      `/login?returnTo=${encodeURIComponent("/auth/device?code=TC9NYDAJ")}`,
    )
  })

  it("sends a signed-out visitor to login with returnTo preserved", async () => {
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    await findByTestId("login-stub")
    expect(window.location.pathname).toBe("/login")
    expect(new URLSearchParams(window.location.search).get("returnTo")).toBe(
      "/auth/device?code=TC9NYDAJ",
    )
  })

  it("shows the client, device label, source IP and scopes before Approve, marked unverified", async () => {
    signIn()
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    await findByTestId("device-approval-details")
    expect(getMock).toHaveBeenCalledWith("/auth/device-flow/pending/TC9NYDAJ", {
      suppressGlobalError: true,
    })
    expect((await findByTestId("device-approval-client")).textContent).toBe("liaison-desktop")
    expect((await findByTestId("device-approval-device")).textContent).toBe("Ada's laptop, macOS")
    expect((await findByTestId("device-approval-ip")).textContent).toBe("203.0.113.9")
    expect((await findByTestId("device-approval-scopes")).textContent).toContain("knowledge:read")
    expect((await findByTestId("device-approval-unverified")).textContent).toContain("Unverified")
  })

  it("keeps Approve disabled until the request has loaded", async () => {
    signIn()
    getMock.mockReturnValue(new Promise(() => {}))
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    const approve = (await findByTestId("device-approval-approve")) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    fireEvent.click(approve)
    expect(postMock).not.toHaveBeenCalled()
  })

  it("requires an explicit confirmation for an unscoped (full access) request", async () => {
    signIn()
    getMock.mockResolvedValue({ ...scoped, scopes: [], fullAccess: true })
    postMock.mockResolvedValueOnce({ approved: true, clientId: "liaison-desktop" })
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    await findByTestId("device-approval-full-access")
    const approve = (await findByTestId("device-approval-approve")) as HTMLButtonElement
    expect(approve.disabled).toBe(true)

    fireEvent.click(await findByTestId("device-approval-confirm-full"))
    await waitFor(() => expect(approve.disabled).toBe(false))
    fireEvent.click(approve)
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/auth/device-flow/approve/TC9NYDAJ",
        { confirmFullAccess: true },
        { suppressGlobalError: true },
      )
    })
  })

  it("names the agent an MCP grant is bound to instead of a scope list", async () => {
    signIn()
    getMock.mockResolvedValue({
      ...scoped,
      kind: "mcp",
      scopes: [],
      agent: { id: "a-1", name: "Support agent" },
    })
    const { findByTestId, queryByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    expect((await findByTestId("device-approval-agent")).textContent).toContain("Support agent")
    expect(queryByTestId("device-approval-scopes")).toBeNull()
    expect(queryByTestId("device-approval-full-access")).toBeNull()
    const approve = (await findByTestId("device-approval-approve")) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
  })

  it("never enables Approve for a grant naming an agent the org does not have", async () => {
    signIn()
    getMock.mockResolvedValue({ ...scoped, kind: "mcp", scopes: [], agentInvalid: true })
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    await findByTestId("device-approval-agent-invalid")
    const approve = (await findByTestId("device-approval-approve")) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
  })
  // An MCP connection bound to no agent carries the approver's whole access:
  // approving it also takes a fresh step-up (an emailed code, never a password),
  // which the server enforces. The card emails the code by itself as soon as it
  // shows the step-up, once per page view, and again only when asked.
  it("emails the code by itself for a full-access MCP grant, with no password field", async () => {
    signIn()
    getMock.mockResolvedValue({ ...scoped, kind: "mcp", scopes: [], fullAccess: true })
    postMock.mockResolvedValueOnce({ sent: true, retryAfterSeconds: 60 })
    postMock.mockResolvedValueOnce({ approved: true, clientId: "claude-code" })
    const { findByTestId, container } = renderAt("/auth/device?code=TC9NYDAJ")
    const block = await findByTestId("device-approval-step-up")
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        "/auth/totp/step-up",
        { purpose: "mcp_connect" },
        { suppressGlobalError: true },
      ),
    )
    expect((await findByTestId("device-approval-code-sent")).textContent).toBe(
      "We emailed you a code.",
    )
    expect(block.textContent).toContain(
      "Full access needs one more confirmation: a code we email you.",
    )
    expect(block.textContent).toContain(
      "No code arrived? Check your spam folder, or send a new one.",
    )
    // No password anywhere, no form: nothing a browser fills with saved credentials.
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(container.querySelector("form")).toBeNull()
    const codeInput = (await findByTestId("device-approval-step-up-code")) as HTMLInputElement
    expect(codeInput.getAttribute("autocomplete")).toBe("one-time-code")
    expect(codeInput.getAttribute("inputmode")).toBe("numeric")
    expect(codeInput.getAttribute("name")).toBe("code")
    await waitFor(() => expect(document.activeElement).toBe(codeInput))
    // The resend waits for the cooldown, and says when it can go.
    const resend = (await findByTestId("device-approval-resend")) as HTMLButtonElement
    expect(resend.disabled).toBe(true)
    expect((await findByTestId("device-approval-resend-wait")).textContent).toBe(
      "You can send a new one in 60 s.",
    )

    const approve = (await findByTestId("device-approval-approve")) as HTMLButtonElement
    fireEvent.click(await findByTestId("device-approval-confirm-full"))
    // Confirmed, but no code yet: still not approvable.
    expect(approve.disabled).toBe(true)
    fireEvent.input(codeInput, { target: { value: "123456" } })
    await waitFor(() => expect(approve.disabled).toBe(false))
    fireEvent.click(approve)
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/auth/device-flow/approve/TC9NYDAJ",
        { confirmFullAccess: true, stepUpCode: "123456" },
        { suppressGlobalError: true },
      )
    })
    await findByTestId("device-approval-approved")
    // One email for the page view.
    expect(postMock.mock.calls.filter((c) => c[0] === "/auth/totp/step-up")).toHaveLength(1)
  })

  it("sends a new code on request once the cooldown is over", async () => {
    signIn()
    getMock.mockResolvedValue({ ...scoped, kind: "mcp", scopes: [], fullAccess: true })
    postMock.mockResolvedValueOnce({ sent: true, retryAfterSeconds: 0 })
    postMock.mockResolvedValueOnce({ sent: true, retryAfterSeconds: 60 })
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    const resend = (await findByTestId("device-approval-resend")) as HTMLButtonElement
    await waitFor(() => expect(resend.disabled).toBe(false))
    fireEvent.click(resend)
    await waitFor(() =>
      expect(postMock.mock.calls.filter((c) => c[0] === "/auth/totp/step-up")).toHaveLength(2),
    )
    await waitFor(() => expect(resend.disabled).toBe(true))
  })

  it("shows the error and the resend when the automatic send fails", async () => {
    signIn()
    getMock.mockResolvedValue({ ...scoped, kind: "mcp", scopes: [], fullAccess: true })
    postMock.mockRejectedValueOnce(new ApiError("boom", 500))
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    const error = await findByTestId("device-approval-error")
    expect(error.textContent).toBe("The code could not be sent. Send a new one to try again.")
    const resend = (await findByTestId("device-approval-resend")) as HTMLButtonElement
    await waitFor(() => expect(resend.disabled).toBe(false))
  })

  it("asks for the step-up when the server refuses the approval without one, then retries", async () => {
    signIn()
    getMock.mockResolvedValue({ ...scoped, scopes: [], fullAccess: true })
    postMock.mockRejectedValueOnce(new ApiError("Provide stepUpCode", 400, "STEP_UP_REQUIRED"))
    const { findByTestId, queryByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    await findByTestId("device-approval-full-access")
    expect(queryByTestId("device-approval-step-up")).toBeNull()
    fireEvent.click(await findByTestId("device-approval-confirm-full"))
    const approve = (await findByTestId("device-approval-approve")) as HTMLButtonElement
    await waitFor(() => expect(approve.disabled).toBe(false))
    // The refusal shows the step-up, which emails the code by itself.
    postMock.mockResolvedValueOnce({ sent: true, retryAfterSeconds: 60 })
    fireEvent.click(approve)
    await findByTestId("device-approval-step-up")
    await findByTestId("device-approval-code-sent")
    const codeInput = (await findByTestId("device-approval-step-up-code")) as HTMLInputElement
    fireEvent.input(codeInput, { target: { value: "654321" } })
    postMock.mockResolvedValueOnce({ approved: true, clientId: "liaison-desktop" })
    await waitFor(() => expect(approve.disabled).toBe(false))
    fireEvent.click(approve)
    await waitFor(() => {
      expect(postMock).toHaveBeenLastCalledWith(
        "/auth/device-flow/approve/TC9NYDAJ",
        { confirmFullAccess: true, stepUpCode: "654321" },
        { suppressGlobalError: true },
      )
    })
    await findByTestId("device-approval-approved")
  })

  it("says a refused code was not accepted, not that the device code is invalid", async () => {
    signIn()
    getMock.mockResolvedValue({ ...scoped, kind: "mcp", scopes: [], fullAccess: true })
    postMock.mockResolvedValueOnce({ sent: true, retryAfterSeconds: 60 })
    postMock.mockRejectedValueOnce(new ApiError("Invalid or expired step-up code", 422))
    const { findByTestId } = renderAt("/auth/device?code=TC9NYDAJ")
    fireEvent.click(await findByTestId("device-approval-confirm-full"))
    await findByTestId("device-approval-code-sent")
    const codeInput = (await findByTestId("device-approval-step-up-code")) as HTMLInputElement
    fireEvent.input(codeInput, { target: { value: "000000" } })
    const approve = (await findByTestId("device-approval-approve")) as HTMLButtonElement
    await waitFor(() => expect(approve.disabled).toBe(false))
    fireEvent.click(approve)
    const error = await findByTestId("device-approval-error")
    expect(error.textContent).toBe("That code was not accepted. Check it, or send a new one.")
  })
})

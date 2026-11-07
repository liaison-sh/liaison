// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { accessToken, clearAuth, hasSession } from "~/modules/auth/auth-store"
import MagicLinkVerify from "~/modules/auth/MagicLinkVerify"

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }))

vi.mock("~/lib/api-client", () => ({
  anonApiClient: { post: postMock },
}))

function renderPage() {
  return render(() => (
    <Router>
      <Route path="*" component={MagicLinkVerify} />
    </Router>
  ))
}

describe("MagicLinkVerify", () => {
  beforeEach(() => {
    clearAuth()
    postMock.mockReset()
    window.history.replaceState({}, "", "/login/magic?challengeId=c1&token=t1")
  })

  afterEach(() => {
    clearAuth()
    vi.restoreAllMocks()
    window.history.replaceState({}, "", "/")
  })

  it("signs an emailed link in at once (one call, no Continue)", async () => {
    postMock.mockResolvedValueOnce({ accessToken: "at-1" })
    renderPage()
    await waitFor(() => expect(accessToken()).toBe("at-1"), { timeout: 15000 })
    expect(postMock).toHaveBeenCalledTimes(1)
    expect(postMock).toHaveBeenCalledWith("/auth/magic-link/verify", {
      challengeId: "c1",
      token: "t1",
    })
  })

  it("for a handoff link, names the workspace and the account and signs in only on Continue", async () => {
    postMock.mockResolvedValueOnce({
      confirmRequired: true,
      workspace: { name: "Acme Tools", slug: "acme-tools" },
      account: { email: "owner@acme.test", name: "Olive Owner" },
    })
    const page = renderPage()
    const card = await page.findByTestId("magic-link-confirm", {}, { timeout: 15000 })
    expect(card.textContent).toContain("Acme Tools")
    expect(card.textContent).toContain("owner@acme.test")
    expect(postMock).toHaveBeenCalledTimes(1)
    expect(hasSession()).toBe(false)

    postMock.mockResolvedValueOnce({ accessToken: "at-handoff" })
    fireEvent.click(page.getByTestId("magic-link-continue"))
    await waitFor(() => expect(accessToken()).toBe("at-handoff"), { timeout: 15000 })
    expect(postMock).toHaveBeenLastCalledWith("/auth/magic-link/verify", {
      challengeId: "c1",
      token: "t1",
      confirm: true,
    })
  })

  it("a refused Continue shows the invalid-link message and no session", async () => {
    postMock.mockResolvedValueOnce({
      confirmRequired: true,
      workspace: { name: "Acme Tools", slug: "acme-tools" },
      account: { email: "owner@acme.test", name: "Olive Owner" },
    })
    const page = renderPage()
    await page.findByTestId("magic-link-continue", {}, { timeout: 15000 })
    postMock.mockRejectedValueOnce(new Error("401"))
    fireEvent.click(page.getByTestId("magic-link-continue"))
    await page.findByTestId("magic-link-invalid", {}, { timeout: 15000 })
    expect(hasSession()).toBe(false)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// "Delete my account" (spec S19): the dialog explains what goes and what stays,
// sends the emailed code, takes the code, and signs out on success. The last
// admin refusal and a wrong code are shown in words, and nobody is signed out.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { logoutMock, nativeServersMock } = vi.hoisted(() => ({
  logoutMock: vi.fn(async () => {}),
  nativeServersMock: vi.fn((): { signOut: () => Promise<void> } | null => null),
}))

vi.mock("~/modules/auth/createAuthManager", () => ({
  authManager: { logout: logoutMock, ensureFreshToken: vi.fn() },
}))
vi.mock("~/lib/native-bridge", () => ({ nativeServers: nativeServersMock }))

import { takeAccountDeletedNotice } from "~/modules/auth/account-deleted-notice"
import DeleteAccountSection from "~/modules/settings/DeleteAccountSection"
import { ApiProvider } from "~/modules/shell/ApiContext"

type Reply = { status: number; body: unknown }

function json(reply: Reply): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "Content-Type": "application/json" },
  })
}

function stubServer(replies: { stepUp?: Reply; del?: Reply }) {
  const calls: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, body })
      if (url.includes("/auth/totp/step-up")) {
        return json(replies.stepUp ?? { status: 200, body: { data: { sent: true } } })
      }
      if (url.includes("/auth/account/delete")) {
        return json(replies.del ?? { status: 200, body: { data: { deleted: true } } })
      }
      return json({ status: 200, body: { data: {} } })
    }),
  )
  return calls
}

function Wrapped() {
  return (
    <ApiProvider>
      <DeleteAccountSection />
    </ApiProvider>
  )
}

function renderSection() {
  render(() => (
    <Router>
      <Route path="*" component={Wrapped} />
    </Router>
  ))
}

async function openAndSendCode() {
  fireEvent.click(screen.getByRole("button", { name: "Delete my account" }))
  await screen.findByText("What is deleted")
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }))
  await screen.findByLabelText("Code from the email")
}

async function submitCode(code: string) {
  fireEvent.input(screen.getByLabelText("Code from the email"), { target: { value: code } })
  fireEvent.click(screen.getByRole("button", { name: "Delete my account for good" }))
}

describe("DeleteAccountSection", () => {
  beforeEach(() => {
    logoutMock.mockClear()
    nativeServersMock.mockReset()
    nativeServersMock.mockReturnValue(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("explains what is deleted, what stays, and that other organisations are untouched", async () => {
    stubServer({})
    renderSection()
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }))
    expect(await screen.findByText("What is deleted")).toBeInTheDocument()
    expect(screen.getByText("What stays")).toBeInTheDocument()
    expect(screen.getByText(/stays in the organisation without your name/)).toBeInTheDocument()
    expect(screen.getByText(/other organisations are not affected/)).toBeInTheDocument()
    expect(screen.getByText(/A password is not enough/)).toBeInTheDocument()
  })

  it("sends the code for the account deletion, deletes with it, and signs out", async () => {
    const calls = stubServer({})
    renderSection()
    await openAndSendCode()
    expect(calls.find((c) => c.url.includes("/totp/step-up"))?.body).toEqual({
      purpose: "account_delete",
    })
    await submitCode("123456")
    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1))
    expect(calls.find((c) => c.url.includes("/account/delete"))?.body).toEqual({
      stepUpCode: "123456",
    })
  })

  it("in the mobile shell, signs out through the shell so it forgets the server session", async () => {
    // The sign-in card the shell reloads to says the account was deleted: the
    // mark is down before the shell signs out and starts the page again.
    let markedBeforeSignOut: boolean | null = null
    const signOut = vi.fn(async () => {
      markedBeforeSignOut = takeAccountDeletedNotice()
    })
    nativeServersMock.mockReturnValue({ signOut })
    stubServer({})
    renderSection()
    await openAndSendCode()
    await submitCode("123456")
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    expect(markedBeforeSignOut).toBe(true)
    expect(logoutMock).not.toHaveBeenCalled()
  })

  it("shows the last admin refusal in words and does not sign out", async () => {
    stubServer({
      del: {
        status: 409,
        body: { error: { code: "CONFLICT", message: "You are the only admin" } },
      },
    })
    renderSection()
    await openAndSendCode()
    await submitCode("123456")
    expect(await screen.findByText(/only admin of this organisation/)).toBeInTheDocument()
    expect(screen.getByText(/Make another member an admin/)).toBeInTheDocument()
    expect(logoutMock).not.toHaveBeenCalled()
  })

  it("shows a wrong code in words and does not sign out", async () => {
    stubServer({
      // The body the API sends (assertStepUp's HTTPException through errorHandler).
      del: {
        status: 422,
        body: { error: { code: "INVALID_ARGUMENT", message: "Invalid or expired step-up code" } },
      },
    })
    renderSection()
    await openAndSendCode()
    await submitCode("000000")
    expect(await screen.findByText(/That code is wrong or has expired/)).toBeInTheDocument()
    expect(logoutMock).not.toHaveBeenCalled()
  })

  // Ten attempts an hour (a run of failed deletions counts) answer 429, which
  // read as "could not be deleted, try again later" with no hint of when.
  it("says too many attempts when the deletion is rate limited, and does not sign out", async () => {
    stubServer({
      del: {
        status: 429,
        body: { error: { code: "RATE_LIMITED", message: "Too many account deletion attempts" } },
      },
    })
    renderSection()
    await openAndSendCode()
    await submitCode("000000")
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument()
    expect(screen.queryByText(/could not be deleted/)).toBeNull()
    expect(logoutMock).not.toHaveBeenCalled()
  })

  it("shows the code in the dialog only when the server returns one (demo reviewer)", async () => {
    stubServer({ stepUp: { status: 200, body: { data: { sent: true, demoCode: "424242" } } } })
    renderSection()
    await openAndSendCode()
    expect(screen.getByText("Demo account: your code is 424242")).toBeInTheDocument()
  })

  it("shows no demo line for a normal account", async () => {
    stubServer({})
    renderSection()
    await openAndSendCode()
    expect(screen.queryByText(/Demo account/)).toBeNull()
  })
})

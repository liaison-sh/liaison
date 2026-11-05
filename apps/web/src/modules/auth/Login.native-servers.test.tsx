// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SIGN-IN SCREEN IS NOT A DEAD END ON THE PHONE. "Add a server" lands the
// app on the new server's sign-in card; a user who added the wrong one, or who
// cannot sign in there, must be able to go back to another saved server, or
// drop this one, from that card. A browser (and the desktop) gets none of it.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL, type NativeServers } from "~/lib/native-bridge"
import { markAccountDeleted, takeAccountDeletedNotice } from "~/modules/auth/account-deleted-notice"
import { clearAuth } from "~/modules/auth/auth-store"
import Login from "~/modules/auth/Login"
import { _resetBranding } from "~/modules/shell/branding-store"

const CURRENT = "https://liaison.example.com"
const OTHER = "https://demo.example.com"

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

function renderLogin() {
  return render(() => (
    <Router>
      <Route path="*" component={Login} />
    </Router>
  ))
}

function publish(saved: string[] = [CURRENT, OTHER]): NativeServers {
  const servers: NativeServers = {
    list: vi.fn(async () => ({
      current: CURRENT,
      servers: saved.map((address) => ({ address, label: null })),
    })),
    add: vi.fn(async () => {}),
    switchTo: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }
  ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = { servers }
  return servers
}

describe("Login: the phone's saved servers", () => {
  beforeEach(() => {
    clearAuth()
    _resetBranding()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [] })),
    )
    window.history.replaceState(null, "", "/login")
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
    clearAuth()
    _resetBranding()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.history.replaceState(null, "", "/")
  })

  it("names the current server and switches to another saved one", async () => {
    const servers = publish()
    renderLogin()
    expect(await screen.findByText("Signing in to liaison.example.com")).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: "Use demo.example.com instead" }))
    await waitFor(() => expect(servers.switchTo).toHaveBeenCalledWith(OTHER))
    expect(servers.switchTo).toHaveBeenCalledTimes(1)
  })

  it("removes the current server only after a confirmation", async () => {
    const servers = publish()
    renderLogin()
    fireEvent.click(await screen.findByRole("button", { name: "Remove this server" }))
    expect(servers.remove).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("login-server-remove-confirm"))
    await waitFor(() => expect(servers.remove).toHaveBeenCalledWith(CURRENT))
  })

  it("offers no removal when this is the only saved server", async () => {
    publish([CURRENT])
    renderLogin()
    expect(await screen.findByText("Signing in to liaison.example.com")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove this server" })).toBeNull()
    expect(screen.queryByRole("button", { name: /instead/ })).toBeNull()
  })

  it("adds another server from the card even when this is the only saved one", async () => {
    const servers = publish([CURRENT])
    renderLogin()
    fireEvent.click(await screen.findByRole("button", { name: "Add a server" }))
    fireEvent.input(await screen.findByTestId("you-server-address"), {
      target: { value: "demo.example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(servers.add).toHaveBeenCalledWith(OTHER))
  })

  it("names the refusal when the address is not a Liaison server", async () => {
    const servers = publish([CURRENT])
    vi.mocked(servers.add).mockRejectedValueOnce(new Error("NotALiaisonServer"))
    renderLogin()
    fireEvent.click(await screen.findByRole("button", { name: "Add a server" }))
    fireEvent.input(await screen.findByTestId("you-server-address"), {
      target: { value: "example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That URL is not a Liaison org.")
  })

  // "Delete my account" on the phone ends on this card, for the same server,
  // saying why: never the browser's form, never "Create an account" (D3).
  it("after an account deletion, says so on the phone's card and offers no sign-up", async () => {
    publish()
    markAccountDeleted()
    renderLogin()
    expect(await screen.findByTestId("account-deleted-notice")).toHaveTextContent(
      "Your account was deleted.",
    )
    expect(await screen.findByTestId("login-servers")).toBeInTheDocument()
    expect(screen.queryByText("Create an account")).toBeNull()
    // Said once: the next visit to the sign-in is an ordinary one.
    expect(takeAccountDeletedNotice()).toBe(false)
  })

  it("shows nothing of it in a browser", async () => {
    renderLogin()
    expect(await screen.findByText("Continue with email")).toBeInTheDocument()
    expect(screen.queryByTestId("login-servers")).toBeNull()
    expect(screen.queryByText(/Signing in to/)).toBeNull()
  })
})

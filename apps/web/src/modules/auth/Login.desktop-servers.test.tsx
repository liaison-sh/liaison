// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DESKTOP'S SIGN-IN SCREEN IS NOT A DEAD END. A desktop that starts signed
// out, already bound to a server, used to offer nothing but the email form for
// that server: the Servers switcher and Settings are behind the sign-in, so a
// wrong server locked the user out. The card now names the server it signs in
// to and offers "Change server": another saved server, or a new address
// through the desktop's own connect step. A browser gets none of it.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopServers } from "~/lib/desktop-shell-contract"
import { clearAuth } from "~/modules/auth/auth-store"
import Login from "~/modules/auth/Login"
import {
  type FakeBridgeHandle,
  installFakeBridge,
  uninstallFakeBridge,
} from "~/modules/desktop/fake-bridge"
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

describe("Login: the desktop's server, on the sign-in card", () => {
  let shell: FakeBridgeHandle | null = null

  function desktop(saved: string[] = [CURRENT, OTHER]): DesktopServers {
    const servers: DesktopServers = {
      list: vi.fn(async () => ({
        current: CURRENT,
        servers: saved.map((address) => ({ address, label: null })),
      })),
      add: vi.fn(async () => {}),
      switchTo: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
      confirmsRemoval: true,
      // What the real shell does (account-menu.ts): the page's connect step.
      beginAdd: vi.fn(() => shell?.push({ addingServer: true })),
    }
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = CURRENT
    shell = installFakeBridge({}, { serverAddress: CURRENT, servers })
    return servers
  }

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
    delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
    uninstallFakeBridge()
    shell = null
    clearAuth()
    _resetBranding()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.history.replaceState(null, "", "/")
  })

  it("names the server and switches to another saved one through Change server", async () => {
    const servers = desktop()
    renderLogin()
    expect(await screen.findByTestId("login-server-current")).toHaveTextContent(
      "Signing in to liaison.example.com",
    )
    // The choices wait behind the one control: the email form stays the card.
    expect(screen.queryByTestId("login-server-switch")).toBeNull()
    fireEvent.click(screen.getByTestId("login-server-change"))
    const switches = await screen.findAllByTestId("login-server-switch")
    expect(switches).toHaveLength(1)
    expect(switches[0]).toHaveTextContent("Use demo.example.com instead")
    fireEvent.click(switches[0]!)
    await waitFor(() => expect(servers.switchTo).toHaveBeenCalledWith(OTHER))
    expect(servers.switchTo).toHaveBeenCalledTimes(1)
    // The shell confirms its own removals; the sign-in card offers none.
    expect(screen.queryByTestId("login-server-remove")).toBeNull()
  })

  it("adds a server through the desktop's connect step, even when it is the only one", async () => {
    const servers = desktop([CURRENT])
    renderLogin()
    fireEvent.click(await screen.findByTestId("login-server-change"))
    expect(screen.queryByTestId("login-server-switch")).toBeNull()
    fireEvent.click(await screen.findByTestId("login-server-add"))
    expect(servers.beginAdd).toHaveBeenCalledTimes(1)
    // The connect step replaces the card, and the servers block goes with it.
    expect(await screen.findByTestId("desktop-connect-address")).toBeInTheDocument()
    expect(screen.queryByTestId("login-servers")).toBeNull()
    expect(servers.add).not.toHaveBeenCalled()
  })

  it("shows nothing of it in a browser", async () => {
    renderLogin()
    expect(await screen.findByText("Continue with email")).toBeInTheDocument()
    expect(screen.queryByTestId("login-servers")).toBeNull()
    expect(screen.queryByTestId("login-server-change")).toBeNull()
  })
})

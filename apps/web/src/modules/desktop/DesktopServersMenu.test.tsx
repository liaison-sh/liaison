// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sidebar's account menu on the desktop: the saved servers with a check on
// the current one, then "Add a server...", the way a workspace switcher reads.
// It replaces the native Account menu on every OS: the shell draws none.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopServers } from "~/lib/desktop-shell-contract"
import DesktopServersMenu from "./DesktopServersMenu"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"

const A = "https://liaison.acme.example"
const B = "https://liaison.fabrikam.example"

function desktopServers(): DesktopServers {
  return {
    list: vi.fn(async () => ({
      current: A,
      servers: [
        { address: A, label: "Acme" },
        { address: B, label: null },
      ],
    })),
    add: vi.fn(async () => {}),
    switchTo: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    beginAdd: vi.fn(),
    confirmsRemoval: true,
  }
}

function open(): HTMLElement {
  const trigger = screen.getByTestId("activity-servers")
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  return trigger
}

describe("DesktopServersMenu", () => {
  afterEach(() => uninstallFakeBridge())

  it("is not there in a browser", () => {
    render(() => <DesktopServersMenu />)
    expect(screen.queryByTestId("activity-servers")).toBeNull()
  })

  it("lists every saved server with a check on the current one, then Add a server", async () => {
    installFakeBridge({}, { platform: "windows", servers: desktopServers() })
    render(() => <DesktopServersMenu />)
    open()
    const menu = await screen.findByTestId("servers-menu")
    const rows = await screen.findAllByTestId("servers-menu-row")
    expect(rows.map((row) => row.textContent)).toEqual(["Acme", "liaison.fabrikam.example"])
    expect(rows[0].getAttribute("aria-checked")).toBe("true")
    expect(rows[1].getAttribute("aria-checked")).toBe("false")
    expect(menu.textContent).toContain("Add a server…")
    // No raw id and no dash punctuation in what the menu says.
    expect(menu.textContent).not.toMatch(/[–—]/)
  })

  it("switches through the bridge, and not for the current server", async () => {
    const servers = desktopServers()
    installFakeBridge({}, { platform: "linux", servers })
    render(() => <DesktopServersMenu />)
    open()
    const rows = await screen.findAllByTestId("servers-menu-row")
    fireEvent.keyDown(rows[0], { key: "Enter" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(servers.switchTo).not.toHaveBeenCalled()
    if (!screen.queryByTestId("servers-menu")) open()
    fireEvent.keyDown((await screen.findAllByTestId("servers-menu-row"))[1], { key: "Enter" })
    await waitFor(() => expect(servers.switchTo).toHaveBeenCalledWith(B))
  })

  it("opens the connect step for Add a server", async () => {
    const servers = desktopServers()
    installFakeBridge({}, { platform: "windows", servers })
    render(() => <DesktopServersMenu />)
    open()
    fireEvent.keyDown(await screen.findByTestId("servers-menu-add"), { key: "Enter" })
    expect(servers.beginAdd).toHaveBeenCalledTimes(1)
  })
})

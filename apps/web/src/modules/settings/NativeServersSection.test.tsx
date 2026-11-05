// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone's saved servers, in the settings root. The shell (apps/mobile)
// publishes them on the native bridge; a browser has none and renders nothing.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopServers } from "~/lib/desktop-shell-contract"
import { NATIVE_BRIDGE_GLOBAL, type NativeServers } from "~/lib/native-bridge"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import NativeServersSection, { DesktopServersSection } from "./NativeServersSection"

const A = "https://liaison.acme.example"
const B = "https://liaison.fabrikam.example"

function publish(overrides: Partial<NativeServers> = {}): NativeServers {
  const servers: NativeServers = {
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
    ...overrides,
  }
  ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = { servers }
  return servers
}

describe("NativeServersSection", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  })

  it("renders nothing without the phone's shell", () => {
    render(() => <NativeServersSection />)
    expect(screen.queryByTestId("you-group-servers")).toBeNull()
  })

  it("lists every saved server by name, else host, with the current one checked", async () => {
    publish()
    render(() => <NativeServersSection />)
    const rows = await screen.findAllByTestId("you-server-row")
    expect(rows.map((row) => row.textContent)).toEqual(["Acme", "liaison.fabrikam.example"])
    expect(rows[0].getAttribute("aria-current")).toBe("true")
    expect(rows[1].getAttribute("aria-current")).toBeNull()
    expect(screen.getByLabelText("Current server")).toBeInTheDocument()
  })

  it("switches when another server is tapped, and not for the current one", async () => {
    const servers = publish()
    render(() => <NativeServersSection />)
    const rows = await screen.findAllByTestId("you-server-row")
    fireEvent.click(rows[0])
    fireEvent.click(rows[1])
    await waitFor(() => expect(servers.switchTo).toHaveBeenCalledWith(B))
    expect(servers.switchTo).toHaveBeenCalledTimes(1)
  })

  it("adds a server, and says why when the shell refuses it", async () => {
    const servers = publish({
      add: vi.fn(async (url: string) => {
        if (url.includes("example.com")) throw new Error("NotALiaisonServer")
      }),
    })
    render(() => <NativeServersSection />)
    fireEvent.click(await screen.findByTestId("you-server-add"))
    const field = screen.getByLabelText("Enter the URL of another Liaison org:")
    fireEvent.input(field, { target: { value: "https://example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() =>
      expect(screen.getByText("That URL is not a Liaison org.")).toBeInTheDocument(),
    )
    fireEvent.input(field, { target: { value: "https://liaison.local.test" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(servers.add).toHaveBeenLastCalledWith("https://liaison.local.test"))
  })

  it("takes a bare host, as a phone keyboard types it, and adds it over https", async () => {
    // Found on the simulator (2026-09-28): an <input type="url"> made iOS
    // refuse "liaison.acme.example" with "Enter a URL" before we ever saw it.
    const servers = publish()
    render(() => <NativeServersSection />)
    fireEvent.click(await screen.findByTestId("you-server-add"))
    const field = screen.getByTestId("you-server-address") as HTMLInputElement
    expect(field.type).toBe("text")
    expect(field.getAttribute("inputmode")).toBe("url")
    expect(field.getAttribute("autocapitalize")).toBe("none")
    expect(field.getAttribute("autocorrect")).toBe("off")
    expect(field.getAttribute("placeholder")).toBe("liaison.example.com")
    fireEvent.input(field, { target: { value: "  liaison.example.com/ " } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(servers.add).toHaveBeenCalledWith("https://liaison.example.com"))
  })

  it("refuses a single word without asking the shell", async () => {
    const servers = publish()
    render(() => <NativeServersSection />)
    fireEvent.click(await screen.findByTestId("you-server-add"))
    fireEvent.input(screen.getByTestId("you-server-address"), { target: { value: "liaison" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(servers.add).not.toHaveBeenCalled()
  })

  it("removes the current server only once the user confirmed", async () => {
    const servers = publish()
    render(() => <NativeServersSection />)
    fireEvent.click(await screen.findByTestId("you-server-remove"))
    expect(servers.remove).not.toHaveBeenCalled()
    expect(await screen.findByText(/Remove Acme\?/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("you-server-remove-confirm"))
    await waitFor(() => expect(servers.remove).toHaveBeenCalledWith(A))
  })

  it("signs out of the current server", async () => {
    const servers = publish()
    render(() => <NativeServersSection />)
    fireEvent.click(await screen.findByTestId("you-server-sign-out"))
    await waitFor(() => expect(servers.signOut).toHaveBeenCalledTimes(1))
  })
})

// The desktop shell publishes the same servers on its own bridge. On Windows
// and Linux this group (and the sidebar's account menu) is the only place to
// switch servers: the shell draws no menu strip in the window there.
describe("DesktopServersSection", () => {
  function desktopServers(overrides: Partial<DesktopServers> = {}): DesktopServers {
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
      ...overrides,
    }
  }

  afterEach(() => uninstallFakeBridge())

  it("renders nothing in a browser, nor under a shell that publishes no servers", () => {
    render(() => <DesktopServersSection />)
    expect(screen.queryByTestId("you-group-servers")).toBeNull()
    uninstallFakeBridge()
    installFakeBridge({}, { platform: "windows" })
    render(() => <DesktopServersSection />)
    expect(screen.queryByTestId("you-group-servers")).toBeNull()
  })

  it("lists the desktop's saved servers and switches through the bridge", async () => {
    const servers = desktopServers()
    installFakeBridge({}, { platform: "windows", servers })
    render(() => <DesktopServersSection />)
    const rows = await screen.findAllByTestId("you-server-row")
    expect(rows.map((row) => row.textContent)).toEqual(["Acme", "liaison.fabrikam.example"])
    expect(rows[0].getAttribute("aria-current")).toBe("true")
    fireEvent.click(rows[1])
    await waitFor(() => expect(servers.switchTo).toHaveBeenCalledWith(B))
  })

  it("leaves the removal question to the shell's own dialog", async () => {
    const servers = desktopServers()
    installFakeBridge({}, { platform: "linux", servers })
    render(() => <DesktopServersSection />)
    fireEvent.click(await screen.findByTestId("you-server-remove"))
    await waitFor(() => expect(servers.remove).toHaveBeenCalledWith(A))
    expect(screen.queryByTestId("you-server-remove-confirm")).toBeNull()
  })

  it("opens the shell's connect step for Add a server", async () => {
    const servers = desktopServers()
    installFakeBridge({}, { platform: "windows", servers })
    render(() => <DesktopServersSection />)
    fireEvent.click(await screen.findByTestId("you-server-add"))
    expect(servers.beginAdd).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("you-server-address")).toBeNull()
  })
})

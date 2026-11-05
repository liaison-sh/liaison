// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The saved servers, published on the desktop bridge for the page's own
// servers UI (Settings and the sidebar's account menu). On Windows and Linux
// that UI is the only place to switch servers: the shell draws no menu strip
// in the window there. Every member is one of the shell's own commands.

import { afterEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
}))

vi.mock("../tauri", () => ({
  invoke,
  listen: async () => () => undefined,
}))

import { publishDesktopBridge, resetDesktopBridge } from "../bridge"
import { buildDesktopServers } from "./desktop-servers"
import { resetServerSwitch, setPageReloader } from "./server-switch"

const A = "https://liaison.acme.example"
const B = "https://liaison.fabrikam.example"

describe("the desktop bridge's servers", () => {
  afterEach(() => {
    invoke.mockReset()
    resetDesktopBridge()
    resetServerSwitch()
    localStorage.clear()
  })

  it("are published on the bridge with every member the page's group needs", () => {
    const bridge = publishDesktopBridge({})
    const servers = bridge.servers
    expect(servers).toBeDefined()
    for (const name of ["list", "add", "switchTo", "remove", "signOut", "beginAdd"] as const) {
      expect(typeof servers?.[name]).toBe("function")
    }
    // The shell asks its own native question before a removal.
    expect(servers?.confirmsRemoval).toBe(true)
  })

  it("list the shell's saved list, a server with no name yet labelled null", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "list_servers") {
        return { current: B, servers: [{ address: A, label: "Acme" }, { address: B }] }
      }
      return undefined
    })
    const listed = await buildDesktopServers().list()
    expect(invoke).toHaveBeenCalledWith("list_servers")
    expect(listed).toEqual({
      current: B,
      servers: [
        { address: A, label: "Acme" },
        { address: B, label: null },
      ],
    })
  })

  it("answer an empty list when the shell has none to give", async () => {
    invoke.mockRejectedValue(new Error("older shell"))
    expect(await buildDesktopServers().list()).toEqual({ current: null, servers: [] })
  })

  it("switch through the shell's switch_server, handing over the page's storage", async () => {
    const reload = vi.fn()
    setPageReloader(reload)
    invoke.mockImplementation(async (command: string) =>
      command === "switch_server" ? { address: B, storage: {} } : undefined,
    )
    await buildDesktopServers().switchTo(B)
    expect(invoke).toHaveBeenCalledWith(
      "switch_server",
      expect.objectContaining({ address: B, outgoing: expect.any(Object) }),
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("add a new address through set_server_address, and throw the shell's refusal", async () => {
    setPageReloader(() => undefined)
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_server_address") throw "NotALiaisonServer"
      return undefined
    })
    await expect(buildDesktopServers().add("https://nope.example")).rejects.toThrow(
      "NotALiaisonServer",
    )
    expect(invoke).toHaveBeenCalledWith(
      "set_server_address",
      expect.objectContaining({ url: "https://nope.example" }),
    )
  })

  it("ask the shell to confirm a removal rather than remove anything themselves", async () => {
    await buildDesktopServers().remove(A)
    expect(invoke).toHaveBeenCalledWith("ask_remove_server", { address: A })
    expect(invoke).not.toHaveBeenCalledWith("remove_server", expect.anything())
  })

  it("sign out of the current server through the shell", async () => {
    const reload = vi.fn()
    await buildDesktopServers(reload).signOut()
    expect(invoke).toHaveBeenCalledWith("sign_out")
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("open the page's connect step for Add a server", () => {
    const bridge = publishDesktopBridge({})
    bridge.servers?.beginAdd?.()
    expect(bridge.getState().addingServer).toBe(true)
  })

  // No OS has an Account menu: Settings asks the shell's own native
  // question, which the page cannot answer.
  it("ask the shell's own Claude sign out question from Settings", async () => {
    const bridge = publishDesktopBridge({})
    expect(typeof bridge.signOutOfClaude).toBe("function")
    await bridge.signOutOfClaude?.()
    expect(invoke).toHaveBeenCalledWith("confirm_claude_sign_out")
  })
})

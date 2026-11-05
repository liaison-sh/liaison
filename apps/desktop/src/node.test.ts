// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell's half of node mode (P4 N-D T4): the node credential kept per
// server by `node.rs`, and the keep-awake switch, behind four commands.
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
}))
vi.mock("./tauri", () => ({ invoke, listen: vi.fn(async () => () => {}) }))

import {
  keepAwake,
  loadNodeCredential,
  remoteAuto,
  setKeepAwake,
  setRemoteAuto,
  storeNodeCredential,
} from "./node"

const status = {
  enabled: true,
  supported: true,
  nodeOn: true,
  power: "ac",
  held: true,
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async () => undefined)
})

describe("the node credential", () => {
  it("is stored and read back by the shell, per server, never in the page", async () => {
    const node = { nodeId: "n-1", credential: "lnn_x", enabled: true }
    invoke.mockImplementation(async (command: string) =>
      command === "load_node_credential" ? node : status,
    )
    await storeNodeCredential("https://a.example.com", node)
    expect(invoke).toHaveBeenCalledWith("store_node_credential", {
      server: "https://a.example.com",
      node,
    })
    expect(await loadNodeCredential("https://a.example.com")).toEqual(node)
    expect(invoke).toHaveBeenCalledWith("load_node_credential", {
      server: "https://a.example.com",
    })
  })

  it("removes it with null, and reads nothing from a refusing or odd shell", async () => {
    await storeNodeCredential("https://a.example.com", null)
    expect(invoke).toHaveBeenCalledWith("store_node_credential", {
      server: "https://a.example.com",
      node: null,
    })
    invoke.mockImplementation(async () => ({ nodeId: "n-1" }))
    expect(await loadNodeCredential("https://a.example.com")).toBeNull()
    invoke.mockImplementation(async () => {
      throw new Error("NotCurrentServer")
    })
    expect(await loadNodeCredential("https://b.example.com")).toBeNull()
    await expect(
      storeNodeCredential("https://b.example.com", {
        nodeId: "n",
        credential: "c",
        enabled: true,
      }),
    ).rejects.toThrow("NotCurrentServer")
  })
})

describe("keep awake", () => {
  it("reads and sets the shell's switch and answers its status", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "set_keep_awake" ? { ...status, enabled: args?.enabled, held: false } : status,
    )
    expect(await keepAwake()).toEqual(status)
    expect(invoke).toHaveBeenCalledWith("get_keep_awake")
    expect((await setKeepAwake(false)).enabled).toBe(false)
    expect(invoke).toHaveBeenCalledWith("set_keep_awake", { enabled: false })
  })

  it("answers not supported from a shell that cannot say", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("unknown command")
    })
    expect(await keepAwake()).toEqual({
      enabled: false,
      supported: false,
      nodeOn: false,
      power: "unknown",
      held: false,
    })
  })
})

describe("remote Auto", () => {
  it("answers only what the shell says: a declined dialog stays off", async () => {
    // The shell's dialog was declined: both commands answer off.
    invoke.mockImplementation(async () => false)
    expect(await remoteAuto()).toBe(false)
    expect(invoke).toHaveBeenCalledWith("get_node_remote_auto")
    expect(await setRemoteAuto(true)).toBe(false)
    expect(invoke).toHaveBeenCalledWith("set_node_remote_auto", { enabled: true })
  })

  it("is off on a shell that does not know the command", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("unknown command")
    })
    expect(await remoteAuto()).toBe(false)
    expect(await setRemoteAuto(true)).toBe(false)
  })
})

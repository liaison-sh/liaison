// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
}))
vi.mock("./tauri", () => ({ invoke }))

import {
  REFRESH_SHELL_COMMAND,
  refreshShell,
  SHELL_READY_COMMAND,
  SHELL_STATUS_COMMAND,
  shellReady,
  shellStatus,
} from "./served-shell"

beforeEach(() => invoke.mockReset())

describe("the served shell asks", () => {
  it("ready names the page's build id", async () => {
    await shellReady("0123456789abcdef")
    expect(invoke).toHaveBeenCalledWith(SHELL_READY_COMMAND, { buildId: "0123456789abcdef" })
  })

  it("status passes a well formed answer and nothing else", async () => {
    const served = { served: true, buildId: "0123456789abcdef", reason: null, pending: false }
    invoke.mockResolvedValueOnce(served)
    expect(await shellStatus()).toEqual(served)
    expect(invoke).toHaveBeenCalledWith(SHELL_STATUS_COMMAND)
    invoke.mockResolvedValueOnce({ served: "yes" })
    expect(await shellStatus()).toBeNull()
    invoke.mockRejectedValueOnce(new Error("no such command"))
    expect(await shellStatus()).toBeNull()
  })

  it("refresh answers the pending build or null, and never throws", async () => {
    invoke.mockResolvedValueOnce("fedcba9876543210")
    expect(await refreshShell()).toBe("fedcba9876543210")
    expect(invoke).toHaveBeenCalledWith(REFRESH_SHELL_COMMAND)
    invoke.mockResolvedValueOnce(null)
    expect(await refreshShell()).toBeNull()
    invoke.mockRejectedValueOnce(new Error("offline"))
    await expect(shellReady("x")).resolves.toBeUndefined()
  })
})

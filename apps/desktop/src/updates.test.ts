// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The page's two asks of the shell about its version: run the update check, and
// say which version this is (src/updates.ts).
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
}))
vi.mock("./tauri", () => ({ invoke }))

import {
  APP_VERSION_COMMAND,
  appVersion,
  CHECK_FOR_UPDATES_COMMAND,
  checkForUpdates,
} from "./updates"

beforeEach(() => invoke.mockReset())

describe("the shell's version", () => {
  it("is Tauri's app version", async () => {
    invoke.mockResolvedValueOnce("0.1.35")
    expect(await appVersion()).toBe("0.1.35")
    expect(invoke).toHaveBeenCalledWith(APP_VERSION_COMMAND)
  })

  it("rejects when the shell answers no version, so the page names nothing", async () => {
    invoke.mockResolvedValueOnce(undefined)
    await expect(appVersion()).rejects.toThrow()
  })

  it("the update check never throws", async () => {
    invoke.mockRejectedValueOnce(new Error("no such command"))
    await expect(checkForUpdates({ manual: true })).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith(CHECK_FOR_UPDATES_COMMAND, { manual: true })
  })
})

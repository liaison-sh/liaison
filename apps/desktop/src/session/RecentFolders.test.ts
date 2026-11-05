// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX2 (SK-1): the recent list is the SHELL's, not the window's.
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command: string, _args?: unknown) => [] as unknown),
}))

vi.mock("../tauri", () => ({
  invoke: invokeMock,
  listen: vi.fn(async () => () => undefined),
}))

import { getRecentFolders, RECENT_FOLDERS_LIMIT } from "./RecentFolders"

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue([])
  localStorage.clear()
})

describe("RecentFolders", () => {
  it("asks the shell for the folders, never the browser storage", async () => {
    invokeMock.mockResolvedValueOnce(["/b", "/a"])
    await expect(getRecentFolders("agent-1")).resolves.toEqual(["/b", "/a"])
    expect(invokeMock).toHaveBeenCalledWith("recent_folders", { agentId: "agent-1" })
    // The old home of this list. A page script writes it freely, so a list read
    // from here could name any folder on the machine as one the user chose.
    expect(localStorage.length).toBe(0)
  })

  it("is isolated per agent id", async () => {
    invokeMock.mockResolvedValue([])
    await getRecentFolders("agent-2")
    expect(invokeMock).toHaveBeenCalledWith("recent_folders", { agentId: "agent-2" })
  })

  it("answers an empty list for a window with no shell under it", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no such command"))
    await expect(getRecentFolders("agent-1")).resolves.toEqual([])
    await expect(getRecentFolders("")).resolves.toEqual([])
  })

  it("reads a shape it does not recognise as an empty list", async () => {
    invokeMock.mockResolvedValueOnce({ not: "a list" })
    await expect(getRecentFolders("agent-1")).resolves.toEqual([])
    invokeMock.mockResolvedValueOnce(["/a", 7, null])
    await expect(getRecentFolders("agent-1")).resolves.toEqual(["/a"])
  })

  it("names the same cap the shell enforces", () => {
    expect(RECENT_FOLDERS_LIMIT).toBe(5)
  })
})

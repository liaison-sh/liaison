// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import { recallThreadFolder, rememberThreadFolder } from "./thread-folder-memory"

describe("thread folder memory", () => {
  beforeEach(() => localStorage.clear())

  it("gives back the folder a conversation last ran in, per conversation", () => {
    rememberThreadFolder("thread-a", "/Users/me/Rapports")
    rememberThreadFolder("thread-b", "/Users/me/Other")
    expect(recallThreadFolder("thread-a")).toBe("/Users/me/Rapports")
    expect(recallThreadFolder("thread-b")).toBe("/Users/me/Other")
    expect(recallThreadFolder("thread-c")).toBeNull()
  })

  it("remembers nothing for no conversation", () => {
    rememberThreadFolder(null, "/Users/me/Rapports")
    expect(recallThreadFolder(null)).toBeNull()
  })
})

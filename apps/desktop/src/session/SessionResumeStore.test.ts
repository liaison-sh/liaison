// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import { hashFolder } from "./folder-hash"
import { getSessionEntry, getSessionId, sessionIdKey, setSessionId } from "./SessionResumeStore"

const FOLDER = "/Users/alice/secret-project"

beforeEach(() => {
  localStorage.clear()
})

describe("SessionResumeStore", () => {
  it("keys a session by agent and by the folder's digest, never its path", async () => {
    const folderHash = await hashFolder(FOLDER)
    const key = sessionIdKey("agent-1", folderHash)
    expect(key).toBe(`liaison-desktop:session-id:agent-1:${folderHash}`)
    expect(key).not.toContain("secret-project")
  })

  it("returns null for a never seen agent folder pair", async () => {
    expect(getSessionId("agent-1", await hashFolder(FOLDER))).toBeNull()
  })

  it("round trips a session id for the same agent and folder", async () => {
    const folderHash = await hashFolder(FOLDER)
    setSessionId("agent-1", folderHash, "claude-session-9")
    expect(getSessionId("agent-1", folderHash)).toBe("claude-session-9")
  })

  it("keeps agent A folder F and agent B folder F apart", async () => {
    const folderHash = await hashFolder(FOLDER)
    setSessionId("agent-a", folderHash, "claude-session-a")
    expect(getSessionId("agent-b", folderHash)).toBeNull()
  })

  it("keeps two folders of one agent apart", async () => {
    setSessionId("agent-1", await hashFolder("/a/one"), "session-one")
    expect(getSessionId("agent-1", await hashFolder("/a/two"))).toBeNull()
    expect(getSessionId("agent-1", await hashFolder("/a/one/"))).toBe("session-one")
  })

  it("forgets a session rather than resuming an empty id", async () => {
    const folderHash = await hashFolder(FOLDER)
    setSessionId("agent-1", folderHash, "session-one")
    setSessionId("agent-1", folderHash, null)
    expect(getSessionId("agent-1", folderHash)).toBeNull()
  })

  it("stores the checksum of the definition a session was created with", async () => {
    const folderHash = await hashFolder(FOLDER)
    setSessionId("agent-1", folderHash, "session-one", "d".repeat(64))
    expect(getSessionEntry("agent-1", folderHash)).toEqual({
      sessionId: "session-one",
      definitionChecksum: "d".repeat(64),
    })
  })

  it("reads an entry written before checksums as a session of unknown definition", async () => {
    const folderHash = await hashFolder(FOLDER)
    localStorage.setItem(sessionIdKey("agent-1", folderHash), "legacy-session")
    expect(getSessionEntry("agent-1", folderHash)).toEqual({
      sessionId: "legacy-session",
      definitionChecksum: null,
    })
    expect(getSessionId("agent-1", folderHash)).toBe("legacy-session")
  })

  it("reads an entry it cannot parse as no stored session", async () => {
    const folderHash = await hashFolder(FOLDER)
    localStorage.setItem(sessionIdKey("agent-1", folderHash), "{not json")
    expect(getSessionEntry("agent-1", folderHash)).toBeNull()
  })

  it("reads a refused storage as no stored session, never as a crash", async () => {
    const folderHash = await hashFolder(FOLDER)
    const getItem = localStorage.getItem
    localStorage.getItem = () => {
      throw new Error("storage is disabled")
    }
    try {
      expect(getSessionId("agent-1", folderHash)).toBeNull()
    } finally {
      localStorage.getItem = getItem
    }
  })
})

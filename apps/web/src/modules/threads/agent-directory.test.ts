// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  agentDirectoryLoaded,
  getAgentDisplay,
  listAgentDirectory,
  loadAgentDirectory,
  personalAgentFor,
  resetAgentDirectory,
} from "~/modules/threads/agent-directory"

const AGENT_ID = "44444444-4444-4444-8444-444444444444"

function apiReturning(rows: unknown[], calls?: string[]) {
  return {
    get: vi.fn(async (path: string) => {
      calls?.push(path)
      return { data: rows }
    }),
  }
}

describe("agent directory (P4b-T06)", () => {
  beforeEach(() => resetAgentDirectory())

  it("getAgentDisplay returns undefined before loadAgentDirectory resolves", () => {
    expect(agentDirectoryLoaded()).toBe(false)
    expect(getAgentDisplay(AGENT_ID)).toBeUndefined()
  })

  it("getAgentDisplay returns the fetched name after loadAgentDirectory resolves", async () => {
    const calls: string[] = []
    await loadAgentDirectory(
      apiReturning(
        [{ id: AGENT_ID, handle: "@support", displayName: "Support", avatarUrl: null }],
        calls,
      ),
    )
    expect(calls[0]).toBe("/agents")
    const display = getAgentDisplay(AGENT_ID)
    expect(display).toBeDefined()
    expect(display!.name).toBe("Support")
    expect(display!.handle).toBe("@support")
    expect(display!.avatarUrl).toBeNull()
    expect(listAgentDirectory()).toHaveLength(1)
  })

  it("shows a personal agent nobody renamed as Personal agent, and a chosen name as written", async () => {
    await loadAgentDirectory(
      apiReturning([
        { id: AGENT_ID, handle: "@avery", displayName: "Personal agent", kind: "personal" },
      ]),
    )
    expect(getAgentDisplay(AGENT_ID)!.name).toBe("Personal agent")
    expect(getAgentDisplay(AGENT_ID)!.handle).toBe("@avery")
    resetAgentDirectory()
    await loadAgentDirectory(
      apiReturning([{ id: AGENT_ID, handle: "@avery", displayName: "Scout", kind: "personal" }]),
    )
    expect(getAgentDisplay(AGENT_ID)!.name).toBe("Scout")
  })

  it("falls back to the handle when an agent carries no display name", async () => {
    await loadAgentDirectory(apiReturning([{ id: AGENT_ID, handle: "@logistics" }]))
    expect(getAgentDisplay(AGENT_ID)!.name).toBe("@logistics")
  })

  it("fetches once per session and serves later callers from the cache", async () => {
    const api = apiReturning([{ id: AGENT_ID, handle: "@support", displayName: "Support" }])
    await loadAgentDirectory(api)
    await loadAgentDirectory(api)
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it("leaves the cache empty and does not mark itself loaded when the fetch fails", async () => {
    const api = {
      get: vi.fn(async () => {
        throw new Error("no such route")
      }),
    }
    await loadAgentDirectory(api)
    expect(agentDirectoryLoaded()).toBe(false)
    expect(getAgentDisplay(AGENT_ID)).toBeUndefined()
  })

  it("getAgentDisplay tolerates a null or missing id", () => {
    expect(getAgentDisplay(null)).toBeUndefined()
    expect(getAgentDisplay(undefined)).toBeUndefined()
  })

  // WHICH PERSONAL AGENT IS MINE. The listing echoes the owner for the caller
  // and nobody else, so "my Liaison" is decidable here and "whose is that one"
  // is not. The agent panel publishes it for the desktop shell.
  it("finds the viewer's own personal agent and no colleague's", async () => {
    await loadAgentDirectory(
      apiReturning([
        {
          id: "a-mine",
          handle: "@mine",
          displayName: "Liaison",
          kind: "personal",
          ownerUserId: "u1",
        },
        {
          id: "a-theirs",
          handle: "@theirs",
          displayName: "Theirs",
          kind: "personal",
          ownerUserId: null,
        },
        { id: "a-role", handle: "@ops", displayName: "Ops", kind: "role", ownerUserId: null },
      ]),
    )
    expect(personalAgentFor("u1")?.id).toBe("a-mine")
    expect(personalAgentFor("u2")).toBeUndefined()
    expect(personalAgentFor(null)).toBeUndefined()
  })

  // P4c-T39: the three fields the agents directory draws on a card are folded
  // into the cached row, so one `/agents` read serves both surfaces. A backend
  // that does not send them leaves nulls rather than undefined holes.
  it("carries the directory's own fields off the same listing", async () => {
    await loadAgentDirectory(
      apiReturning([
        {
          id: "a-ops",
          handle: "@ops",
          displayName: "Ops",
          kind: "role",
          purpose: "Keeps the warehouse honest",
          state: "active",
          channelCount: 3,
        },
        { id: "a-bare", handle: "@bare", displayName: "Bare", kind: "role" },
      ]),
    )
    expect(getAgentDisplay("a-ops")).toMatchObject({
      purpose: "Keeps the warehouse honest",
      state: "active",
      channelCount: 3,
    })
    expect(getAgentDisplay("a-bare")).toMatchObject({
      purpose: null,
      state: null,
      channelCount: null,
    })
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { MentionSearchUnavailableError, searchMentions } from "~/lib/mention-service"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"

const SUPPORT_ID = "11111111-1111-4111-8111-111111111111"
const SUPPORTBOT_ID = "22222222-2222-4222-8222-222222222222"

async function seedAgentDirectory() {
  resetAgentDirectory()
  await loadAgentDirectory({
    get: async () => ({
      data: [
        { id: SUPPORT_ID, handle: "@support", displayName: "Support", avatarUrl: null },
        { id: SUPPORTBOT_ID, handle: "@supportbot", displayName: "Support Bot", avatarUrl: null },
      ],
    }),
  })
}

describe("searchMentions", () => {
  it("returns results from { data: [...] } envelope", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ data: [{ id: "u1", type: "user", label: "Alice" }] }),
    }
    const results = await searchMentions(api, "ali", "@", 5)
    expect(results).toHaveLength(1)
    expect(results[0].label).toBe("Alice")
    expect(api.get).toHaveBeenCalledWith("/mentions?q=ali&limit=5&type=addressable")
  })

  it("returns results from bare array response", async () => {
    const api = { get: vi.fn().mockResolvedValue([{ id: "u1", type: "user", label: "Bob" }]) }
    const results = await searchMentions(api, "bob")
    expect(results).toHaveLength(1)
    expect(results[0].label).toBe("Bob")
  })

  it("returns empty array for non-array response", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: null }) }
    const results = await searchMentions(api, "xyz")
    expect(results).toEqual([])
  })

  it("uses default limit of 8 and the @ trigger's addressable narrowing", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    await searchMentions(api, "test")
    expect(api.get).toHaveBeenCalledWith("/mentions?q=test&limit=8&type=addressable")
  })

  it("narrows the # trigger to the reference set", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    await searchMentions(api, "proj", "#")
    expect(api.get).toHaveBeenCalledWith("/mentions?q=proj&limit=8&type=reference")
  })

  it("passes explicit type when provided", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    await searchMentions(api, "proj", "#", 8, "entity")
    expect(api.get).toHaveBeenCalledWith("/mentions?q=proj&limit=8&type=entity")
  })

  it("lists members first and the matching agents after them on the @ trigger", async () => {
    await seedAgentDirectory()
    const api = {
      get: vi.fn().mockResolvedValue({ data: [{ type: "user", id: "u1", label: "Sue" }] }),
    }
    const results = await searchMentions(api, "support", "@")
    // Colleagues are who a writer tags most: they lead, agents follow.
    expect(results[0]).toEqual({ type: "user", id: "u1", label: "Sue" })
    // The agent row is TITLED by its display name, with the handle under it.
    expect(results[1]).toEqual({
      type: "agent",
      id: SUPPORT_ID,
      label: "Support",
      secondaryLabel: "@support",
    })
    expect(results.map((r) => r.type)).toEqual(["user", "agent", "agent"])
  })

  it("never offers a contact on the @ trigger, even when the server sends one", async () => {
    // Tagging a customer notifies nobody, and on a bare @ the contacts came
    // back ahead of the colleagues. Contacts are entities, referenced under #.
    await seedAgentDirectory()
    const api = {
      get: vi.fn().mockResolvedValue({
        data: [
          { type: "contact", id: "c1", label: "Acme buyer", app: "kernel", entityType: "contact" },
          { type: "user", id: "u1", label: "Sue" },
          { type: "contact", id: "c2", label: "Supplier", app: "kernel", entityType: "contact" },
        ],
      }),
    }
    const results = await searchMentions(api, "", "@")
    expect(results.some((r) => r.type === "contact")).toBe(false)
    expect(results.map((r) => r.type)).toEqual(["user", "agent", "agent"])
  })

  it("offers contacts on the # trigger, as entities", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        data: [
          { type: "thread", id: "t1", label: "logistics" },
          { type: "contact", id: "c1", label: "Acme buyer", app: "kernel", entityType: "contact" },
        ],
      }),
    }
    const results = await searchMentions(api, "", "#")
    expect(results.find((r) => r.id === "c1")).toEqual({
      type: "contact",
      id: "c1",
      label: "Acme buyer",
      app: "kernel",
      entityType: "contact",
    })
  })

  it("offers no agent for a query no handle or name starts with", async () => {
    await seedAgentDirectory()
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    const results = await searchMentions(api, "bob", "@")
    expect(results).toEqual([])
  })

  it("offers no agent for the # trigger", async () => {
    await seedAgentDirectory()
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    const results = await searchMentions(api, "support", "#")
    expect(results).toEqual([])
  })

  it("matches a handle case-insensitively", async () => {
    await seedAgentDirectory()
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    const results = await searchMentions(api, "SUPPORTB", "@")
    expect(results[0]).toEqual({
      type: "agent",
      id: SUPPORTBOT_ID,
      label: "Support Bot",
      secondaryLabel: "@supportbot",
    })
  })

  it("offers every agent on the bare trigger, before the user types", async () => {
    await seedAgentDirectory()
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    const results = await searchMentions(api, "", "@")
    expect(results.map((r) => r.id)).toEqual([SUPPORT_ID, SUPPORTBOT_ID])
  })

  it("throws MentionSearchUnavailableError on a 503 response", async () => {
    const api = { get: vi.fn().mockRejectedValue(new ApiError("Service unavailable", 503)) }
    await expect(searchMentions(api, "ali", "@")).rejects.toBeInstanceOf(
      MentionSearchUnavailableError,
    )
  })

  it("throws MentionSearchUnavailableError on a SEARCH_UNAVAILABLE error code", async () => {
    const api = {
      get: vi.fn().mockRejectedValue(new ApiError("Search down", 500, "SEARCH_UNAVAILABLE")),
    }
    await expect(searchMentions(api, "ali", "@")).rejects.toBeInstanceOf(
      MentionSearchUnavailableError,
    )
  })

  it("rethrows other ApiErrors unchanged", async () => {
    const err = new ApiError("Unauthorized", 401)
    const api = { get: vi.fn().mockRejectedValue(err) }
    await expect(searchMentions(api, "ali", "@")).rejects.toBe(err)
  })
})

describe("searchMentions - agent suggestions come from the directory (P4b-T13)", () => {
  beforeEach(async () => {
    await seedAgentDirectory()
  })

  it("searchMentions surfaces every agent whose handle prefix-matches the query", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    const results = await searchMentions(api, "sup", "@")
    const agentResults = results.filter((r) => r.type === "agent")
    expect(agentResults).toEqual([
      { type: "agent", id: SUPPORT_ID, label: "Support", secondaryLabel: "@support" },
      { type: "agent", id: SUPPORTBOT_ID, label: "Support Bot", secondaryLabel: "@supportbot" },
    ])
  })

  it("searchMentions never returns the literal kernel-Liaison placeholder", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    for (const query of ["lia", "liaison", "LIA", ""]) {
      const results = await searchMentions(api, query, "@")
      expect(results.some((r) => r.id === "kernel")).toBe(false)
    }
  })

  it("matches an agent by its display name as well as its handle", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: [] }) }
    const results = await searchMentions(api, "Support B", "@")
    expect(results.map((r) => r.id)).toEqual([SUPPORTBOT_ID])
  })
})

// Surface 10: the popup listed the same channel four times. The candidate
// sources overlap (indexed hits, the direct-DB top-up, the local agent
// directory) and nothing downstream reconciled them.
describe("searchMentions deduplication", () => {
  it("lists a channel returned by several sources exactly once", async () => {
    const channel = { id: "t-1", type: "thread", label: "logistics" }
    const api = {
      get: vi.fn().mockResolvedValue({ data: [channel, { ...channel }, { ...channel }, channel] }),
    }
    const results = await searchMentions(api, "log", "#", 8)
    expect(results.filter((r) => r.id === "t-1")).toHaveLength(1)
  })

  it("keeps the first occurrence, so members still lead the @ list", async () => {
    await seedAgentDirectory()
    const api = {
      get: vi.fn().mockResolvedValue({
        data: [
          { id: "u-9", type: "user", label: "Alice" },
          { id: "u-9", type: "user", label: "Alice" },
          { id: "u-7", type: "user", label: "Sam Support" },
        ],
      }),
    }
    const results = await searchMentions(api, "support", "@", 8)
    expect(results.filter((r) => r.id === "u-9")).toHaveLength(1)
    expect(results[0].id).toBe("u-9")
    expect(results[1].id).toBe("u-7")
    expect(results.filter((r) => r.id === SUPPORT_ID)).toHaveLength(1)
    expect(results.find((r) => r.id === SUPPORT_ID)?.type).toBe("agent")
  })
})

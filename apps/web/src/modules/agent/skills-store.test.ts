// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Skills store unit tests. The store mirrors `/api/agent/skills*` — every
 * test pins the contract (URL + method) as well as the optimistic behavior
 * the UI relies on.
 */
import { createRoot } from "solid-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const SKILL_FIXTURE = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "test-skill",
  description: "Hello",
  body: "# Hi",
  source: "user" as const,
  requiredScopes: [],
}

function makeApi(overrides: Partial<Record<"get" | "post" | "put" | "delete", any>> = {}) {
  return {
    get: vi.fn().mockResolvedValue([SKILL_FIXTURE]),
    post: vi.fn().mockResolvedValue(SKILL_FIXTURE),
    put: vi.fn().mockResolvedValue(SKILL_FIXTURE),
    delete: vi.fn().mockResolvedValue(undefined),
    patch: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
    ...overrides,
  } as any
}

describe("skills-store", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("loadSkills hits GET /api/agent/skills and hydrates by source", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([
          { ...SKILL_FIXTURE, source: "user" },
          { ...SKILL_FIXTURE, id: "22", name: "orgskill", source: "org" },
          {
            id: "built-in/tickets/summarizer",
            name: "summarizer",
            description: "x",
            source: "app",
            appName: "tickets",
            requiredScopes: [],
          },
        ]),
      })
      await store.loadSkills(api)
      expect(api.get).toHaveBeenCalledWith("/agent/skills")
      expect(store.skillsStore.skills).toHaveLength(3)
      const sources = store.skillsStore.skills.map((s: any) => s.source)
      expect(sources).toEqual(["user", "org", "app"])
      dispose()
    })
  })

  it("loadSkills sets error message on failure", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({ get: vi.fn().mockRejectedValue(new Error("boom")) })
      await store.loadSkills(api)
      expect(store.skillsStore.error).toBe("boom")
      dispose()
    })
  })

  it("createSkill optimistically appends; rolls back on 4xx", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({
        post: vi.fn().mockRejectedValue(new Error("400")),
      })
      await expect(
        store.createSkill(api, {
          name: "x",
          description: "d",
          body: "b",
          scope: "user",
          requiredScopes: [],
        }),
      ).rejects.toThrow("400")
      expect(store.skillsStore.skills).toHaveLength(0)
      dispose()
    })
  })

  it("createSkill replaces optimistic row with server row", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({
        post: vi.fn().mockResolvedValue(SKILL_FIXTURE),
      })
      await store.createSkill(api, {
        name: "test-skill",
        description: "Hello",
        body: "# Hi",
        scope: "user",
        requiredScopes: [],
      })
      expect(api.post).toHaveBeenCalledWith(
        "/agent/skills",
        expect.objectContaining({ name: "test-skill", visibility: "personal" }),
      )
      expect(store.skillsStore.skills).toHaveLength(1)
      expect(store.skillsStore.skills[0].id).toBe(SKILL_FIXTURE.id)
      expect(store.skillsStore.skills.some((s: any) => s.id.startsWith("optimistic-"))).toBe(false)
      dispose()
    })
  })

  it("updateSkill optimistically updates then merges server response", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([SKILL_FIXTURE]),
        put: vi.fn().mockResolvedValue({ ...SKILL_FIXTURE, description: "Bye" }),
      })
      await store.loadSkills(api)
      await store.updateSkill(api, SKILL_FIXTURE.id, { description: "Bye" })
      expect(api.put).toHaveBeenCalledWith(`/agent/skills/${SKILL_FIXTURE.id}`, {
        description: "Bye",
      })
      expect(store.skillsStore.skills[0].description).toBe("Bye")
      dispose()
    })
  })

  it("updateSkill rolls back on failure", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([SKILL_FIXTURE]),
        put: vi.fn().mockRejectedValue(new Error("server")),
      })
      await store.loadSkills(api)
      await expect(
        store.updateSkill(api, SKILL_FIXTURE.id, { description: "Bye" }),
      ).rejects.toThrow("server")
      expect(store.skillsStore.skills[0].description).toBe("Hello")
      dispose()
    })
  })

  it("deleteSkill removes optimistically; rolls back on failure", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([SKILL_FIXTURE]),
        delete: vi.fn().mockRejectedValue(new Error("denied")),
      })
      await store.loadSkills(api)
      await expect(store.deleteSkill(api, SKILL_FIXTURE.id)).rejects.toThrow("denied")
      expect(store.skillsStore.skills).toHaveLength(1)
      dispose()
    })
  })

  it("forkSkill POSTs to /:id/fork with optional name and prepends the row", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({
        post: vi.fn().mockResolvedValue({ ...SKILL_FIXTURE, id: "fork-1", name: "forked" }),
      })
      await store.forkSkill(api, "built-in/tickets/summarizer", "forked")
      expect(api.post).toHaveBeenCalledWith("/agent/skills/built-in%2Ftickets%2Fsummarizer/fork", {
        name: "forked",
      })
      expect(store.skillsStore.skills[0].id).toBe("fork-1")
      dispose()
    })
  })

  it("toggleAppSkill optimistically flips `disabled`; rolls back on 4xx", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([
          {
            id: "built-in/tickets/summarizer",
            name: "summarizer",
            description: "x",
            source: "app",
            appName: "tickets",
            requiredScopes: [],
            disabled: false,
          },
        ]),
        post: vi.fn().mockRejectedValue(new Error("403")),
      })
      await store.loadSkills(api)
      await expect(store.toggleAppSkill(api, "tickets", "summarizer", "user")).rejects.toThrow(
        "403",
      )
      // Restored
      expect(store.skillsStore.skills[0].disabled).toBe(false)
      expect(api.post).toHaveBeenCalledWith("/agent/app-skills/tickets/summarizer/toggle", {
        scope: "user",
      })
      dispose()
    })
  })

  it("onSkillUpdated refetches a single skill when the open detail matches", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi()
      store.bindSkillsWsApi(api)
      store.setOpenSkillDetailId(SKILL_FIXTURE.id)
      store.onSkillUpdated({
        type: "skill:updated",
        skillId: SKILL_FIXTURE.id,
        name: "test-skill",
      })
      // Microtask drain
      await Promise.resolve()
      await Promise.resolve()
      expect(api.get).toHaveBeenCalled()
      dispose()
    })
  })

  it("onSkillUpdated falls back to a full list refresh when no detail open", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./skills-store")
      const api = makeApi()
      store.bindSkillsWsApi(api)
      store.setOpenSkillDetailId(null)
      store.onSkillUpdated({
        type: "skill:updated",
        skillId: "anything",
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(api.get).toHaveBeenCalledWith("/agent/skills")
      dispose()
    })
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  agentInstructionsRegistry,
  appCapabilitiesRegistry,
  appPromptRegistry,
  deleteDeclaredEmits,
  getAllDeclaredEmits,
  orgHasCapability,
  resetAppRegistries,
  setDeclaredEmits,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-000000e10001"

describe("tool registry — extended fields", () => {
  afterEach(() => {
    toolRegistry.deleteByPrefix([ORG])
  })

  it("stores and retrieves instructions and taintSource", () => {
    toolRegistry.set([ORG, "test_ext", "web_search"], {
      appName: "test_ext",
      name: "web_search",
      description: "Search the web",
      requiredScopes: ["test_ext:search"],
      handler: async () => ({ results: [] }),
      instructions: "Use when the user asks to search the web.",
      taintSource: true,
    })

    const entry = toolRegistry.get([ORG, "test_ext", "web_search"])
    expect(entry?.instructions).toBe("Use when the user asks to search the web.")
    expect(entry?.taintSource).toBe(true)
  })

  it("omitted instructions and taintSource default to undefined", () => {
    toolRegistry.set([ORG, "test_ext", "basic"], {
      appName: "test_ext",
      name: "basic",
      description: "Basic tool",
      requiredScopes: ["test_ext:basic"],
      handler: async () => null,
    })

    const entry = toolRegistry.get([ORG, "test_ext", "basic"])
    expect(entry?.instructions).toBeUndefined()
    expect(entry?.taintSource).toBeUndefined()
  })
})

describe("orgHasCapability — kernel-universal vs app-declared", () => {
  // The registries are process-global and the unit runner batches files into
  // one process: any earlier file that registered an app for its own org
  // (registerApps -> registerSingleApp records the app's capabilities, e.g.
  // app-access-no-loss.test.ts) leaves entries behind. These cases are about an
  // EMPTY registry, so they set that state up rather than inherit it.
  beforeEach(() => {
    resetAppRegistries()
  })
  afterEach(() => {
    resetAppRegistries()
  })

  it("returns true for the kernel-universal capability agent.spawn with an EMPTY registry (no apps installed)", () => {
    // Regression guard: sub-agent spawning is a core kernel primitive present in
    // every org with no app install required. orgHasCapability must short-circuit
    // to true for agent.spawn before scanning the per-app registry.
    expect([...appCapabilitiesRegistry.entries()].length).toBe(0)
    expect(orgHasCapability("00000000-0000-0000-0000-0000000ca000", "agent.spawn")).toBe(true)
  })

  it("returns true for agent.spawn for ANY org regardless of which apps are installed", () => {
    appCapabilitiesRegistry.set(["org-a", "tickets"], ["some.other.capability"])
    expect(orgHasCapability("org-a", "agent.spawn")).toBe(true)
    // An org with no entry at all still gets it.
    expect(orgHasCapability("org-with-nothing", "agent.spawn")).toBe(true)
  })

  it("still scans the per-app registry for a NON-kernel capability and is org-scoped", () => {
    appCapabilitiesRegistry.set(["org-a", "tickets"], ["tickets.special"])
    expect(orgHasCapability("org-a", "tickets.special")).toBe(true)
    // Absent capability → false.
    expect(orgHasCapability("org-a", "nope.capability")).toBe(false)
    // Other org's declaration does not leak.
    expect(orgHasCapability("org-b", "tickets.special")).toBe(false)
  })
})

describe("registry split", () => {
  afterEach(() => {
    resetAppRegistries()
  })

  it("agentInstructionsRegistry stores markdown keyed by [orgId, appName]", () => {
    agentInstructionsRegistry.set(["org-a", "tickets"], "Tickets is for support cases.")
    expect(agentInstructionsRegistry.get(["org-a", "tickets"])).toBe(
      "Tickets is for support cases.",
    )
    expect(agentInstructionsRegistry.get(["org-a", "tickets"])).not.toBeUndefined()
  })

  it("appPromptRegistry stores prompt content keyed by [orgId, appName, promptName]", () => {
    appPromptRegistry.set(["org-a", "tickets", "summarizer"], { content: "# Ticket summary" })
    expect(appPromptRegistry.get(["org-a", "tickets", "summarizer"])?.content).toBe(
      "# Ticket summary",
    )
  })

  it("skillRegistry stores user-facing skill entries with description ≤100 chars", () => {
    skillRegistry.set(["org-a", "tickets", "draft-reply"], {
      name: "draft-reply",
      description: "Draft a customer-facing reply from ticket context",
      body: "# How to draft a reply\n…",
      requiredScopes: ["tickets:write"],
    })
    const entry = skillRegistry.get(["org-a", "tickets", "draft-reply"])
    expect(entry?.description.length).toBeLessThanOrEqual(100)
    expect(entry?.body.startsWith("# ")).toBe(true)
    expect(entry?.requiredScopes).toEqual(["tickets:write"])
  })

  it("agentInstructionsRegistry.deleteByPrefix([orgId]) removes ALL entries for that org across apps", () => {
    agentInstructionsRegistry.set(["org-a", "x"], "1")
    agentInstructionsRegistry.set(["org-a", "y"], "2")
    agentInstructionsRegistry.set(["org-b", "x"], "3")
    agentInstructionsRegistry.deleteByPrefix(["org-a"])
    expect(agentInstructionsRegistry.get(["org-a", "x"])).toBeUndefined()
    expect(agentInstructionsRegistry.get(["org-a", "y"])).toBeUndefined()
    expect(agentInstructionsRegistry.get(["org-b", "x"])).toBe("3")
  })

  it("skillRegistry.deleteByPrefix([orgId]) removes all skills for that org across apps and names", () => {
    skillRegistry.set(["org-a", "app1", "s1"], {
      name: "s1",
      description: "d",
      body: "b",
      requiredScopes: [],
    })
    skillRegistry.set(["org-a", "app2", "s2"], {
      name: "s2",
      description: "d",
      body: "b",
      requiredScopes: [],
    })
    skillRegistry.set(["org-b", "app1", "s1"], {
      name: "s1",
      description: "d",
      body: "b",
      requiredScopes: [],
    })
    skillRegistry.deleteByPrefix(["org-a"])
    expect(skillRegistry.get(["org-a", "app1", "s1"])).toBeUndefined()
    expect(skillRegistry.get(["org-a", "app2", "s2"])).toBeUndefined()
    expect(skillRegistry.get(["org-b", "app1", "s1"])).toBeDefined()
  })

  it("appPromptRegistry.deleteByPrefix([orgId]) removes all prompts for that org across apps and names", () => {
    appPromptRegistry.set(["org-a", "app1", "p1"], { content: "1" })
    appPromptRegistry.set(["org-a", "app2", "p2"], { content: "2" })
    appPromptRegistry.set(["org-b", "app1", "p1"], { content: "3" })
    appPromptRegistry.deleteByPrefix(["org-a"])
    expect(appPromptRegistry.get(["org-a", "app1", "p1"])).toBeUndefined()
    expect(appPromptRegistry.get(["org-a", "app2", "p2"])).toBeUndefined()
    expect(appPromptRegistry.get(["org-b", "app1", "p1"])?.content).toBe("3")
  })

  it("sequential writes for the same orgId+appName overwrite cleanly with no stale leftovers", () => {
    agentInstructionsRegistry.set(["org-a", "tickets"], "first")
    agentInstructionsRegistry.set(["org-a", "tickets"], "second")
    expect(agentInstructionsRegistry.get(["org-a", "tickets"])).toBe("second")

    skillRegistry.set(["org-a", "tickets", "draft"], {
      name: "draft",
      description: "v1",
      body: "b1",
      requiredScopes: [],
    })
    skillRegistry.set(["org-a", "tickets", "draft"], {
      name: "draft",
      description: "v2",
      body: "b2",
      requiredScopes: ["tickets:write"],
    })
    const entry = skillRegistry.get(["org-a", "tickets", "draft"])
    expect(entry?.description).toBe("v2")
    expect(entry?.body).toBe("b2")
    expect(entry?.requiredScopes).toEqual(["tickets:write"])
  })

  it("resetAppRegistries clears all three new registries", () => {
    agentInstructionsRegistry.set(["org-z", "x"], "x")
    appPromptRegistry.set(["org-z", "x", "y"], { content: "y" })
    skillRegistry.set(["org-z", "x", "s"], {
      name: "s",
      description: "s",
      body: "s",
      requiredScopes: [],
    })
    resetAppRegistries()
    expect(agentInstructionsRegistry.get(["org-z", "x"])).toBeUndefined()
    expect(appPromptRegistry.get(["org-z", "x", "y"])).toBeUndefined()
    expect(skillRegistry.get(["org-z", "x", "s"])).toBeUndefined()
  })
})

// Regression: the kind:'event' routine event catalog (list_routine_events / getAllDeclaredEmits).
// The firmware-release-event scenario park (deep-week-sim) failed because the agent could not
// DISCOVER that a firmware ship — recorded as a project task moved into 'Shipped' — is subscribable
// as 'projects:task:moved'; it guessed from prose, concluded "no event exists", and fell back to a
// polling cron (the rubric's explicit FAIL). getAllDeclaredEmits is the discoverable catalog this
// tool surfaces. It MUST return the org's installed-app emits AND the kernel-global ("*") emits as
// full `app:entity:action` strings, scoped to the org (never another org's emits).
describe("getAllDeclaredEmits — kind:'event' routine catalog", () => {
  const A = "11111111-1111-1111-1111-111111111111"
  const B = "22222222-2222-2222-2222-222222222222"
  afterEach(() => {
    deleteDeclaredEmits(A, "projects")
    deleteDeclaredEmits(A, "shopify")
    deleteDeclaredEmits(B, "projects")
    deleteDeclaredEmits("*", "kernel")
  })

  it("returns this org's app emits as full app:entity:action strings (e.g. projects:task:moved)", () => {
    setDeclaredEmits(
      A,
      "projects",
      new Set(["task:moved", "task:created", "project_status:updated"]),
    )
    const events = getAllDeclaredEmits(A).map((e) => e.event)
    expect(events).toContain("projects:task:moved")
    expect(events).toContain("projects:task:created")
    expect(events).toContain("projects:project_status:updated")
    // The catalog row carries the owning app, for an `app` filter.
    const moved = getAllDeclaredEmits(A).find((e) => e.event === "projects:task:moved")
    expect(moved?.app).toBe("projects")
  })

  it("includes kernel-global ('*') emits alongside the org's installed-app emits", () => {
    setDeclaredEmits(A, "shopify", new Set(["order:created"]))
    setDeclaredEmits("*", "kernel", new Set(["contact:create"]))
    const events = getAllDeclaredEmits(A).map((e) => e.event)
    expect(events).toContain("shopify:order:created")
    expect(events).toContain("kernel:contact:create")
  })

  it("never leaks another org's emits", () => {
    setDeclaredEmits(A, "projects", new Set(["task:moved"]))
    setDeclaredEmits(B, "projects", new Set(["task:deleted"]))
    const events = getAllDeclaredEmits(A).map((e) => e.event)
    expect(events).toContain("projects:task:moved")
    // B's task:deleted must NOT appear in A's catalog (the events string is identical app prefix,
    // so this proves the org scoping, not just a string dedupe).
    expect(getAllDeclaredEmits(A).every((e) => e.event !== "projects:task:deleted")).toBe(true)
    expect(getAllDeclaredEmits(B).map((e) => e.event)).toContain("projects:task:deleted")
  })
})

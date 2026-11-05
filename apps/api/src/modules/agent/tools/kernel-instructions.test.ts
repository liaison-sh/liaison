// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { agentInstructionsRegistry } from "~/modules/apps/app-registries"
import { createTestOrg } from "~/tests/helpers/org"

describe("kernel admin agentInstructions", () => {
  it("loads a non-empty admin block explaining the silent-filter + offboarding routes", async () => {
    const org = await createTestOrg()
    await registerKernelAgentTools(org.id)
    const adminRaw = agentInstructionsRegistry.get([org.id, "kernel-admin"])
    const admin = typeof adminRaw === "string" ? adminRaw : adminRaw?.core
    expect(typeof admin).toBe("string")
    expect((admin ?? "").length).toBeGreaterThan(120)
    const text = (admin ?? "").toLowerCase()
    // silent-filter contract: a tool you lack the scope for is simply absent.
    expect(text).toContain("filtered")
    expect(text).toContain("scope")
    // un-built offboarding / deactivation route.
    expect(text).toContain("deactivate")
    expect(text).toContain("settings")
    agentInstructionsRegistry.deleteByPrefix([org.id])
  })
})

describe("kernel overview agentInstructions — entity tagging", () => {
  it("teaches the @[Label](ref) mention syntax for every resolvable entity kind + the never-invent-ids rule", async () => {
    const org = await createTestOrg()
    await registerKernelAgentTools(org.id)
    const overviewRaw = agentInstructionsRegistry.get([org.id, "kernel"])
    const overview = typeof overviewRaw === "string" ? overviewRaw : (overviewRaw?.core ?? "")
    // The wire syntax itself + the per-kind reference forms.
    expect(overview).toContain("@[Label](ref)")
    expect(overview).toContain("knowledge:document:")
    expect(overview).toContain("tickets:ticket:")
    expect(overview).toContain("kernel:contact:")
    expect(overview).toContain("projects:task:")
    expect(overview).toContain("mail:conversation:")
    expect(overview).toContain("thread:<uuid>")
    // Anti-fabrication: only REAL tool-returned ids; a guessed id is a dead pill.
    expect(overview.toLowerCase()).toContain("never invent or guess an id")
    // The ready-made mentionTag affordance from knowledge tool results.
    expect(overview).toContain("mentionTag")
    agentInstructionsRegistry.deleteByPrefix([org.id])
  })
})

describe("kernel notifications guide", () => {
  it("steers a channel request to the grid, never to silencing a whole app", async () => {
    const { readFileSync } = await import("node:fs")
    const text = readFileSync(
      new URL("../prompts/kernel/notifications.md", import.meta.url),
      "utf8",
    )
    expect(text).toContain("type: agent_instructions")
    expect(text).toContain("notifications_set")
    expect(text).toContain("everywhere:true")
    expect(text).toContain("group `work`")
    expect(text).toMatch(/notifications_get` first/)
    // Quiet hours go in as said; the server converts them (2026-09-29 inversion).
    expect(text).toContain('quietHours: {from:"21:00", to:"08:00", allWeekend:true')
    // No claimed change without a tool result in the same turn.
    expect(text).toContain("If no tool ran in this turn, nothing changed")
  })

  it("names the monitoring group and maps incident requests to it", async () => {
    const { readFileSync } = await import("node:fs")
    const text = readFileSync(
      new URL("../prompts/kernel/notifications.md", import.meta.url),
      "utf8",
    )
    // The group list entry, between agent and system.
    expect(text).toContain(
      "`agent` (agent and routine alerts), `monitoring` (monitoring incidents, alerts), `system` (system alerts)",
    )
    // The request mapping.
    expect(text).toContain("Incidents, alerts or monitoring are group `monitoring`")
    expect(text).toContain('{group:"monitoring", channel:"push", on:false}')
    // The existing mapping is kept.
    expect(text).toContain("group `work`")
  })

  it("tells the agent to relay a refusal, never to ask itself or a colleague", async () => {
    const { readFileSync } = await import("node:fs")
    const text = readFileSync(
      new URL("../prompts/kernel/notifications.md", import.meta.url),
      "utf8",
    )
    expect(text).toContain("When one refuses")
    expect(text).toMatch(/never ask another agent, or yourself through `kernel__agents_ask`/)
  })
})

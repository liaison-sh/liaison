// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An MCP client must learn the org's named agents at connect: without them it
// holds kernel__agents_ask and no handle to pass, and a person asking for "the
// Growth agent" is told it does not exist.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { AGENT_ROSTER_OPEN_TAG, type RosterRow } from "~/modules/agent/context/agent-roster"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  loadMcpAgentDirectory,
  MAX_HEADLINE_LIST_CHARS,
  renderMcpAgentDirectory,
  renderMcpAgentHeadline,
} from "~/modules/mcp/agent-directory"
import { createMcpServer } from "~/modules/mcp/server-factory"
import { userContextFor } from "~/modules/mcp/test-helpers"
import { listMcpTools } from "~/modules/mcp/tool-projection"

function row(handle: string, displayName: string, systemPrompt: string): RosterRow {
  return { id: crypto.randomUUID(), handle, kind: "role", displayName, systemPrompt, purpose: null }
}

const ROWS: RosterRow[] = [
  row("@support", "Support", "Answers Tessera customers."),
  row("@growth", "Growth", "Runs advertising and social.\nMore detail."),
]

function instructionsFor(agentDirectory?: RosterRow[]): string {
  const server = createMcpServer({
    userId: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    scopes: ["kernel:threads:write"] as never,
    dimensionGrants: {},
    connectionId: crypto.randomUUID(),
    agentDirectory,
  })
  return String((server as unknown as { _instructions?: string })._instructions ?? "")
}

describe("MCP agent directory", () => {
  it("renders each agent's handle, name and purpose in handle order", () => {
    const text = renderMcpAgentDirectory(ROWS)
    expect(text).toContain("- @growth (Growth): Runs advertising and social.")
    expect(text.indexOf("@growth")).toBeLessThan(text.indexOf("@support"))
    expect(text).not.toContain("More detail.")
  })

  it("clips a long purpose", () => {
    const text = renderMcpAgentDirectory([row("@long", "Long", "x".repeat(300))])
    expect(text.split("\n")[1].length).toBeLessThan(120)
  })

  it("renders nothing for an org without agents", () => {
    expect(renderMcpAgentDirectory([])).toBe("")
    expect(renderMcpAgentHeadline([])).toBe("")
  })

  it("caps the list and says how many were cut", () => {
    const many = Array.from({ length: 5 }, (_, i) => row(`@a${i}`, `A${i}`, "x"))
    const text = renderMcpAgentDirectory(many, 3)
    expect(text).toContain("- and 2 more: ask by handle")
    expect(text).not.toContain("@a4")
  })

  it("opens the initialize instructions, inside the 2048 characters a client keeps", () => {
    const kept = instructionsFor(ROWS).slice(0, 2048)
    expect(kept).toContain("NAMED AGENTS")
    expect(kept).toContain("@growth (Growth)")
    expect(kept).toContain("kernel__agents_ask")
    expect(kept).toContain("kernel__subagent_list never lists them")
    // A directory, not the agent persona roster a plain token must never carry.
    expect(instructionsFor(ROWS)).not.toContain(AGENT_ROSTER_OPEN_TAG)
  })

  it("carries each agent's short purpose in the headline, so a client sees what it is for", () => {
    const headline = renderMcpAgentHeadline(ROWS)
    expect(headline).toContain("@growth (Growth): Runs advertising and social.")
    expect(headline).toContain("@support (Support): Answers Tessera customers.")
    expect(headline).not.toContain("More detail.")
    // No purpose set: the name alone, never a dangling colon.
    expect(renderMcpAgentHeadline([row("@ops", "Ops", "")])).toContain("@ops (Ops). To talk")
  })

  it("shortens purposes, then drops them, then cuts agents to fit the headline budget", () => {
    const long = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        row(
          `@agent-${String(i).padStart(2, "0")}`,
          `Agent ${i}`,
          `Handles area ${i} ${"x".repeat(80)}`,
        ),
      )
    const listPart = (h: string) => h.slice(h.indexOf(": ") + 2, h.indexOf(". To talk"))
    for (const n of [1, 4, 8, 12, 20]) {
      expect(listPart(renderMcpAgentHeadline(long(n))).length).toBeLessThanOrEqual(
        MAX_HEADLINE_LIST_CHARS + "; and 99 more".length,
      )
    }
    expect(renderMcpAgentHeadline(long(1))).toContain("@agent-00 (Agent 0): Handles area 0")
    const many = renderMcpAgentHeadline(long(20))
    expect(many).toContain("@agent-00 (Agent 0)")
    expect(many).toMatch(/; and \d+ more\. To talk/)
  })

  it("is absent when the connection was handed no directory", () => {
    expect(instructionsFor()).not.toContain("NAMED AGENTS")
  })

  it("rides on the agents_ask description of the connection", async () => {
    const orgId = crypto.randomUUID()
    await registerKernelAgentTools(orgId)
    try {
      const actor = userContextFor(orgId, crypto.randomUUID(), ["kernel:threads:write"])
      const withDir = await listMcpTools({
        orgId,
        actor,
        agentsAskDirectory: renderMcpAgentDirectory(ROWS),
      })
      const ask = withDir.find((t) => t.name === "kernel__agents_ask")
      expect(ask?.description).toContain("- @growth (Growth)")
      const plain = await listMcpTools({ orgId, actor })
      expect(plain.find((t) => t.name === "kernel__agents_ask")?.description).not.toContain(
        "@growth",
      )
      // Only agents_ask carries it.
      expect(withDir.filter((t) => t.description.includes("- @growth (Growth)"))).toHaveLength(1)
    } finally {
      toolRegistry.deleteByPrefix([orgId])
    }
  })
})

describe("MCP agent directory membership", () => {
  const ORG = crypto.randomUUID()
  const ME = crypto.randomUUID()
  const COLLEAGUE = crypto.randomUUID()
  const tag = ORG.slice(0, 8)
  const ids = {
    growth: crypto.randomUUID(),
    mine: crypto.randomUUID(),
    theirs: crypto.randomUUID(),
    base: crypto.randomUUID(),
    gone: crypto.randomUUID(),
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Dir Org', ${`mcp-dir-${tag}`})`
    for (const [id, name] of [
      [ME, "Me"],
      [COLLEAGUE, "Riley"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, ${`${id.slice(0, 8)}-${tag}@t.com`}, ${name})`
    }
    const rows: Array<[string, string, string, string, string | null]> = [
      [ids.growth, "role", `@growth-${tag}`, "Growth", null],
      [ids.mine, "personal", `@me-${tag}`, "Me", ME],
      [ids.theirs, "personal", `@riley-${tag}`, "Riley", COLLEAGUE],
      [ids.base, "system", "@base", "Liaison", null],
      [ids.gone, "role", `@gone-${tag}`, "Gone", null],
    ]
    for (const [id, kind, handle, name, owner] of rows) {
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
        VALUES (${id}, ${ORG}, ${kind}, ${handle}, ${name}, '[]'::jsonb, ${owner})`
    }
    await sql`UPDATE kernel.agents SET archived_at = now() WHERE id = ${ids.gone}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("lists role agents and my own personal agent, never a colleague's, the system agent or an archived one", async () => {
    const handles = (await loadMcpAgentDirectory(ORG, ME, undefined)).map((r) => r.handle)
    expect(handles.sort()).toEqual([`@growth-${tag}`, `@me-${tag}`].sort())
  })

  it("leaves out the agent the connection is bound to", async () => {
    const handles = (await loadMcpAgentDirectory(ORG, ME, ids.mine)).map((r) => r.handle)
    expect(handles).toEqual([`@growth-${tag}`])
  })
})

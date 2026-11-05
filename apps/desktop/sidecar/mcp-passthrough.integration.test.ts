// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The only proof that the MCP config the sidecar builds actually reaches the
// model is a real turn against a real Liaison gateway, through the compiled
// binary, with the tool names the SDK reports back read off the wire. A shaped
// config object asserted in a unit test proves nothing about the gateway.
//
// Env (a live Liaison box): LIAISON_MCP_URL, LIAISON_MCP_TOKEN,
// LIAISON_AGENT_DEFINITION_FILE, LIAISON_DEFINITION_TOOL_COUNT.
import { describe, expect, it } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { buildOne } from "./build"
import { runSidecar, sidecarEnvironment } from "./integration-harness"

const env = sidecarEnvironment()

describe.skipIf(!env)("liaison MCP passthrough", () => {
  it("surfaces the gateway's whole tool catalog to a haiku turn", async () => {
    const live = env as NonNullable<typeof env>
    const binary = buildOne("bun-darwin-arm64")
    const config = path.join(live.workDir, "mcp.json")
    writeFileSync(
      config,
      JSON.stringify({
        liaisonMcpUrl: live.mcpUrl,
        agentScopedToken: live.mcpToken,
        agentDefinition: readFileSync(live.definitionFile, "utf8"),
      }),
    )

    const run = await runSidecar({
      binary,
      args: ["--mcp-config", config, "--model", live.model, "--permission-mode", "bypass"],
      prompt:
        "Call mcp__liaison__kernel__threads_list with no filters, then reply with the " +
        "single word done.",
      timeoutMs: 180_000,
    })

    const init = run.events.find((event) => event.event === "init")?.payload as {
      model: string
      tools: string[]
      mcp_servers: Array<{ name: string; status: string }>
    }
    expect(init).toBeDefined()

    // The model the flag asked for is the model that answered.
    expect(init.model).toContain("haiku")

    // Liaison is connected. The machine owner's own claude.ai connectors are
    // also in this catalog, which is a leak 6b closes: isolating the CLI
    // config also drops the login, so it is recorded here rather than papered
    // over with an assertion nobody can satisfy yet.
    expect(init.mcp_servers).toContainEqual({ name: "liaison", status: "connected" })

    // Every tool the definition route lists, and no fewer.
    const liaisonTools = init.tools.filter((tool) => tool.startsWith("mcp__liaison__"))
    expect(liaisonTools.length).toBe(live.definitionToolCount)

    // And the catalog is not just present, it is reachable.
    const calls = run.events
      .filter((event) => event.event === "tool_use")
      .flatMap((event) => ((event.payload as any).message?.content ?? []) as any[])
      .filter((block) => block.type === "tool_use")
      .map((block) => block.name as string)
    expect(calls.some((name) => name.startsWith("mcp__liaison__"))).toBe(true)

    // The cold start budget, measured on the wire rather than with a stopwatch.
    expect(run.ready?.sidecarReadyMs).toBeLessThan(3000)
    expect(run.ready?.systemPromptChecksum).toMatch(/^[0-9a-f]{64}$/)
  }, 240_000)
})

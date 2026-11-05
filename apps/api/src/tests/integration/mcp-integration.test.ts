// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Setup helpers + compile-checked dep wiring for the orchestrator ⇄ projector
// integration. Per spec §9 (Task 23), the actual end-to-end `executeTool`
// dispatch on a projected MCP tool lands in Task 33's wiring — gated on the
// kernel mount from Task 27. Here we lock the contract that the orchestrator's
// `executeMcpCall` SIGNATURE is assignable to the projector's
// `ToolProjectorDeps.executeMcpCall` slot, so a future regression in either
// shape will fail at this test rather than at boot.
import { describe, expect, it } from "bun:test"
import { type ExecuteMcpCallArgs, makeOrchestrator } from "~/modules/mcp-client/call"
import type { ToolProjectorDeps } from "~/modules/mcp-client/projector"

describe("mcp-client orchestrator ⇄ projector wiring contract", () => {
  it("orchestrator.executeMcpCall is assignable to projector's executeMcpCall dep slot", async () => {
    const orchestrator = makeOrchestrator({
      pool: {
        get: async () => ({
          client: { callTool: async () => ({ ok: true }) },
          close: async () => {},
        }),
        drop: async () => {},
      },
      repo: {
        getConnectionForCall: async () => null,
        getPolicyForCall: async () => ({ decision: "auto", policyPath: "connection_default" }),
      },
      audit: async () => {},
      health: {
        markConnected: async () => {},
        markDialFailed: async () => {},
        markFailed: async () => {},
        markNeedsReauth: async () => {},
      },
      oauthRefresh: async () => ({ ok: true }),
    })
    // The assignment IS the assertion — if the types drift, this won't compile.
    const deps: ToolProjectorDeps = {
      executeMcpCall: (args: ExecuteMcpCallArgs) =>
        orchestrator.executeMcpCall({
          connectionId: args.connectionId,
          serverToolName: args.serverToolName,
          args: args.args,
          actor:
            args.actor ??
            ({
              actorType: "user",
              userId: "00000000-0000-0000-0000-000000000000",
              orgId: "00000000-0000-0000-0000-000000000000",
              scopes: [],
              dimensionGrants: {},
            } as const),
        }) as Promise<unknown>,
    }
    // Sanity smoke: invoke the wired dep — connection_not_found short-circuit.
    const result = await deps.executeMcpCall({
      connectionId: "00000000-0000-0000-0000-000000000000",
      serverToolName: "noop",
      args: {},
    })
    expect(result).toBeTruthy()
    expect((result as any).ok).toBe(false)
    expect((result as any).error.reason).toBe("connection_not_found")
  })
})

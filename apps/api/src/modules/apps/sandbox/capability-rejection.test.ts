// SPDX-License-Identifier: FSL-1.1-ALv2
// Single home for capability/channel negative-path security tests. Future
// regressions in capability gating (forgetting `requireCapability` on a new
// RPC method, dropping the channel validator) trip these tests. The shape
// matches the codebase's two-axis attack surface: (a) capability missing →
// CAPABILITY_NOT_DECLARED, (b) channel outside app namespace → CHANNEL_NOT_OWNED.
import { describe, expect, it } from "bun:test"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const TEST_ORG = "00000000-0000-0000-0000-000000c50001"
const TEST_USER = "00000000-0000-0000-0000-000000c50002"

const userActor = {
  actorType: "user" as const,
  userId: TEST_USER,
  orgId: TEST_ORG,
  scopes: ["chaos-debug:*"],
  dimensionGrants: {},
}

const mockTx = { execute: async () => [] } as any

describe("capability enforcement at RPC entry", () => {
  it("agent_run on an app without capability returns CAPABILITY_NOT_DECLARED", async () => {
    const bridge = createRpcBridge(
      "no-caps-app",
      TEST_USER,
      TEST_ORG,
      mockTx,
      { name: "no-caps-app", schema: {}, capabilities: [] } as any,
      ["no-caps-app:*"],
      "user",
      undefined,
      { actor: userActor },
    )
    const r = JSON.parse(await bridge.agent_run(JSON.stringify({ threadId: "t", prompt: "p" })))
    expect(r.error?.code).toBe("CAPABILITY_NOT_DECLARED")
  })

  it("realtime_publish on an app without capability returns CAPABILITY_NOT_DECLARED", async () => {
    const bridge = createRpcBridge("no-caps-app", TEST_USER, TEST_ORG, mockTx, {
      name: "no-caps-app",
      schema: {},
      capabilities: [],
    } as any)
    const r = JSON.parse(await bridge.realtime_publish("apps/no-caps-app/x", JSON.stringify({})))
    expect(r.error?.code).toBe("CAPABILITY_NOT_DECLARED")
  })

  // Phase 16 Task A1 — `grants.setUserScopes` is gated on the same axis.
  it("grants_setUserScopes on an app without capability returns CAPABILITY_NOT_DECLARED", async () => {
    const bridge = createRpcBridge("no-caps-app", TEST_USER, TEST_ORG, mockTx, {
      name: "no-caps-app",
      schema: {},
      capabilities: [],
    } as any)
    const r = JSON.parse(
      await bridge.grants_setUserScopes(
        "00000000-0000-0000-0000-000000c50099",
        JSON.stringify(["no-caps-app:foo"]),
      ),
    )
    expect(r.error?.code).toBe("CAPABILITY_NOT_DECLARED")
  })

  it("realtime_publish to a foreign app's channel returns CHANNEL_NOT_OWNED", async () => {
    const bridge = createRpcBridge("chaos-debug", TEST_USER, TEST_ORG, mockTx, {
      name: "chaos-debug",
      schema: {},
      capabilities: ["realtime.publish"],
    } as any)
    const r = JSON.parse(await bridge.realtime_publish("apps/mail/inbox/1", JSON.stringify({})))
    expect(r.error?.code).toBe("CHANNEL_NOT_OWNED")
  })

  it("realtime_publish to a bare channel name returns CHANNEL_NOT_OWNED", async () => {
    const bridge = createRpcBridge("chaos-debug", TEST_USER, TEST_ORG, mockTx, {
      name: "chaos-debug",
      schema: {},
      capabilities: ["realtime.publish"],
    } as any)
    const r = JSON.parse(await bridge.realtime_publish("random:channel", JSON.stringify({})))
    expect(r.error?.code).toBe("CHANNEL_NOT_OWNED")
  })

  it("agent_run with a foreign channel param returns CHANNEL_NOT_OWNED (defense in depth)", async () => {
    const bridge = createRpcBridge(
      "chaos-debug",
      TEST_USER,
      TEST_ORG,
      mockTx,
      { name: "chaos-debug", schema: {}, capabilities: ["agent.run"] } as any,
      ["chaos-debug:*"],
      "user",
      undefined,
      { actor: userActor },
    )
    const r = JSON.parse(
      await bridge.agent_run(
        JSON.stringify({ threadId: "t", prompt: "p", channel: "apps/mail/inbox/1" }),
      ),
    )
    expect(r.error?.code).toBe("CHANNEL_NOT_OWNED")
  })

  it("agent_run with capability declared but no actor throws (event-driven not callable)", async () => {
    const bridge = createRpcBridge("chaos-debug", TEST_USER, TEST_ORG, mockTx, {
      name: "chaos-debug",
      schema: {},
      capabilities: ["agent.run"],
    } as any)
    await expect(bridge.agent_run(JSON.stringify({ threadId: "t", prompt: "p" }))).rejects.toThrow(
      /requires a user actor|not available in event-driven handlers/i,
    )
  })

  it("realtime_publish with a bare (no apps/ prefix) channel returns CHANNEL_NOT_OWNED", async () => {
    const bridge = createRpcBridge("chaos-debug", TEST_USER, TEST_ORG, mockTx, {
      name: "chaos-debug",
      schema: {},
      capabilities: ["realtime.publish"],
    } as any)
    const r = JSON.parse(await bridge.realtime_publish("random:channel", JSON.stringify({})))
    expect(r.error?.code).toBe("CHANNEL_NOT_OWNED")
  })
})

// SECURITY — Vuln 1 (security review 2026-05-23). Redis pub/sub's PSUBSCRIBE
// treats `*`, `?`, `[`, `]` as glob metacharacters. A channel-name validator
// that only blocks whitespace/null would let a publisher craft channel names
// that intersect cross-app PSUBSCRIBE patterns, becoming a payload-injection
// primitive into other apps' streams. The bridge uses a *positive* ASCII
// allowlist `[a-zA-Z0-9/_.-]+` plus a path-traversal segment check.
describe("realtime_publish — channel name allowlist (security, Vuln 1)", () => {
  const malformedChannels: Array<[string, string]> = [
    ["apps/chaos-debug/agent-stream/*", "wildcard"],
    ["apps/chaos-debug/agent-stream/?", "single-char wildcard"],
    ["apps/chaos-debug/agent-stream/[abc]", "character class"],
    ["apps/chaos-debug/agent-stream/\\x", "escape backslash"],
    ["apps/chaos-debug/../mail/inbox", "parent-segment traversal"],
    ["apps/chaos-debug/./agent-stream/x", "current-segment"],
    ["apps/chaos-debug/agent-stream/a:b", "colon"],
    ["apps/chaos-debug/agent-stream/a b", "space"],
    ["apps/chaos-debug/agent-stream/héllo", "non-ascii"],
    ["apps/chaos-debug/agent-stream/a%20b", "percent-encoded"],
  ]
  for (const [channel, label] of malformedChannels) {
    it(`rejects ${label}: ${channel}`, async () => {
      const bridge = createRpcBridge("chaos-debug", TEST_USER, TEST_ORG, mockTx, {
        name: "chaos-debug",
        schema: {},
        capabilities: ["realtime.publish"],
      } as any)
      const r = JSON.parse(await bridge.realtime_publish(channel, JSON.stringify({})))
      expect(r.error?.code).toBe("CHANNEL_MALFORMED")
    })
  }

  it("accepts every channel shape the plan uses (allowlist regression guard)", async () => {
    const { RedisTestAccess } = await import("~/lib/redis")
    RedisTestAccess.setPublish(async () => 1)
    try {
      const bridge = createRpcBridge("chaos-debug", TEST_USER, TEST_ORG, mockTx, {
        name: "chaos-debug",
        schema: {},
        capabilities: ["realtime.publish"],
      } as any)
      for (const ch of [
        "apps/chaos-debug/agent-stream/abc123",
        "apps/chaos-debug/agent-stream/corr_1-2_abc",
        "apps/chaos-debug/timeline/run-2026.05.23",
        "apps/chaos-debug/x/y/z/deep/nesting",
      ]) {
        const r = JSON.parse(await bridge.realtime_publish(ch, JSON.stringify({})))
        expect(r.error).toBeUndefined()
      }
    } finally {
      RedisTestAccess.setPublish(undefined)
    }
  })
})

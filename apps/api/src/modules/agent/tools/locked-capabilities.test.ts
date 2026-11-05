// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { listLockedCapabilities } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_A = "00000000-0000-0000-0000-0000007c0001"
const ORG_B = "00000000-0000-0000-0000-0000007c0002"

describe("listLockedCapabilities", () => {
  beforeAll(async () => {
    await acquireTestLock()
    toolRegistry.set([ORG_A, "mail", "reply"], {
      appName: "mail",
      name: "reply",
      description: "Reply to a mail conversation",
      requiredScopes: ["mail:conversations:write"],
      handler: async () => ({}),
    })
    toolRegistry.set([ORG_A, "kernel", "threads_read"], {
      appName: "kernel",
      name: "threads_read",
      description: "Read threads",
      requiredScopes: ["kernel:threads:read"],
      handler: async () => ({}),
    })
    toolRegistry.set([ORG_A, "secret", "hidden"], {
      appName: "secret",
      name: "hidden",
      description: "Hidden from agents",
      requiredScopes: ["secret:do"],
      agentVisible: false,
      handler: async () => ({}),
    })
    // Other-org tool — must never leak.
    toolRegistry.set([ORG_B, "secret", "thing"], {
      appName: "secret",
      name: "thing",
      description: "Other org tool",
      requiredScopes: ["secret:do"],
      handler: async () => ({}),
    })
    // A kernel spawn_agent tool. `agent.spawn` is now a kernel-universal
    // capability, so the capability gate always passes — granting
    // `kernel:agents:spawn` genuinely unlocks the tool, so it IS a real
    // scope-lockable capability for an actor who lacks that scope.
    toolRegistry.set([ORG_A, "kernel", "spawn_agent"], {
      appName: "kernel",
      name: "spawn_agent",
      description: "Spawn a sub-agent",
      requiredScopes: ["kernel:agents:spawn"],
      handler: async () => ({}),
    })
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_A])
    toolRegistry.deleteByPrefix([ORG_B])
    await releaseTestLock()
  })

  it("lists tools the agent lacks scope for, with their required scope — org-scoped only", () => {
    const locked = listLockedCapabilities(["kernel:threads:read"], ORG_A)
    expect(locked).toContainEqual(
      expect.objectContaining({ name: "mail__reply", scope: "mail:conversations:write" }),
    )
    // Never leaks orgB tools.
    expect(locked.find((t) => t.name === "secret__thing")).toBeUndefined()
    // agentVisible:false tools are not scope-lockable → excluded.
    expect(locked.find((t) => t.name === "secret__hidden")).toBeUndefined()
  })

  it("excludes tools the agent already has scope for", () => {
    const locked = listLockedCapabilities(
      ["mail:conversations:write", "kernel:threads:read"],
      ORG_A,
    )
    expect(locked.find((t) => t.name === "mail__reply")).toBeUndefined()
  })

  it("INCLUDES kernel spawn_agent as a locked capability with no apps installed (agent.spawn is kernel-universal)", () => {
    // `agent.spawn` is kernel-universal → orgHasCapability(ORG_A, "agent.spawn") is
    // always true, so the capability gate passes and spawn_agent is NOT suppressed.
    // An actor lacking `kernel:agents:spawn` therefore sees it as a genuinely
    // scope-lockable capability — granting the scope unlocks it.
    const locked = listLockedCapabilities(["kernel:threads:read"], ORG_A)
    expect(locked).toContainEqual(
      expect.objectContaining({ name: "kernel__spawn_agent", scope: "kernel:agents:spawn" }),
    )
  })
})

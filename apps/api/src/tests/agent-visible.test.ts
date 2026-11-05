// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { buildToolSet, listDeferredTools } from "~/modules/agent/tools/tool-bridge"
import { appDependenciesRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = "00000000-0000-0000-0000-000000000bbb"

const ACTOR_AGENT = {
  actorType: "agent" as const,
  userId: "00000000-0000-0000-0000-000000000ccc",
  orgId: ORG,
  scopes: ["fake:res:read"],
  dimensionGrants: {},
} as any

const ACTOR_USER = {
  actorType: "user" as const,
  userId: "00000000-0000-0000-0000-000000000ccd",
  orgId: ORG,
  scopes: ["fake:res:read"],
  dimensionGrants: {},
} as any

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'AgentVisible Org', 'agent-visible-org') ON CONFLICT DO NOTHING`

  toolRegistry.set([ORG, "fake", "hidden"], {
    appName: "fake",
    name: "hidden",
    description: "h",
    requiredScopes: ["fake:res:read"],
    handler: async () => ({ ok: true }),
    deferLoading: true,
    agentVisible: false,
  } as any)
  toolRegistry.set([ORG, "fake", "visible"], {
    appName: "fake",
    name: "visible",
    description: "v",
    requiredScopes: ["fake:res:read"],
    handler: async () => ({ ok: true }),
    deferLoading: true,
  } as any)
  toolRegistry.set([ORG, "fake", "default"], {
    appName: "fake",
    name: "default",
    description: "d",
    requiredScopes: ["fake:res:read"],
    handler: async () => ({ ok: true }),
    deferLoading: true,
  } as any)
  // Tool that echoes a counter from params; used for direct-call idempotency tests.
  let counter = 0
  toolRegistry.set([ORG, "fake", "counted"], {
    appName: "fake",
    name: "counted",
    description: "counted",
    requiredScopes: ["fake:res:read"],
    handler: async () => {
      counter += 1
      return { count: counter }
    },
    params: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
        flavor: { type: "string" },
      },
    },
  } as any)
  toolRegistry.set([ORG, "bridge_target", "noOp"], {
    appName: "bridge_target",
    name: "noOp",
    description: "no-op bridge target",
    requiredScopes: ["bridge:read"],
    trustBoundary: "internal",
    deferLoading: true,
    handler: async () => ({ ok: true }),
  } as any)
  appDependenciesRegistry.set([ORG, "bridge_src"], { tools: ["bridge_target:noOp"] })
})

afterAll(() => {
  toolRegistry.delete([ORG, "fake", "hidden"])
  toolRegistry.delete([ORG, "fake", "visible"])
  toolRegistry.delete([ORG, "fake", "default"])
  toolRegistry.delete([ORG, "fake", "counted"])
  toolRegistry.delete([ORG, "bridge_target", "noOp"])
  appDependenciesRegistry.delete([ORG, "bridge_src"])
})

describe("agentVisible flag", () => {
  it("hides tool from listDeferredTools", () => {
    const deferred = listDeferredTools(ORG, ACTOR_AGENT)
    expect(deferred.find((t) => t.toolName === "hidden")).toBeUndefined()
    expect(deferred.find((t) => t.toolName === "visible")?.toolName).toBe("visible")
  })

  it("hides tool from buildToolSet even when discovered", () => {
    const set = buildToolSet(
      ORG,
      ACTOR_AGENT,
      undefined,
      new Set(["fake__hidden", "fake__visible"]),
    )
    expect(set.fake__hidden).toBeUndefined()
    expect(set.fake__visible).toBeDefined()
  })

  it("exact-name agent invocation of agentVisible:false returns forbidden", async () => {
    const env = await executeToolCore({
      toolName: "fake:hidden",
      orgId: ORG,
      actor: ACTOR_AGENT,
      params: {},
      origin: "in-app-agent",
    })
    expect("error" in env).toBe(true)
    if ("error" in env) {
      expect(env.error.code).toBe("forbidden")
    }
  })

  it("omitted agentVisible defaults to visible", () => {
    const set = buildToolSet(ORG, ACTOR_AGENT, undefined, new Set(["fake__default"]))
    expect(Object.keys(set).length).toBeGreaterThanOrEqual(1)
  })
})

describe("bridge wrapper overhead", () => {
  it("keeps cross-app executeTool wrapper p95 under 50ms", async () => {
    const bridge = createRpcBridge(
      "bridge_src",
      ACTOR_USER.userId,
      ORG,
      sql as any,
      { name: "bridge_src", schema: {}, events: { emits: [] } },
      ["bridge:read"],
      "user",
      undefined,
      { actor: { ...ACTOR_USER, scopes: ["bridge:read"] }, callChain: [] },
    )
    // The p95 of 40 calls, sampled up to three times: a busy machine (every
    // suite of a gate at once) only ever ADDS time, so the best sample is the
    // wrapper's own cost, while an overhead regression is slow in every one.
    const sampleP95 = async (): Promise<number> => {
      const durations: number[] = []
      for (let i = 0; i < 40; i++) {
        const start = performance.now()
        const result = JSON.parse(await bridge.executeTool("bridge_target:noOp", "{}"))
        durations.push(performance.now() - start)
        expect(result.data).toEqual({ ok: true })
      }
      durations.sort((a, b) => a - b)
      return durations[Math.floor((durations.length - 1) * 0.95)] as number
    }
    let best = Number.POSITIVE_INFINITY
    for (let sample = 0; sample < 3 && best > 50; sample++) {
      best = Math.min(best, await sampleP95())
    }
    expect(best).toBeLessThanOrEqual(50)
  })
})

describe("direct-call idempotency via params.idempotencyKey", () => {
  it("first call records, replay returns cached envelope", async () => {
    const key = `idem-${Date.now()}-a`
    const r1 = await executeToolCore({
      toolName: "fake:counted",
      orgId: ORG,
      actor: ACTOR_USER,
      origin: "in-app-agent",
      params: { idempotencyKey: key, flavor: "a" },
    })
    expect("data" in r1).toBe(true)
    const firstCount = (r1 as any).data.count

    const r2 = await executeToolCore({
      toolName: "fake:counted",
      orgId: ORG,
      actor: ACTOR_USER,
      origin: "in-app-agent",
      params: { idempotencyKey: key, flavor: "a" },
    })
    expect("data" in r2).toBe(true)
    expect((r2 as any).data.count).toBe(firstCount)
  })

  it("same key with different params returns idempotency_conflict", async () => {
    const key = `idem-${Date.now()}-b`
    await executeToolCore({
      toolName: "fake:counted",
      orgId: ORG,
      actor: ACTOR_USER,
      origin: "in-app-agent",
      params: { idempotencyKey: key, flavor: "a" },
    })
    const r2 = await executeToolCore({
      toolName: "fake:counted",
      orgId: ORG,
      actor: ACTOR_USER,
      origin: "in-app-agent",
      params: { idempotencyKey: key, flavor: "b" },
    })
    expect("error" in r2).toBe(true)
    if ("error" in r2) {
      expect(r2.error.code).toBe("idempotency_conflict")
    }
  })

  it("same key and params while first call is pending returns idempotency_in_flight", async () => {
    const key = `idem-${Date.now()}-pending`
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    toolRegistry.set([ORG, "fake", "delayed"], {
      appName: "fake",
      name: "delayed",
      description: "delayed",
      requiredScopes: ["fake:res:read"],
      handler: async () => {
        started()
        await releasePromise
        return { ok: true }
      },
      params: {
        type: "object",
        properties: { idempotencyKey: { type: "string" }, flavor: { type: "string" } },
      },
    } as any)

    const first = executeToolCore({
      toolName: "fake:delayed",
      orgId: ORG,
      actor: ACTOR_USER,
      origin: "in-app-agent",
      params: { idempotencyKey: key, flavor: "same" },
    })
    await startedPromise
    const second = await executeToolCore({
      toolName: "fake:delayed",
      orgId: ORG,
      actor: ACTOR_USER,
      origin: "in-app-agent",
      params: { idempotencyKey: key, flavor: "same" },
    })
    release()
    await first

    expect("error" in second).toBe(true)
    if ("error" in second) expect(second.error.code).toBe("idempotency_in_flight")
    toolRegistry.delete([ORG, "fake", "delayed"])
  })
})

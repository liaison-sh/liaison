// SPDX-License-Identifier: FSL-1.1-ALv2
// The counted test write tools of the turn-resume scenarios (P3 T9, M12):
// effect_then_wait counts before it waits, wait_then_effect after, both in
// Redis so every process of a cell counts into one number.
import { afterAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { redis } from "~/lib/redis"
import { toolRegistry } from "~/modules/apps/app-registries"
import { effectCount, effectCountKey, registerTestEffectTools } from "./test-effect-tools"

const ORG = crypto.randomUUID()
const keys: string[] = []

function handlerOf(name: string) {
  const handler = toolRegistry.get([ORG, "kernel", name])?.handler
  if (typeof handler !== "function") throw new Error(`${name} is not registered`)
  return handler
}

afterAll(async () => {
  if (keys.length > 0) await redis.del(...keys.map(effectCountKey))
})

describe("test effect tools", () => {
  it("are registered as kernel write tools (not read-only)", () => {
    registerTestEffectTools(ORG)
    for (const name of ["test_effect_then_wait", "test_wait_then_effect"]) {
      const def = toolRegistry.get([ORG, "kernel", name])
      expect(def?.readOnly).toBeUndefined()
      expect(def?.requiredScopes.length).toBeGreaterThan(0)
    }
  })

  it("effect_then_wait counts before it waits", async () => {
    const key = `etw-${crypto.randomUUID()}`
    keys.push(key)
    const run = handlerOf("test_effect_then_wait")({ key, waitMs: 300 }, {})
    await Bun.sleep(100)
    expect(await effectCount(key)).toBe(1)
    expect(await run).toEqual({ key, count: 1 })
  })

  it("wait_then_effect counts after it waits", async () => {
    const key = `wte-${crypto.randomUUID()}`
    keys.push(key)
    const run = handlerOf("test_wait_then_effect")({ key, waitMs: 300 }, {})
    await Bun.sleep(100)
    expect(await effectCount(key)).toBe(0)
    expect(await run).toEqual({ key, count: 1 })
    expect(await effectCount(key)).toBe(1)
  })
})

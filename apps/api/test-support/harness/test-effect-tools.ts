// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two test-only write tools for the turn-resume scenarios (S10): each counts
// its outside effect in Redis, so a scenario can assert that a turn cut
// mid-tool and resumed elsewhere caused the effect once.
//
//   kernel__test_effect_then_wait  INCR first, then waits `waitMs`
//   kernel__test_wait_then_effect  waits `waitMs`, then INCRs
//
// The count lives under `effect:test:<key>`, `key` being the call's own
// argument, so every process of the cell counts into the same number. A
// scripted step's `toolDelayMs` reaches them as `waitMs`
// (scripted-model-provider.ts). Neither tool is read-only: they are writes,
// as far as the tool bridge and the effect ledger can tell.
//
// Registered per org and per process: `POST /api/_test/effect-tools` on each
// process that may run (or resume) the turn. Mounted only when
// `qaSeedRoutesEnabled`; never part of the production image.
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { toolRegistry } from "~/modules/apps/app-registries"

export const TEST_EFFECT_TOOLS = ["test_effect_then_wait", "test_wait_then_effect"] as const

const params = z.object({
  key: z.string().min(1).max(200),
  waitMs: z.number().int().min(0).max(120_000).optional(),
})

export function effectCountKey(key: string): string {
  return `effect:test:${key}`
}

/** How many times the effect named `key` happened, cell-wide. */
export async function effectCount(key: string): Promise<number> {
  return Number((await redis.get(effectCountKey(key))) ?? 0)
}

/** Register both tools for `orgId` in this process's tool registry. */
export function registerTestEffectTools(orgId: string): void {
  for (const name of TEST_EFFECT_TOOLS) {
    const effectFirst = name === "test_effect_then_wait"
    toolRegistry.set([orgId, "kernel", name], {
      appName: "kernel",
      name,
      description: effectFirst
        ? "Test only: record one effect, then wait waitMs."
        : "Test only: wait waitMs, then record one effect.",
      requiredScopes: ["kernel:threads:read"],
      params,
      handler: async (raw: unknown) => {
        const args = params.parse(raw)
        const wait = () => (args.waitMs ? Bun.sleep(args.waitMs) : Promise.resolve())
        if (!effectFirst) await wait()
        const count = await redis.incr(effectCountKey(args.key))
        if (effectFirst) await wait()
        return { key: args.key, count }
      },
    })
  }
}

export const testEffectToolRoutes = new Hono<AppEnv>()

/** POST /api/_test/effect-tools — register the tools for an org in THIS process. */
testEffectToolRoutes.post(
  "/",
  zValidator("json", z.object({ orgId: z.string().uuid() })),
  async (c) => {
    if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
    const { orgId } = c.req.valid("json")
    registerTestEffectTools(orgId)
    return success(c, { orgId, tools: TEST_EFFECT_TOOLS.map((t) => `kernel__${t}`) })
  },
)

/** GET /api/_test/effect-tools/count?key= — the effect's cell-wide count. */
testEffectToolRoutes.get("/count", async (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  const key = c.req.query("key")
  if (!key) throw new HTTPException(400, { message: "key is required" })
  return success(c, { key, count: await effectCount(key) })
})

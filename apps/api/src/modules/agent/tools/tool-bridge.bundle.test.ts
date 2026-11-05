// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000cb0099"

describe("buildToolSet step bundle plumbing", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    await releaseTestLock()
  })

  test("buildToolSet accepts stepCtx as a 7th arg and forwards each execute call", async () => {
    // Smoke test: ensure the new optional `stepCtx` parameter to buildToolSet
    // is accepted without error and the returned tools can still be invoked.
    // The actual stepCtx-read-at-call-time semantic is asserted end-to-end via
    // DB row bundle_id observation in `tool-bridge.parallel-bundle.test.ts`
    // (Task 5), where mutating stepCtx between calls produces distinguishable
    // DB outcomes — the only way to observe the seam without intrusive spies.
    toolRegistry.set([ORG_ID, "t", "noop"], {
      appName: "t",
      name: "noop",
      description: "no-op",
      requiredScopes: ["t:read"],
      handler: async () => ({ ok: true }),
      params: z.object({}),
    })

    const actor: UserContext = {
      actorType: "user",
      userId: "user1",
      orgId: ORG_ID,
      scopes: ["t:read"],
      dimensionGrants: {},
    }

    // Backward-compatible: omit stepCtx entirely.
    const toolsNoCtx = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const r1 = await (toolsNoCtx.t__noop as any).execute({}, {})
    expect((r1 as any).ok).toBe(true)

    // With stepCtx — same tool surface, no signature regression.
    const stepCtx = { stepBundleId: null as string | null }
    const tools = buildToolSet(
      ORG_ID,
      actor,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      undefined,
      stepCtx,
    )
    const r2 = await (tools.t__noop as any).execute({}, {})
    expect((r2 as any).ok).toBe(true)

    // Mutating stepCtx between calls is non-breaking. (The real DB-level
    // observation lives in Task 5's parallel-bundle integration test.)
    stepCtx.stepBundleId = "bundle-A"
    const r3 = await (tools.t__noop as any).execute({}, {})
    expect((r3 as any).ok).toBe(true)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { autoApprovePolicies } from "~/db/schema/kernel"
import { checkToolScopes } from "~/modules/agent/scopes/required-scopes"
import {
  handlePolicyGet,
  handlePolicySet,
  policySetParamsSchema,
} from "~/modules/agent/tools/skills-routines-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  RequesterLostScopeError,
  runApprovedToolHandler,
} from "~/modules/apps/run-approved-handler"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Hermetic copy of execute-tool (neighbouring files mock.module() it).
const { executeTool } = (await import(
  `${import.meta.dir}/../../apps/execute-tool.ts?hermetic=policy-tools-admin-only`
)) as typeof import("~/modules/apps/execute-tool")

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  await releaseTestLock()
})

describe("policy_get / policy_set tools", () => {
  test("policy_set params schema requires toolName + conditions/limits shape", () => {
    expect(
      policySetParamsSchema.safeParse({
        toolName: "shopify:refund_create",
        conditions: [{ path: "params.amount.minor", op: "lte", value: 5000 }],
        limits: { windowSeconds: 86400, windowMax: 20000 },
      }).success,
    ).toBe(true)
    expect(policySetParamsSchema.safeParse({ conditions: [] }).success).toBe(false) // no toolName
  })
  test("policy_set upserts a per-org policy; policy_get reads it back", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    const ctx = {
      orgId: u.orgId,
      userId: u.id,
      actorType: "user" as const,
      scopes: ["kernel:policies:write"],
      approverUserId: u.id,
    }
    await handlePolicySet(
      {
        toolName: "tickets:reply_send",
        enabled: true,
        conditions: [],
        limits: { windowSeconds: 3600, windowMax: 50 },
      },
      ctx as never,
    )
    const got = await handlePolicyGet({}, {
      orgId: u.orgId,
      userId: u.id,
      actorType: "user",
      scopes: ["kernel:policies:read"],
    } as never)
    expect(
      (got as { policies: Array<{ toolName: string }> }).policies.some(
        (p) => p.toolName === "tickets:reply_send",
      ),
    ).toBe(true)
  })
  test("policy_set with the same toolName updates rather than duplicating (unique org+tool)", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    const ctx = {
      orgId: u.orgId,
      userId: u.id,
      actorType: "user" as const,
      scopes: ["kernel:policies:write"],
      approverUserId: u.id,
    }
    await handlePolicySet(
      {
        toolName: "shopify:refund_create",
        enabled: true,
        conditions: [],
        limits: { perCallMax: 1000 },
      },
      ctx as never,
    )
    await handlePolicySet(
      {
        toolName: "shopify:refund_create",
        enabled: true,
        conditions: [],
        limits: { perCallMax: 5000 },
      },
      ctx as never,
    )
    const rows = await withSystemDb("t", (db) => db.select().from(autoApprovePolicies))
    const mine = rows.filter((r) => r.orgId === u.orgId && r.toolName === "shopify:refund_create")
    expect(mine.length).toBe(1)
    expect((mine[0].limits as { perCallMax?: number }).perCallMax).toBe(5000)
  })
})

// S28 (owner ruling 2026-09-28): auto-approve policies LOOSEN a gate, so writing
// one is an admin authority, like approval_policy_set. `kernel:policies:write`
// alone no longer reaches policy_set, through the real scope rule every path
// applies (catalog, invoke, approval re-entry).
describe("policy_set is admin-only (kernel:policies:admin)", () => {
  const WRITE_ONLY = ["kernel:threads:read", "kernel:policies:read", "kernel:policies:write"]
  const ADMIN = ["kernel:threads:read", "kernel:policies:read", "kernel:policies:admin"]
  let orgId: string
  let userId: string

  beforeAll(async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    orgId = u.orgId
    userId = u.id
    await ensureAppsForOrg(orgId, {})
  }, 60_000)

  function actor(scopes: string[]): UserContext {
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
  }

  test("the registered tool requires kernel:policies:admin", () => {
    const def = toolRegistry.get([orgId, "kernel", "policy_set"]) as {
      requiredScopes?: string[]
    }
    expect(def.requiredScopes).toEqual(["kernel:policies:admin"])
    expect(checkToolScopes(def, WRITE_ONLY).authorized).toBe(false)
    expect(checkToolScopes(def, ADMIN).authorized).toBe(true)
  })

  test("a policies:write caller does not see policy_set; an admin does", () => {
    const listed = (scopes: string[]) =>
      Object.keys(
        buildToolSet(orgId, actor(scopes) as ActorContext, undefined, ALL_DEFERRED_TOOLS_UNLOCKED),
      ).filter((k) => k === "kernel__policy_set")
    expect(listed(WRITE_ONLY)).toEqual([])
    expect(listed(ADMIN).length).toBe(1)
  })

  test("a policies:write caller is refused forbidden through execute-tool", async () => {
    let code: string | undefined
    try {
      await executeTool({
        toolName: "kernel:policy_set",
        orgId,
        actor: actor(WRITE_ONLY) as ActorContext,
        origin: "in-app-agent",
        params: { toolName: "tickets:reply_send", conditions: [], limits: { windowMax: 5 } },
      })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe("forbidden")
  })

  test("an approval raised before the change is refused requester_lost_scope unless the decider is an admin", async () => {
    const probe = `tickets:lost_scope_probe_${crypto.randomUUID().slice(0, 8)}`
    const run = (deciderScopes: string[]) =>
      runApprovedToolHandler({
        orgId,
        requesterContext: actor(WRITE_ONLY),
        deciderId: userId,
        deciderContext: { ...actor(deciderScopes), userId: crypto.randomUUID() },
        toolName: "kernel:policy_set",
        payload: { toolName: probe, conditions: [], limits: {} },
        approvalRequestId: crypto.randomUUID(),
        threadId: crypto.randomUUID(),
      })
    await expect(run(["kernel:approve", "kernel:policies:write"])).rejects.toBeInstanceOf(
      RequesterLostScopeError,
    )
    const rows = await withSystemDb("t", (db) => db.select().from(autoApprovePolicies))
    expect(rows.filter((r) => r.orgId === orgId && r.toolName === probe)).toEqual([])
  })
})

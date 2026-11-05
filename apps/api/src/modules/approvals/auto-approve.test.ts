// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { autoApprovePolicies } from "~/db/schema/kernel"
import { evaluateAutoApprove } from "~/modules/approvals/auto-approve"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
beforeAll(async () => {
  await acquireTestLock()
  const u = await minimal.orgAdmin((await createTestOrg()).id)
  orgId = u.orgId
  userId = u.id
  await withSystemDb("t", (db) =>
    db.insert(autoApprovePolicies).values({
      orgId,
      toolName: "shopify:refund_create",
      enabled: true,
      conditions: [{ path: "params.amount.minor", op: "lte", value: 5000 }],
      limits: { perCallMax: 5000, windowSeconds: 86400, windowMax: 20000 },
      requiresScope: "shopify:approve",
      createdBy: userId,
    }),
  )
})
afterAll(async () => {
  await releaseTestLock()
})
const actor = () => ({
  actorType: "user" as const,
  userId,
  orgId,
  scopes: ["shopify:approve"],
  dimensionGrants: {},
})

describe("evaluateAutoApprove", () => {
  test("auto-approves a refund under the threshold", async () => {
    const r = await evaluateAutoApprove({
      orgId,
      toolName: "shopify:refund_create",
      params: { amount: { minor: 4000, currency: "EUR" } },
      actor: actor(),
      appName: "shopify",
    })
    expect(r.decision).toBe("auto_approve")
  })
  test("gates a refund over the per-call threshold", async () => {
    const r = await evaluateAutoApprove({
      orgId,
      toolName: "shopify:refund_create",
      params: { amount: { minor: 9000, currency: "EUR" } },
      actor: actor(),
      appName: "shopify",
    })
    expect(r.decision).toBe("gate")
  })
  test("gates when no policy matches the tool (fail-closed)", async () => {
    const r = await evaluateAutoApprove({
      orgId,
      toolName: "boxtal:label_create",
      params: {},
      actor: actor(),
      appName: "boxtal",
    })
    expect(r.decision).toBe("gate")
  })
  test("gates a disabled policy even when conditions pass", async () => {
    await withSystemDb("t", (db) =>
      db.insert(autoApprovePolicies).values({
        orgId,
        toolName: "tickets:reply_send",
        enabled: false,
        conditions: [],
        limits: {},
        requiresScope: "tickets:approve",
        createdBy: userId,
      }),
    )
    const r = await evaluateAutoApprove({
      orgId,
      toolName: "tickets:reply_send",
      params: {},
      actor: actor(),
      appName: "tickets",
    })
    expect(r.decision).toBe("gate")
  })
  test("gates when the actor lacks the policy's requiresScope (no silent privilege grant)", async () => {
    const weak = {
      actorType: "user" as const,
      userId,
      orgId,
      scopes: ["shopify:refund_create"],
      dimensionGrants: {},
    }
    const r = await evaluateAutoApprove({
      orgId,
      toolName: "shopify:refund_create",
      params: { amount: { minor: 4000, currency: "EUR" } },
      actor: weak,
      appName: "shopify",
    })
    expect(r.decision).toBe("gate")
    expect(r.reason).toBe("actor_lacks_required_scope")
  })
  test("window cap: (windowMax/perCallMax)+1-th call within the window gates", async () => {
    // Use a fresh policy + org so the window counter is not polluted by earlier cases.
    const u2 = await minimal.orgAdmin((await createTestOrg()).id)
    await withSystemDb("t", (db) =>
      db.insert(autoApprovePolicies).values({
        orgId: u2.orgId,
        toolName: "shopify:refund_create",
        enabled: true,
        conditions: [{ path: "params.amount.minor", op: "lte", value: 5000 }],
        limits: { perCallMax: 5000, windowSeconds: 86400, windowMax: 20000 },
        requiresScope: "shopify:approve",
        createdBy: u2.id,
      }),
    )
    const a2 = {
      actorType: "user" as const,
      userId: u2.id,
      orgId: u2.orgId,
      scopes: ["shopify:approve"],
      dimensionGrants: {},
    }
    const call = () =>
      evaluateAutoApprove({
        orgId: u2.orgId,
        toolName: "shopify:refund_create",
        params: { amount: { minor: 5000, currency: "EUR" } },
        actor: a2,
        appName: "shopify",
      })
    const results = [await call(), await call(), await call(), await call(), await call()]
    expect(results.slice(0, 4).every((r) => r.decision === "auto_approve")).toBe(true)
    expect(results[4].decision).toBe("gate")
  })
  test("RLS org-isolation: a second org cannot read org-1's policy", async () => {
    const other = await minimal.orgAdmin((await createTestOrg()).id)
    const visible = await withRlsContext(
      {
        actorType: "user",
        userId: other.id,
        orgId: other.orgId,
        scopes: ["kernel:approve"],
        dimensionGrants: {},
      },
      (tx) => tx.select().from(autoApprovePolicies),
    )
    expect(visible.some((p) => p.orgId === orgId)).toBe(false)
  })
})

describe("evaluateAutoApprove: sliding window and wildcard policies", () => {
  test("a fixed-window boundary no longer lets 2x windowMax through", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    await withSystemDb("t", (db) =>
      db.insert(autoApprovePolicies).values({
        orgId: u.orgId,
        toolName: "shopify:refund_create",
        enabled: true,
        conditions: [],
        limits: { windowSeconds: 3600, windowMax: 10 },
        requiresScope: null,
        createdBy: u.id,
      }),
    )
    const [policy] = await withSystemDb("t", (db) =>
      db.select().from(autoApprovePolicies).where(eq(autoApprovePolicies.orgId, u.orgId)),
    )
    // Ten calls spent just before the bucket boundary, nine already in the new bucket: a fixed
    // window would let the tenth through (9 + 1 <= 10); the sliding window still counts the previous
    // bucket's tail and gates.
    const windowSeconds = 3600
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
    const { redis } = await import("~/lib/redis")
    await redis.set(`aa:${u.orgId}:${policy!.id}:${bucket - 1}`, "10", "EX", 7200)
    await redis.set(`aa:${u.orgId}:${policy!.id}:${bucket}`, "9", "EX", 7200)
    const a = {
      actorType: "user" as const,
      userId: u.id,
      orgId: u.orgId,
      scopes: ["shopify:approve"],
      dimensionGrants: {},
    }
    const r = await evaluateAutoApprove({
      orgId: u.orgId,
      toolName: "shopify:refund_create",
      params: {},
      actor: a,
      appName: "shopify",
    })
    expect(r.decision).toBe("gate")
    expect(r.reason).toBe("window_cap")
  })

  test("an app-wide wildcard policy never covers an external or undeclared tool", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    await withSystemDb("t", (db) =>
      db.insert(autoApprovePolicies).values({
        orgId: u.orgId,
        toolName: "wcapp:*",
        enabled: true,
        conditions: [],
        limits: {},
        requiresScope: null,
        createdBy: u.id,
      }),
    )
    const base = { handler: async () => ({}), requiredScopes: ["wcapp:x"], appName: "wcapp" }
    toolRegistry.set([u.orgId, "wcapp", "send"], {
      ...base,
      name: "send",
      description: "d",
      approvalImpact: "external",
    } as any)
    toolRegistry.set([u.orgId, "wcapp", "undeclared"], {
      ...base,
      name: "undeclared",
      description: "d",
    } as any)
    toolRegistry.set([u.orgId, "wcapp", "tidy"], {
      ...base,
      name: "tidy",
      description: "d",
      approvalImpact: "internal",
    } as any)
    const a = {
      actorType: "user" as const,
      userId: u.id,
      orgId: u.orgId,
      scopes: [],
      dimensionGrants: {},
    }
    const run = (tool: string) =>
      evaluateAutoApprove({
        orgId: u.orgId,
        toolName: `wcapp:${tool}`,
        params: {},
        actor: a,
        appName: "wcapp",
      })
    expect((await run("send")).decision).toBe("gate")
    expect((await run("send")).reason).toBe("wildcard_excludes_external_tool")
    expect((await run("undeclared")).decision).toBe("gate")
    expect((await run("tidy")).decision).toBe("auto_approve")
    toolRegistry.deleteByPrefix([u.orgId])
  })
})

describe("evaluateAutoApprove: a turn that read outside text", () => {
  test("an outward tool waits for a person unless its policy opted in; internal tools still run", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    const base = { handler: async () => ({}), requiredScopes: ["utapp:x"], appName: "utapp" }
    toolRegistry.set([u.orgId, "utapp", "send"], {
      ...base,
      name: "send",
      description: "d",
      approvalImpact: "external",
    } as any)
    toolRegistry.set([u.orgId, "utapp", "undeclared"], {
      ...base,
      name: "undeclared",
      description: "d",
    } as any)
    toolRegistry.set([u.orgId, "utapp", "tidy"], {
      ...base,
      name: "tidy",
      description: "d",
      approvalImpact: "internal",
    } as any)
    toolRegistry.set([u.orgId, "utapp", "reply"], {
      ...base,
      name: "reply",
      description: "d",
      approvalImpact: "external",
    } as any)
    await withSystemDb("t", (db) =>
      db.insert(autoApprovePolicies).values(
        ["send", "undeclared", "tidy"].map((t) => ({
          orgId: u.orgId,
          toolName: `utapp:${t}`,
          enabled: true,
          conditions: [],
          limits: {},
          requiresScope: null,
          createdBy: u.id,
        })),
      ),
    )
    await withSystemDb("t", (db) =>
      db.insert(autoApprovePolicies).values({
        orgId: u.orgId,
        toolName: "utapp:reply",
        enabled: true,
        conditions: [],
        limits: {},
        requiresScope: null,
        allowAfterUntrustedContent: true,
        createdBy: u.id,
      }),
    )
    const a = {
      actorType: "user" as const,
      userId: u.id,
      orgId: u.orgId,
      scopes: [],
      dimensionGrants: {},
    }
    const run = (tool: string, tainted: boolean) =>
      evaluateAutoApprove({
        orgId: u.orgId,
        toolName: `utapp:${tool}`,
        params: {},
        actor: a,
        appName: "utapp",
        untrustedTurn: async () => tainted,
      })
    const tainted = await run("send", true)
    expect(tainted.decision).toBe("gate")
    expect(tainted.reason).toBe("untrusted_content_turn")
    expect((await run("undeclared", true)).reason).toBe("untrusted_content_turn")
    expect((await run("send", false)).decision).toBe("auto_approve")
    expect((await run("tidy", true)).decision).toBe("auto_approve")
    expect((await run("reply", true)).decision).toBe("auto_approve")
    toolRegistry.deleteByPrefix([u.orgId])
  })
})

describe("evaluateAutoApprove: a routine call that grants scopes waits for a person", () => {
  // A routine runs unattended on the scopes it holds, so setting or widening them hands out a
  // standing capability. The create_routine / update_routine card is the only confirmation of
  // those scopes: no policy approves it, not an app-wide `kernel:*`, not one naming the tool.
  test("create_routine / update_routine with new scopes are gated under any policy", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    const { registerSkillRoutineTools } = await import(
      "~/modules/agent/tools/skills-routines-tools"
    )
    await registerSkillRoutineTools(u.orgId)
    const { withPrivilegedDb } = await import("~/db/privileged")
    const { routines } = await import("~/db/schema/kernel")
    const routineId = await withPrivilegedDb(u.orgId, "t", async (tx) => {
      const [r] = await tx
        .insert(routines)
        .values({
          orgId: u.orgId,
          ownerUserId: u.id,
          name: `r-${crypto.randomUUID()}`,
          description: "d",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "p",
          scopes: ["mail:read"],
          visibility: "personal",
          enabled: true,
          status: "active",
          createdByUserId: u.id,
          createdByActorType: "user",
        })
        .returning({ id: routines.id })
      return r!.id
    })
    const a = {
      actorType: "user" as const,
      userId: u.id,
      orgId: u.orgId,
      scopes: [],
      dimensionGrants: {},
    }
    const run = (tool: string, params: unknown, untrusted = false) =>
      evaluateAutoApprove({
        orgId: u.orgId,
        toolName: `kernel:${tool}`,
        params,
        actor: a,
        appName: "kernel",
        untrustedTurn: async () => untrusted,
      })
    const create = { name: "n", prompt: "p", kind: "recurring", cron: "0 9 * * *" }
    const policy = (toolName: string, allowAfterUntrustedContent = false) =>
      withSystemDb("t", (db) =>
        db.insert(autoApprovePolicies).values({
          orgId: u.orgId,
          toolName,
          enabled: true,
          conditions: [],
          limits: {},
          requiresScope: null,
          allowAfterUntrustedContent,
          createdBy: u.id,
        }),
      )

    // An app-wide kernel policy.
    await policy("kernel:*")
    const viaWildcard = await run("create_routine", { ...create, scopes: ["mail:read"] })
    expect(viaWildcard.decision).toBe("gate")
    expect(viaWildcard.reason).toBe("grants_scopes")
    // A routine that sets no scope is unchanged: the wildcard still covers it.
    expect((await run("create_routine", { ...create, scopes: [] })).decision).toBe("auto_approve")
    expect((await run("create_routine", create)).decision).toBe("auto_approve")

    // Policies naming the tools, even ones that accept unattended runs after outside text.
    await policy("kernel:create_routine", true)
    await policy("kernel:update_routine", true)
    for (const untrusted of [false, true]) {
      const named = await run("create_routine", { ...create, scopes: ["mail:read"] }, untrusted)
      expect(named.decision).toBe("gate")
      expect(named.reason).toBe("grants_scopes")
    }
    // update_routine: widening is gated, keeping or narrowing the scopes is not a grant.
    const widen = await run("update_routine", {
      id: routineId,
      scopes: ["mail:read", "mail:write"],
    })
    expect(widen.decision).toBe("gate")
    expect(widen.reason).toBe("grants_scopes")
    expect((await run("update_routine", { id: routineId, scopes: ["mail:read"] })).decision).toBe(
      "auto_approve",
    )
    expect((await run("update_routine", { id: routineId, scopes: [] })).decision).toBe(
      "auto_approve",
    )
    expect((await run("update_routine", { id: routineId, prompt: "q" })).decision).toBe(
      "auto_approve",
    )
    // An unknown routine cannot be compared: fail closed.
    const unknown = await run("update_routine", { id: crypto.randomUUID(), scopes: ["mail:read"] })
    expect(unknown.decision).toBe("gate")
    toolRegistry.deleteByPrefix([u.orgId])
  })
})

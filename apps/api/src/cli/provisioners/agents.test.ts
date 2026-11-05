// SPDX-License-Identifier: FSL-1.1-ALv2
// Real-DB test for the agents provisioner: role agents declared in the config
// are created once, converge on re-run, and their ceiling is the common base
// plus the declared scopes, never an admin scope or a taken handle.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { agentsProvisioner, composeRoleAgentCeiling } from "~/cli/provisioners/agents"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { withSystemDb } from "~/db/privileged"
import {
  agents,
  appsActiveVersion,
  appsInstalled,
  auditLog,
  modelPricing,
} from "~/db/schema/kernel"
import { COMMON_AGENT_BASE_SCOPES } from "~/modules/agent/directory/common-base-scopes"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function freshCtx(): Promise<{ ctx: ProvisionContext; orgId: string }> {
  const { orgId } = await ensureOrg({
    slug: `cli-agents-${crypto.randomUUID().slice(0, 12)}`,
    name: "AgentsTestOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `owner-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Robin Owner",
    role: "admin",
    allowPasswordless: true,
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId }
}

async function agentByHandle(orgId: string, handle: string) {
  const [row] = await withSystemDb("t", (db) =>
    db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.handle, handle))),
  )
  return row
}

async function auditActions(orgId: string, agentId: string): Promise<string[]> {
  const rows = await withSystemDb("t", (db) =>
    db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityId, agentId))),
  )
  return rows.map((r) => r.action).sort()
}

function config(list: NonNullable<ProvisioningConfig["agents"]>): ProvisioningConfig {
  return { org: { slug: "x", name: "X" }, agents: list }
}

describe("agents provisioner", () => {
  test("creates a role agent with the common base ceiling, re-run is unchanged", async () => {
    const { ctx, orgId } = await freshCtx()
    const cfg = config([
      {
        handle: "Support",
        displayName: "Support",
        purpose: "Answers customer questions from the knowledge base",
        systemPrompt: "Cite the knowledge document you used.",
      },
    ])
    await agentsProvisioner.plan(ctx, cfg)
    const r1 = await agentsProvisioner.apply(ctx, { actions: [] }, cfg)
    expect(r1.changed).toEqual(["agents.@support.created"])

    const row = await agentByHandle(orgId, "@support")
    expect(row?.kind).toBe("role")
    expect(row?.purpose).toBe("Answers customer questions from the knowledge base")
    expect(row?.systemPrompt).toBe("Cite the knowledge document you used.")
    expect(row?.scopeCeiling).toEqual([...COMMON_AGENT_BASE_SCOPES])

    const r2 = await agentsProvisioner.apply(ctx, { actions: [] }, cfg)
    expect(r2.changed).toBeUndefined()
    expect(r2.unchanged).toEqual(["agents.@support"])
    // One audit row for the creation, none for the no-op re-run.
    expect(await auditActions(orgId, row?.id ?? "")).toEqual(["agent.created"])
  })

  test("each created agent takes a colour no other agent of the org wears", async () => {
    const { ctx, orgId } = await freshCtx()
    await agentsProvisioner.apply(
      ctx,
      { actions: [] },
      config([
        { handle: "@desk-a", displayName: "Desk A" },
        { handle: "@desk-b", displayName: "Desk B" },
        { handle: "@desk-c", displayName: "Desk C" },
      ]),
    )
    const rows = await withSystemDb("t", (db) =>
      db.select({ color: agents.avatarColor }).from(agents).where(eq(agents.orgId, orgId)),
    )
    // The built-in agent and the owner's own agent count too.
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.every((r) => r.color !== null && r.color >= 0 && r.color <= 7)).toBe(true)
    expect(new Set(rows.map((r) => r.color)).size).toBe(rows.length)
  })

  test("an edited declaration converges the existing agent", async () => {
    const { ctx, orgId } = await freshCtx()
    await agentsProvisioner.apply(
      ctx,
      { actions: [] },
      config([{ handle: "@sales", displayName: "Sales" }]),
    )
    const before = await agentByHandle(orgId, "@sales")
    const r = await agentsProvisioner.apply(
      ctx,
      { actions: [] },
      config([{ handle: "@sales", displayName: "Sales desk", scopes: ["tickets:tickets:read"] }]),
    )
    expect(r.changed).toEqual(["agents.@sales.updated"])
    const after = await agentByHandle(orgId, "@sales")
    expect(after?.id).toBe(before?.id)
    expect(after?.displayName).toBe("Sales desk")
    expect(after?.scopeCeiling).toEqual(composeRoleAgentCeiling(["tickets:tickets:read"]))
    expect(await auditActions(orgId, after?.id ?? "")).toEqual(["agent.created", "agent.updated"])
  })

  test("a scope granted by an app installed on this instance is accepted", async () => {
    const { ctx, orgId } = await freshCtx()
    const app = `acme${crypto.randomUUID().slice(0, 6)}`
    const scope = `${app}:widgets:read`
    // Unknown to every manifest of this build: refused until the app is installed.
    await expect(
      agentsProvisioner.apply(
        ctx,
        { actions: [] },
        config([{ handle: "widgets", displayName: "Widgets", scopes: [scope] }]),
      ),
    ).rejects.toBeInstanceOf(ConfigError)
    await withSystemDb("t", async (db) => {
      await db.insert(appsInstalled).values({
        name: app,
        version: "1.0.0",
        sourceUrl: "file:///test",
        sha256: "0".repeat(64),
        grantedScopes: [scope],
        installedBy: ctx.actor.userId,
      })
      await db.insert(appsActiveVersion).values({ name: app, version: "1.0.0" })
    })
    try {
      await agentsProvisioner.apply(
        ctx,
        { actions: [] },
        config([{ handle: "widgets", displayName: "Widgets", scopes: [scope] }]),
      )
      expect((await agentByHandle(orgId, "@widgets"))?.scopeCeiling).toContain(scope)
    } finally {
      await withSystemDb("t", async (db) => {
        await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, app))
        await db.delete(appsInstalled).where(eq(appsInstalled.name, app))
      })
    }
  })

  test("model pins the agent's model and must be in the catalog", async () => {
    const { ctx, orgId } = await freshCtx()
    const [model] = await withSystemDb("t", (db) =>
      db.select({ id: modelPricing.modelId }).from(modelPricing).limit(1),
    )
    const pinned = model?.id ?? "test-pinned-model"
    if (!model) {
      await withSystemDb("t", (db) =>
        db.insert(modelPricing).values({
          provider: "anthropic",
          modelId: pinned,
          displayName: "Pinned",
          inputCostPerM: "1",
          outputCostPerM: "1",
          contextWindow: 1000,
        }),
      )
    }
    await agentsProvisioner.apply(
      ctx,
      { actions: [] },
      config([{ handle: "pinned", displayName: "Pinned", model: pinned }]),
    )
    expect((await agentByHandle(orgId, "@pinned"))?.modelPreference).toBe(pinned)
    await expect(
      agentsProvisioner.apply(
        ctx,
        { actions: [] },
        config([{ handle: "pinned", displayName: "Pinned", model: "no-such-model" }]),
      ),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  test("model may be a key the org added (A13), never one it did not", async () => {
    const { ctx, orgId } = await freshCtx()
    const key = "openrouter/deepseek/deepseek-v4.1-flash"
    const models = {
      added: [
        {
          key,
          provider: "openrouter",
          upstreamId: "deepseek/deepseek-v4.1-flash",
          displayName: "DeepSeek V4.1 Flash",
          contextWindow: 1048576,
          inputCostPerM: "0.24",
          outputCostPerM: "0.96",
          tools: true,
          reasoningEfforts: ["low", "high"],
          canDisableReasoning: true,
          enabled: true,
          addedAt: "2026-10-22T00:00:00.000Z",
        },
      ],
    }
    await withSystemDb("t", (db) =>
      db.execute(
        sql`UPDATE kernel.organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ai}', ${JSON.stringify({ models })}::jsonb, true) WHERE id = ${orgId}::uuid`,
      ),
    )
    await agentsProvisioner.apply(
      ctx,
      { actions: [] },
      config([{ handle: "cheap", displayName: "Cheap", model: key }]),
    )
    expect((await agentByHandle(orgId, "@cheap"))?.modelPreference).toBe(key)
    await expect(
      agentsProvisioner.apply(
        ctx,
        { actions: [] },
        config([{ handle: "cheap", displayName: "Cheap", model: "openrouter/not/added" }]),
      ),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  test("an admin scope in the ceiling is a config error and writes nothing", async () => {
    const { ctx, orgId } = await freshCtx()
    await expect(
      agentsProvisioner.apply(
        ctx,
        { actions: [] },
        config([{ handle: "ops", displayName: "Ops", scopes: ["kernel:users:admin"] }]),
      ),
    ).rejects.toBeInstanceOf(ConfigError)
    expect(await agentByHandle(orgId, "@ops")).toBeUndefined()
  })

  test("a handle owned by a personal or system agent is a config error", async () => {
    const { ctx } = await freshCtx()
    // The org's own system agent answers to @base.
    await expect(
      agentsProvisioner.apply(ctx, { actions: [] }, config([{ handle: "base", displayName: "B" }])),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  test("plan rejects a malformed or duplicated handle", async () => {
    const { ctx } = await freshCtx()
    await expect(
      agentsProvisioner.plan(ctx, config([{ handle: "not a handle", displayName: "X" }])),
    ).rejects.toBeInstanceOf(ConfigError)
    await expect(
      agentsProvisioner.plan(
        ctx,
        config([
          { handle: "help", displayName: "A" },
          { handle: "@HELP", displayName: "B" },
        ]),
      ),
    ).rejects.toBeInstanceOf(ConfigError)
  })
})

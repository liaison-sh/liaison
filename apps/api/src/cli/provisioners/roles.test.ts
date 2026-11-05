// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the roles provisioner.
 *
 * Assertions:
 * - create: a new role gets exactly the declared scopes; report created/changed;
 * - idempotent: a second apply with the same config grants/revokes nothing;
 * - reconcile (desired-state): changing the declared scope set grants the new
 *   scopes and revokes the removed ones;
 * - integration/ordering: a role provisioned here is invitable by the users
 *   provisioner by name (roles run before users in the canonical order), which
 *   is the fabrikam case — an `ops` role withholding `pennylane:*` / `ads:*`
 *   that JS / Rowan are then invited onto.
 *
 * Mirrors users.test.ts: the admin provisioner runs first to populate
 * `ctx.actor` (userId + scopes:['*']), so `grantScope`'s scope-escalation guard
 * is satisfied for any app scope regardless of registration.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { adminProvisioner } from "~/cli/provisioners/admin"
import { rolesProvisioner } from "~/cli/provisioners/roles"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { usersProvisioner } from "~/cli/provisioners/users"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { roleScopeGrants, roles } from "~/db/schema/kernel"
import { ConsoleEmailProvider, setEmailProvider } from "~/infra/email"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(() => {
  setEmailProvider(new ConsoleEmailProvider())
  return acquireTestLock()
})
afterAll(releaseTestLock)

async function freshOrg(): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `cli-roles-${crypto.randomUUID().slice(0, 12)}`,
    name: "RolesProvOrg",
  })
  return orgId
}

/** Ensure an admin and return a context with ctx.actor (scopes:['*']) populated. */
async function ctxWithAdmin(orgId: string): Promise<ProvisionContext> {
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  const adminConfig: ProvisioningConfig = {
    org: { slug: "x", name: "X" },
    admin: {
      email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
      name: "Owner",
      password: "admin-pw-1!",
    },
  }
  const plan = await adminProvisioner.plan(ctx, adminConfig)
  await adminProvisioner.apply(ctx, plan, adminConfig)
  return ctx
}

async function roleScopesOf(orgId: string, name: string): Promise<string[]> {
  const rows = await withSystemDb("roles-test-scopes", (db) =>
    db
      .select({ scope: roleScopeGrants.scope })
      .from(roleScopeGrants)
      .innerJoin(roles, eq(roles.id, roleScopeGrants.roleId))
      .where(and(eq(roles.orgId, orgId), eq(roles.name, name))),
  )
  return rows.map((r) => r.scope).sort()
}

describe("roles provisioner", () => {
  test("create: a new role gets exactly the declared scopes", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      roles: [
        {
          name: "ops",
          description: "Ops — no finance apps",
          scopes: ["shopify:orders:read", "kernel:threads:read"],
        },
      ],
    }
    const plan = await rolesProvisioner.plan(ctx, config)
    const result = await rolesProvisioner.apply(ctx, plan, config)
    const section = result.section as {
      roles: Array<{ name: string; created: boolean; granted: string[] }>
    }
    expect(section.roles[0].created).toBe(true)
    expect(section.roles[0].granted.sort()).toEqual(["kernel:threads:read", "shopify:orders:read"])
    expect(result.changed).toContain("roles.ops")
    expect(await roleScopesOf(orgId, "ops")).toEqual(["kernel:threads:read", "shopify:orders:read"])
  })

  test("a role's scopes are granted in one batch: one role_scope event naming them all", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const scopes = [
      "kernel:threads:read",
      "kernel:contacts:read",
      "shopify:orders:read",
      "tickets:tickets:read",
      "projects:tasks:read",
    ]
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      roles: [{ name: "batch", scopes }],
    }
    await rolesProvisioner.apply(ctx, await rolesProvisioner.plan(ctx, config), config)
    expect(await roleScopesOf(orgId, "batch")).toEqual([...scopes].sort())
    const events = await withSystemDb("roles-test-events", async (db) =>
      extractRows<{ added: string[] | null }>(
        await db.execute(sql`
          SELECT ARRAY(SELECT jsonb_array_elements_text(payload->'data'->'scopesAdded')) AS added
            FROM kernel.pending_events
           WHERE org_id = ${orgId}::uuid
             AND payload->>'entity' = 'role_scope' AND payload->>'action' = 'grant'
             AND payload->>'entityId' = (
               SELECT id::text FROM kernel.roles WHERE org_id = ${orgId}::uuid AND name = 'batch')`),
      ),
    )
    expect(events).toHaveLength(1)
    expect([...(events[0]?.added ?? [])].sort()).toEqual([...scopes].sort())
  })

  test("idempotent: a second apply grants/revokes nothing and reports unchanged", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      roles: [{ name: "ops", scopes: ["shopify:orders:read"] }],
    }
    await rolesProvisioner.apply(ctx, await rolesProvisioner.plan(ctx, config), config)

    const result2 = await rolesProvisioner.apply(
      ctx,
      await rolesProvisioner.plan(ctx, config),
      config,
    )
    const section2 = result2.section as {
      roles: Array<{ created: boolean; granted: string[]; revoked: string[] }>
    }
    expect(section2.roles[0].created).toBe(false)
    expect(section2.roles[0].granted).toEqual([])
    expect(section2.roles[0].revoked).toEqual([])
    expect(result2.unchanged).toContain("roles.ops")
    expect(await roleScopesOf(orgId, "ops")).toEqual(["shopify:orders:read"])
  })

  test("reconcile: changing the declared set grants the new + revokes the removed", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const c1: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      roles: [{ name: "ops", scopes: ["pennylane:invoices:read", "kernel:threads:read"] }],
    }
    await rolesProvisioner.apply(ctx, await rolesProvisioner.plan(ctx, c1), c1)

    // Withhold pennylane, add shopify; keep kernel:threads:read.
    const c2: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      roles: [{ name: "ops", scopes: ["shopify:orders:read", "kernel:threads:read"] }],
    }
    const r2 = await rolesProvisioner.apply(ctx, await rolesProvisioner.plan(ctx, c2), c2)
    const s2 = r2.section as { roles: Array<{ granted: string[]; revoked: string[] }> }
    expect(s2.roles[0].granted).toEqual(["shopify:orders:read"])
    expect(s2.roles[0].revoked).toEqual(["pennylane:invoices:read"])
    expect(await roleScopesOf(orgId, "ops")).toEqual(["kernel:threads:read", "shopify:orders:read"])
  })

  test("a provisioned role is invitable by name (roles run before users)", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const email = `js-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      roles: [{ name: "ops", scopes: ["shopify:orders:read"] }],
      users: [{ email, name: "JS", role: "ops", mode: "invite" }],
    }
    await rolesProvisioner.apply(ctx, await rolesProvisioner.plan(ctx, config), config)
    // The users provisioner's plan resolves the role name against kernel.roles —
    // it exists because roles applied first → no ConfigError, invite succeeds.
    const uResult = await usersProvisioner.apply(
      ctx,
      await usersProvisioner.plan(ctx, config),
      config,
    )
    const us = uResult.section as { users: Array<{ invited: boolean }> }
    expect(us.users[0].invited).toBe(true)
  })
})

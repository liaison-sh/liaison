// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The section runner shared by `liaison config apply` and the agent's config
// tools. On the tool path it acts as a real person of a live org: their own
// scopes and data grants, the org fixed before any plan, and a plan error in
// any section stopping the run before the first write.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { orgKernelSettingsSchema } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { withSystemDb } from "~/db/privileged"
import { organizations, roles } from "~/db/schema/kernel"
import { getOrgKernelSettings } from "~/lib/settings"
import {
  applySections,
  buildActorProvisionContext,
  planSections,
} from "~/modules/provisioning/config-sections"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx, bootstrapScopedAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function roleNamed(orgId: string, name: string) {
  return withSystemDb("test-role-named", async (db) => {
    const [r] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, name)))
      .limit(1)
    return r ?? null
  })
}

async function slugOf(orgId: string): Promise<string> {
  return withSystemDb("test-org-slug", async (db) => {
    const [o] = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
    if (!o) throw new Error("org missing")
    return o.slug
  })
}

async function emailSettings(orgId: string) {
  return withSystemDb("test-email-settings", (db) =>
    getOrgKernelSettings(db, orgId, orgKernelSettingsSchema),
  ).then((s) => s.email)
}

describe("config section runner on the tool path", () => {
  test("(a) a person without a scope cannot grant it through the roles section; the CLI's * actor can", async () => {
    const scoped = await bootstrapScopedAdminCtx(["kernel:roles:admin", "kernel:users:admin"])
    const cfg: ProvisioningConfig = {
      org: { slug: "unused", name: "unused" },
      roles: [{ name: "Overreach", scopes: ["shopify:orders:admin"] }],
    }
    const asPerson = buildActorProvisionContext({
      orgId: scoped.orgId,
      actor: {
        userId: scoped.userId,
        scopes: scoped.actor.scopes,
        dimensionGrants: scoped.actor.dimensionGrants,
      },
    })
    await expect(applySections(asPerson, cfg, ["roles"])).rejects.toThrow()
    expect(await roleNamed(scoped.orgId, "Overreach")).toBeNull()

    // Discriminator: the same data run as the wildcard actor goes through.
    const asWildcard = buildActorProvisionContext({
      orgId: scoped.orgId,
      actor: { userId: scoped.userId, scopes: ["*"], dimensionGrants: { "*": ["*"] } },
    })
    await applySections(asWildcard, cfg, ["roles"])
    expect(await roleNamed(scoped.orgId, "Overreach")).not.toBeNull()
  })

  test("(b) a plan error in a later section stops the run before an earlier section writes", async () => {
    const admin = await bootstrapAdminCtx()
    const ctx = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: {
        userId: admin.userId,
        scopes: admin.actor.scopes,
        dimensionGrants: admin.actor.dimensionGrants,
      },
    })
    const cfg: ProvisioningConfig = {
      org: { slug: "unused", name: "unused" },
      roles: [{ name: "Planned But Never Written", scopes: [] }],
      agents: [{ handle: "not a valid handle!", displayName: "Bad" }],
    }
    await expect(applySections(ctx, cfg, ["roles", "agents"])).rejects.toBeInstanceOf(ConfigError)
    expect(await roleNamed(admin.orgId, "Planned But Never Written")).toBeNull()
  })

  test("(c) config.org.slug naming another org never reaches it: the tool path works on ctx.orgId", async () => {
    const a = await bootstrapAdminCtx()
    const b = await minimal.secondOrg()
    const otherSlug = await slugOf(b.orgId)
    const ctx = buildActorProvisionContext({
      orgId: a.orgId,
      actor: { userId: a.userId, scopes: a.actor.scopes, dimensionGrants: a.actor.dimensionGrants },
    })
    // A custom role that exists only in org A: the users preflight must check
    // A's roles, not B's (where it is unknown and would refuse the run).
    await applySections(
      ctx,
      { org: { slug: otherSlug, name: "x" }, roles: [{ name: "Field Ops", scopes: [] }] },
      ["roles"],
    )
    const cfg: ProvisioningConfig = {
      org: { slug: otherSlug, name: "Other" },
      email: { from: "Org A <a@example.test>" },
      users: [{ email: "field@example.test", name: "Field", role: "Field Ops", mode: "invite" }],
      apps: [{ name: "mail", enable: true, providers: { gmail: { enabled: false } } }],
    }
    const planned = await planSections(ctx, cfg, ["email", "users", "apps"])
    expect(planned.map((p) => p.key)).toEqual(["email", "users", "apps"])
    await applySections(ctx, cfg, ["email", "users", "apps"], { planned })
    expect((await emailSettings(a.orgId))?.from).toBe("Org A <a@example.test>")
    expect((await emailSettings(b.orgId))?.from).toBeUndefined()
    expect(await roleNamed(b.orgId, "Field Ops")).toBeNull()
  })

  test("(c) the tool path refuses to plan without an org instead of resolving one by slug", async () => {
    const a = await bootstrapAdminCtx()
    const ctx = buildActorProvisionContext({
      orgId: a.orgId,
      actor: { userId: a.userId, scopes: ["*"], dimensionGrants: { "*": ["*"] } },
    })
    ctx.orgId = ""
    await expect(
      planSections(
        ctx,
        {
          org: { slug: await slugOf(a.orgId), name: "x" },
          users: [{ email: "x@example.test", name: "X", role: "member", mode: "invite" }],
        },
        ["users"],
      ),
    ).rejects.toThrow(/must set the org/)
  })
})

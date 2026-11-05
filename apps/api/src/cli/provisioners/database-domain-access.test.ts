// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB test of `apps[].domainAccess` on the database app entry of
 * `liaison config apply`: roles by name and people by email resolve to ids and
 * are written; an unknown role fails loudly before anything is written; an
 * entry without `domainAccess` leaves the stored map untouched; the section is
 * refused on any other app.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { loadOrgDomainAccess } from "~/apps/database/domain-access-store"
import { ConfigError } from "~/cli/config/parse"
import { type ProvisioningConfig, validateConfig } from "~/cli/config/schema"
import { appsProvisioner } from "~/cli/provisioners/apps"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { withSystemDb } from "~/db/privileged"
import { roles } from "~/db/schema/kernel"
import { resetCatalogCache } from "~/modules/apps/catalog"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let emptyCatalogDir: string
beforeAll(async () => {
  await acquireTestLock()
  emptyCatalogDir = mkdtempSync(join(tmpdir(), "domain-access-empty-catalog-"))
  process.env.LIAISON_APP_CATALOG_DIR = emptyCatalogDir
  resetCatalogCache()
})
afterAll(async () => {
  rmSync(emptyCatalogDir, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  resetCatalogCache()
  await releaseTestLock()
})

async function freshOrg(): Promise<{ ctx: ProvisionContext; orgId: string; email: string }> {
  const slug = `cli-dom-${crypto.randomUUID().slice(0, 12)}`
  const { orgId } = await ensureOrg({ slug, name: "DomainAccessOrg" })
  const email = `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
  const { userId } = await ensureUser({
    orgId,
    email,
    name: "Owner",
    password: "pw-dom-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId, email }
}

async function runApps(ctx: ProvisionContext, config: ProvisioningConfig) {
  const plan = await appsProvisioner.plan(ctx, config)
  return appsProvisioner.apply(ctx, plan, config)
}

describe("config apply: apps[].domainAccess (database)", () => {
  test("sets the map from role names and emails; re-applying changes nothing", async () => {
    const { ctx, orgId, email } = await freshOrg()
    const [admin] = await withSystemDb("test-dom-role", (db) =>
      db.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.orgId, orgId)),
    ).then((rows) => rows.filter((r) => r.name === "admin"))
    if (!admin) throw new Error("no admin role seeded")
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [
        {
          name: "database",
          enable: true,
          domainAccess: {
            revenue: { tier: "confidential", roles: ["admin"] },
            customers: { tier: "restricted", users: [email.toUpperCase()] },
            returns: { tier: "internal" },
          },
        },
      ],
    }
    const first = await runApps(ctx, config)
    expect(first.changed).toContain("apps.database.domainAccess")
    const stored = await loadOrgDomainAccess(orgId)
    expect(stored.revenue).toEqual({ tier: "confidential", roles: [admin.id] })
    expect(stored.customers).toEqual({ tier: "restricted", users: [ctx.actor.userId] })
    expect(stored.returns).toEqual({ tier: "internal" })

    const second = await runApps(ctx, config)
    expect(second.changed ?? []).not.toContain("apps.database.domainAccess")
    expect(second.unchanged).toContain("apps.database.domainAccess")
  })

  test("an unknown role fails loudly at plan, and nothing is written", async () => {
    const { ctx, orgId } = await freshOrg()
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [
        {
          name: "database",
          enable: true,
          domainAccess: { revenue: { tier: "confidential", roles: ["no-such-role"] } },
        },
      ],
    }
    let caught: unknown
    try {
      await appsProvisioner.plan(ctx, config)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect(String((caught as Error).message)).toContain("no-such-role")
    expect(await loadOrgDomainAccess(orgId)).toEqual({})
  })

  test("an unknown person fails loudly", async () => {
    const { ctx } = await freshOrg()
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apps: [
        {
          name: "database",
          enable: true,
          domainAccess: { revenue: { tier: "restricted", users: ["nobody@fabrikam.example"] } },
        },
      ],
    }
    await expect(appsProvisioner.plan(ctx, config)).rejects.toBeInstanceOf(ConfigError)
  })

  test("an entry without domainAccess leaves the stored map untouched", async () => {
    const { ctx, orgId } = await freshOrg()
    await runApps(ctx, {
      org: { slug: "x", name: "X" },
      apps: [{ name: "database", enable: true, domainAccess: { revenue: { tier: "restricted" } } }],
    })
    const before = await loadOrgDomainAccess(orgId)
    expect(before).toEqual({ revenue: { tier: "restricted" } })
    await runApps(ctx, {
      org: { slug: "x", name: "X" },
      apps: [{ name: "database", enable: true }],
    })
    expect(await loadOrgDomainAccess(orgId)).toEqual(before)
  })

  test("the schema refuses domainAccess on another app and a malformed rule", () => {
    const other = validateConfig({
      org: { slug: "x", name: "X" },
      apps: [{ name: "tickets", enable: true, domainAccess: { a: { tier: "internal" } } }],
    })
    expect(other.ok).toBe(false)
    const bad = validateConfig({
      org: { slug: "x", name: "X" },
      apps: [{ name: "database", enable: true, domainAccess: { a: { tier: "secret" } } }],
    })
    expect(bad.ok).toBe(false)
  })
})

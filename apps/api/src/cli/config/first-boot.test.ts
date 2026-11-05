// SPDX-License-Identifier: FSL-1.1-ALv2
// Headless first boot: one `config apply` stands up what the browser's first
// Register would (org, default roles, `@base`, the owner with the admin role
// and a personal agent), so a fresh instance needs no browser step. The owner
// may be passwordless, as after Register. A re-run changes nothing and never
// sets or resets a password.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { runConfigApply } from "~/cli/config/apply"
import { validateConfig } from "~/cli/config/schema"
import { withSystemDb } from "~/db/privileged"
import { agents, organizations, roles, userRoles, users } from "~/db/schema/kernel"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

function firstBootConfig(slug: string, email: string) {
  const parsed = validateConfig({
    org: { slug, name: "Fabrikam" },
    admin: { email, name: "Robin Owner" },
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.config
}

describe("headless first boot via config apply", () => {
  test("org + passwordless owner with a personal agent and @base; re-run is a no-op", async () => {
    const slug = `first-boot-${crypto.randomUUID().slice(0, 12)}`
    const email = `Owner-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const config = firstBootConfig(slug, email)

    const first = await runConfigApply({
      config,
      format: "json",
      dryRun: false,
      validateByok: false,
      echoSupplied: false,
      log: () => {},
    })
    expect(first.exitCode).toBe(0)
    expect(first.report.changed).toEqual(["org.created", "admin.created"])

    const [org] = await withSystemDb("t", (db) =>
      db.select().from(organizations).where(eq(organizations.slug, slug)),
    )
    if (!org) throw new Error("org not created")

    const [owner] = await withSystemDb("t", (db) =>
      db
        .select()
        .from(users)
        .where(and(eq(users.orgId, org.id), eq(users.email, email.toLowerCase()))),
    )
    if (!owner) throw new Error("owner not created")
    expect(owner.passwordHash).toBeNull()
    expect(owner.status).toBe("active")

    const ownerRoles = await withSystemDb("t", (db) =>
      db
        .select({ name: roles.name })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.userId, owner.id)),
    )
    expect(ownerRoles.map((r) => r.name)).toEqual(["admin"])

    const orgAgents = await withSystemDb("t", (db) =>
      db
        .select({ kind: agents.kind, handle: agents.handle, owner: agents.ownerUserId })
        .from(agents)
        .where(eq(agents.orgId, org.id)),
    )
    expect(orgAgents.find((a) => a.kind === "system")?.handle).toBe("@base")
    expect(orgAgents.filter((a) => a.kind === "personal")).toEqual([
      { kind: "personal", handle: "@robins-agent", owner: owner.id },
    ])

    const second = await runConfigApply({
      config,
      format: "json",
      dryRun: false,
      validateByok: false,
      echoSupplied: false,
      log: () => {},
    })
    expect(second.exitCode).toBe(0)
    expect(second.report.changed).toEqual([])
    const after = await withSystemDb("t", (db) =>
      db.select({ id: agents.id }).from(agents).where(eq(agents.orgId, org.id)),
    )
    expect(after.length).toBe(orgAgents.length)
  })

  test("a re-run restores the org defaults a first run would have seeded", async () => {
    const slug = `first-boot-${crypto.randomUUID().slice(0, 12)}`
    const { orgId } = await ensureOrg({ slug, name: "Fabrikam" })
    const countDefaults = async () =>
      (
        await withSystemDb("t", (db) =>
          db.execute(
            sql`SELECT count(*)::int AS n FROM kernel.saved_views WHERE org_id = ${orgId} AND is_default`,
          ),
        )
      ).map((r) => Number((r as { n: number }).n))[0] ?? 0
    const seeded = await countDefaults()
    expect(seeded).toBeGreaterThan(0)
    // As an org created before these defaults existed, or a first run that stopped part way.
    await withSystemDb("t", (db) =>
      db.execute(sql`DELETE FROM kernel.saved_views WHERE org_id = ${orgId} AND is_default`),
    )
    expect(await countDefaults()).toBe(0)
    const again = await ensureOrg({ slug, name: "Fabrikam" })
    expect(again.created).toBe(false)
    expect(await countDefaults()).toBe(seeded)
  })
})

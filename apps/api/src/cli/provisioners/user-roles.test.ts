// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `users[].role` on the FIRST apply of a brand-new org: a role declared in the
 * same file's `roles` section and an app role ("Full Member", `<app>.<role>`)
 * that the org's app registration seeds are accepted in one apply; a typo'd role
 * is refused before anything is written, naming it and the valid roles. The
 * dry run (`config plan`) agrees with the apply. The roles of a catalog app the
 * `apps` section installs are read from its baked manifest at plan time: a typo
 * is refused before any write, a valid one is invited once the install ran.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { runConfigApply } from "~/cli/config/apply"
import { type ProvisioningConfig, validateConfig } from "~/cli/config/schema"
import { withSystemDb } from "~/db/privileged"
import { invitations, organizations, roles } from "~/db/schema/kernel"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { ConsoleEmailProvider, setEmailProvider } from "~/infra/email"
import { resetCatalogCache } from "~/modules/apps/catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(() => {
  setEmailProvider(new ConsoleEmailProvider())
  return acquireTestLock()
})
afterAll(releaseTestLock)

const tag = () => crypto.randomUUID().slice(0, 8)

function newOrgConfig(slug: string, userRoles: string[]): ProvisioningConfig {
  const parsed = validateConfig({
    org: { slug, name: "Fabrikam" },
    admin: { email: `owner-${tag()}@fabrikam.example`, name: "Robin Owner" },
    roles: [{ name: "teammate", scopes: ["kernel:threads:read"] }],
    users: userRoles.map((role, i) => ({
      email: `member${i}-${tag()}@fabrikam.example`,
      name: `Member ${i}`,
      role,
    })),
  })
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.config
}

async function apply(config: ProvisioningConfig, dryRun: boolean, logs: string[] = []) {
  return runConfigApply({
    config,
    format: "json",
    dryRun,
    validateByok: false,
    echoSupplied: false,
    log: (m) => logs.push(m),
  })
}

async function orgIdBySlug(slug: string): Promise<string | undefined> {
  const [row] = await withSystemDb("t", (db) =>
    db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)),
  )
  return row?.id
}

async function invitedRole(orgId: string, email: string): Promise<string | undefined> {
  const [row] = await withSystemDb("t", (db) =>
    db
      .select({ role: roles.name })
      .from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.roleId))
      .where(and(eq(invitations.orgId, orgId), eq(invitations.email, email.toLowerCase()))),
  )
  return row?.role
}

describe("config apply: users[].role on a brand-new org", () => {
  const wanted = ["teammate", "Full Member", "tickets.support", "member"]

  test("same-file and app roles pass the dry run and the first apply", async () => {
    const slug = `user-roles-${tag()}`
    const config = newOrgConfig(slug, wanted)

    const plan = await apply(config, true)
    expect(plan.exitCode).toBe(0)
    expect(await orgIdBySlug(slug)).toBeUndefined()

    const logs: string[] = []
    const first = await apply(config, false, logs)
    expect(logs.filter((l) => l.startsWith("error:"))).toEqual([])
    expect(first.exitCode).toBe(0)
    const orgId = await orgIdBySlug(slug)
    if (!orgId) throw new Error("org not created")
    for (const u of config.users ?? []) expect(await invitedRole(orgId, u.email)).toBe(u.role)

    // A second apply changes nothing for the users.
    const second = await apply(config, false)
    expect(second.exitCode).toBe(0)
    for (const u of config.users ?? [])
      expect(second.report.unchanged).toContain(`users.${u.email}`)
  })

  test("a typo'd role is refused before any write, naming it and the valid roles", async () => {
    const slug = `user-roles-typo-${tag()}`
    for (const dryRun of [true, false]) {
      const logs: string[] = []
      const res = await apply(newOrgConfig(slug, ["teammate", "Ful Member"]), dryRun, logs)
      expect(res.exitCode).toBe(2)
      const error = logs.find((l) => l.startsWith("error:")) ?? ""
      expect(error).toContain("unknown role 'Ful Member'")
      for (const valid of wanted) expect(error).toContain(valid)
    }
    expect(await orgIdBySlug(slug)).toBeUndefined()
  })
})

describe("users on the roles of a catalog app the same apply installs", () => {
  let catalogDir = ""
  let installRoot = ""
  const appName = `catroles-${tag()}`
  const prevCatalog = process.env.LIAISON_APP_CATALOG_DIR
  const prevApps = process.env.LIAISON_APPS_DIR

  beforeAll(() => {
    // A one-app catalog whose manifest declares `member` and `admin` roles.
    catalogDir = mkdtempSync(join(tmpdir(), "user-roles-catalog-"))
    installRoot = mkdtempSync(join(tmpdir(), "user-roles-install-"))
    const stage = mkdtempSync(join(tmpdir(), "user-roles-stage-"))
    const read = `${appName}:items:read`
    const write = `${appName}:items:write`
    writeFileSync(
      join(stage, "app.manifest.json"),
      JSON.stringify({
        name: appName,
        version: "0.1.0",
        packageFormat: 1,
        license: "MIT",
        scopes: [read, write],
        roles: {
          member: { description: "Member", scopes: [read] },
          admin: { description: "Admin", extends: "member", scopes: [write] },
        },
      }),
    )
    writeFileSync(join(stage, "bundle.js"), "// noop\n")
    const file = `${appName}-0.1.0.liaisonapp`
    spawnSync("tar", [
      "-czf",
      join(catalogDir, file),
      "-C",
      stage,
      "app.manifest.json",
      "bundle.js",
    ])
    rmSync(stage, { recursive: true, force: true })
    writeFileSync(
      join(catalogDir, "catalog.json"),
      JSON.stringify([
        { name: appName, version: "0.1.0", file, scopes: [read, write], connections: [] },
      ]),
    )
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    process.env.LIAISON_APPS_DIR = installRoot
    resetCatalogCache()
  })

  afterAll(async () => {
    await withSystemDb("t", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, appName))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, appName))
    })
    if (prevCatalog === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
    else process.env.LIAISON_APP_CATALOG_DIR = prevCatalog
    if (prevApps === undefined) delete process.env.LIAISON_APPS_DIR
    else process.env.LIAISON_APPS_DIR = prevApps
    resetCatalogCache()
    rmSync(catalogDir, { recursive: true, force: true })
    rmSync(installRoot, { recursive: true, force: true })
  })

  function catalogConfig(slug: string, role: string): ProvisioningConfig {
    const parsed = validateConfig({
      org: { slug, name: "Fabrikam" },
      admin: { email: `owner-${tag()}@fabrikam.example`, name: "Robin Owner" },
      apps: [{ name: appName, enable: true }],
      users: [{ email: `cat-${tag()}@fabrikam.example`, name: "Cat", role }],
    })
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.config
  }

  test("a typo'd app role is refused at plan time, with zero writes", async () => {
    const slug = `user-roles-cat-typo-${tag()}`
    for (const dryRun of [true, false]) {
      const logs: string[] = []
      const res = await apply(catalogConfig(slug, `${appName}.membr`), dryRun, logs)
      expect(res.exitCode).toBe(2)
      const error = logs.find((l) => l.startsWith("error:")) ?? ""
      expect(error).toContain(`unknown role '${appName}.membr'`)
      expect(error).toContain(`${appName}.member`)
      expect(error).toContain(`${appName}.admin`)
    }
    expect(await orgIdBySlug(slug)).toBeUndefined()
    const installed = await withSystemDb("t", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, appName)),
    )
    expect(installed).toHaveLength(0)
  })

  test("a valid app role passes the plan and is invited after the install", async () => {
    const slug = `user-roles-cat-${tag()}`
    const config = catalogConfig(slug, `${appName}.member`)
    expect((await apply(config, true)).exitCode).toBe(0)

    const logs: string[] = []
    const res = await apply(config, false, logs)
    expect(logs.filter((l) => l.startsWith("error:"))).toEqual([])
    expect(res.exitCode).toBe(0)
    const orgId = await orgIdBySlug(slug)
    if (!orgId) throw new Error("org not created")
    const [user] = config.users ?? []
    if (!user) throw new Error("no user")
    expect(await invitedRole(orgId, user.email)).toBe(`${appName}.member`)
    expect(res.report.changed).toContain(`users.${user.email}`)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// config_export then config_plan on an unchanged org reports zero changes for
// every section whose plan diffs against the stored rows (roles, email, apps,
// agents, knowledge collections, invoicing issuer profiles); one mutated row in
// any of them makes the plan report it. Secrets never appear in the export.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { agents, organizations, roleScopeGrants, roles } from "~/db/schema/kernel"
import { registerConfigTools } from "~/modules/agent/tools/config-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { exportOrgConfig } from "~/modules/provisioning/config-export"
import { applySections, buildActorProvisionContext } from "~/modules/provisioning/config-sections"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const DIFFING = ["roles", "email", "apps", "agents", "knowledge", "invoicing"] as const
type Diffing = (typeof DIFFING)[number]

let orgId: string
let adminId: string
let installRoot: string
let prevAppsDir: string | undefined

type Handler = (params: unknown, ctx: unknown) => Promise<unknown>
function handler(name: string): Handler {
  const def = toolRegistry.get([orgId, "kernel", name])
  if (!def || typeof def.handler !== "function") throw new Error(`${name} not registered`)
  return def.handler
}

beforeAll(async () => {
  await acquireTestLock()
  installRoot = mkdtempSync(join(tmpdir(), "config-export-install-root-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  adminId = a.userId
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../bundled-apps/invoicing/app.manifest.json"),
      "utf8",
    ),
  ) as { scopes: string[] }
  await installAppFromTarball({
    tarballPath: firstPartyAppTarball("invoicing"),
    installedBy: adminId,
    grantedScopes: manifest.scopes,
  })
  await reloadInstalledApps(orgId)
  registerConfigTools(orgId)
  const ctx = buildActorProvisionContext({
    orgId,
    actor: { userId: adminId, scopes: a.actor.scopes, dimensionGrants: a.actor.dimensionGrants },
  })
  await applySections(
    ctx,
    {
      org: { slug: "x", name: "X" },
      roles: [{ name: "Support", scopes: ["kernel:threads:read"] }],
      email: { from: "Acme <hello@acme.example>", replyTo: "help@acme.example" },
      apps: [{ name: "projects", enable: true }],
      knowledge: { collections: [{ name: "Policies" }] },
      agents: [{ handle: "@support", displayName: "Support", purpose: "Answers tickets" }],
      invoicing: { issuerProfiles: [{ legalName: "Acme SAS", country: "FR", vatId: "FR123" }] },
    },
    ["roles", "email", "apps", "knowledge", "agents", "invoicing"],
  )
})
afterAll(async () => {
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  await releaseTestLock()
})

async function exported(): Promise<Record<string, unknown>> {
  const out = (await handler("config_export")({}, { orgId, userId: adminId })) as {
    config: Record<string, unknown>
  }
  return out.config
}

async function changesFor(section: Diffing, data: unknown): Promise<number> {
  const out = (await handler("config_plan")(
    { sections: { [section]: data } },
    { orgId, userId: adminId },
  )) as { plans?: Array<{ changes: number | null; plan: string[] }>; error?: string }
  if (!out.plans) throw new Error(`config_plan refused: ${out.error}`)
  return out.plans[0]?.changes ?? 0
}

describe("config_export round trip", () => {
  it("exports every exportable section and says which are not exportable yet", async () => {
    const config = await exported()
    expect(config.mail).toBe("not exportable yet")
    expect(config.tickets).toBe("not exportable yet")
    expect(config.roles).toContainEqual({ name: "Support", scopes: ["kernel:threads:read"] })
    expect(config.email).toEqual({
      from: "Acme <hello@acme.example>",
      replyTo: "help@acme.example",
    })
    expect(config.knowledge).toEqual({ collections: [{ name: "Policies" }] })
  })

  for (const section of DIFFING) {
    it(`${section}: export then plan reports zero changes`, async () => {
      const config = await exported()
      expect(await changesFor(section, config[section])).toBe(0)
    })
  }

  const mutate: Record<Diffing, () => Promise<void>> = {
    roles: async () => {
      await withSystemDb("t", async (db) => {
        const [r] = await db
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.orgId, orgId), eq(roles.name, "Support")))
        if (!r) throw new Error("no role")
        await db.insert(roleScopeGrants).values({ roleId: r.id, scope: "kernel:contacts:read" })
      })
    },
    email: async () => {
      await withSystemDb("t", (db) =>
        db.execute(drizzleSql`
          UPDATE kernel.organizations
          SET settings = jsonb_set(settings, '{email,from}', '"Other <o@acme.example>"')
          WHERE id = ${orgId}::uuid`),
      )
    },
    apps: async () => {
      // Turned Off: what a person sees. Dropping it from the enabledApps
      // curation list alone is no change (the app stays on, appIsOn).
      await setOrgAppStatus(orgId, "projects", "disabled")
    },
    agents: async () => {
      await withSystemDb("t", (db) =>
        db
          .update(agents)
          .set({ displayName: "Renamed" })
          .where(and(eq(agents.orgId, orgId), eq(agents.handle, "@support"))),
      )
    },
    knowledge: async () => {
      await withSystemDb("t", (db) =>
        db.execute(drizzleSql`
          DELETE FROM app_knowledge.collections WHERE org_id = ${orgId}::uuid AND name = 'Policies'`),
      )
    },
    invoicing: async () => {
      await withSystemDb("t", (db) =>
        db.execute(drizzleSql`
          UPDATE app_invoicing.issuer_profiles SET vat_id = 'FR999'
          WHERE org_id = ${orgId}::uuid AND legal_name = 'Acme SAS'`),
      )
    },
  }

  for (const section of DIFFING) {
    it(`${section}: a mutated row makes the plan report a change`, async () => {
      const config = await exported()
      await mutate[section]()
      expect(await changesFor(section, config[section])).toBeGreaterThan(0)
    })
  }

  it("each section needs its own read scope: without it the section is left out, with a note", async () => {
    const out = await exportOrgConfig(orgId, {
      userId: adminId,
      scopes: ["kernel:org:admin"],
      dimensionGrants: {},
    })
    expect(out.config.invoicing).toBe("left out: needs invoicing:settings:read")
    expect(out.config.agents).toBe("left out: needs kernel:agents:read")
    expect(out.config.users).toBe("left out: needs kernel:users:read")
    expect(out.config.email).toMatchObject({ replyTo: "help@acme.example" })
  })

  it("liaisonTeam is exported for the operator org, off until someone answers", async () => {
    // The switches are instance-wide rows, not the org's: start from no answer
    // whatever an earlier file in this database left.
    await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
    const out = await exportOrgConfig(orgId, {
      userId: adminId,
      scopes: ["kernel:org:admin"],
      dimensionGrants: {},
    })
    expect(out.config.liaisonTeam).toEqual({ register: false, forwardBugReports: false })
  })

  it("the export carries no secret", async () => {
    const out = JSON.stringify(await handler("config_export")({}, { orgId, userId: adminId }))
    expect(out).not.toMatch(/password|clientSecret|"credentials"|inviteUrl/)
    const [org] = await withSystemDb("t", (db) =>
      db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)),
    )
    expect(org?.id).toBe(orgId)
  })
})

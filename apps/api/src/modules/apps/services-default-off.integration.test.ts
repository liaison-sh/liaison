// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Companies, deals and client reports are switches inside apps (`kernel.org_app_features`)
// that are off in every workspace until an admin turns them on: a workspace upgraded to
// this release has no row, so none of their tools is listed or runs, while its data and
// the other tools stay as they were. An admin turns each on from Settings > Apps (the
// features route), `liaison config apply` (`apps[].features`) or the agent's config
// tool, which goes through the same apply. A feature the app derives from its own data
// (time and budgets) has no admin switch.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { configSchema } from "~/cli/config/schema"
import { applyAppFeatures, planAppFeatures } from "~/cli/provisioners/app-features"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  listGatewayTools,
} from "~/modules/agent/tools/tool-bridge"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { enabledFeaturesFor, forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import * as minimal from "~/seed/tiers/minimal"
import { buildTestApp } from "~/tests/helpers/build-app"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let admin: minimal.Session
let member: minimal.Session

function actor(scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId: admin.userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

const GATED = [
  "kernel__companies_search",
  "kernel__companies_write",
  "kernel__portal_invite",
  "projects__deals_search",
  "projects__deals_pipeline_create",
  "projects__client_reports_list",
]

const catalog = () => ({
  gateway: listGatewayTools(orgId, actor()).map((t) => t.sdkName),
  turn: Object.keys(buildToolSet(orgId, actor(), undefined, ALL_DEFERRED_TOOLS_UNLOCKED)),
})

async function run(toolName: string, params: Record<string, unknown> = {}) {
  return (await executeToolCore({
    toolName,
    orgId,
    actor: actor(),
    params,
    origin: "in-app-agent",
  } as never)) as { error?: Record<string, any> }
}

async function rows(): Promise<number> {
  return Number(
    extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.org_app_features WHERE org_id = ${orgId}::uuid`,
      ),
    )[0]?.n,
  )
}

async function resetFeatures() {
  await db.execute(drizzleSql`DELETE FROM kernel.org_app_features WHERE org_id = ${orgId}::uuid`)
  forgetOrgApps(orgId)
  await primeOrgApps(orgId, 0)
}

const headers = (s: minimal.Session) => ({
  authorization: `Bearer ${s.bearer}`,
  "content-type": "application/json",
})

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg({ servicesFeatures: false })).id
  admin = await minimal.adminSession(orgId)
  member = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("an existing workspace after the upgrade", () => {
  it("has no feature row, lists none of the services tools, and keeps its other tools", async () => {
    await resetFeatures()
    expect(await rows()).toBe(0)
    expect(enabledFeaturesFor(orgId)).toEqual([])
    const seen = catalog()
    for (const tool of GATED) {
      expect(seen.gateway).not.toContain(tool)
      expect(seen.turn).not.toContain(tool)
    }
    expect(seen.gateway).toContain("kernel__contacts_search")
    expect(seen.gateway).toContain("projects__update_project")
  })

  it("refuses a call that still names a services tool with feature_off, for an admin holding *", async () => {
    await resetFeatures()
    for (const tool of [
      "kernel:companies_search",
      "projects:deals_search",
      "projects:client_reports_list",
    ]) {
      const out = await run(tool, { query: "x" })
      expect(out.error?.code).toBe("feature_off")
      expect(out.error?.retryable).toBe(false)
    }
  })

  it("still reads its companies from the REST API: the switch hides a surface, not data", async () => {
    await resetFeatures()
    const app = await buildTestApp()
    const r = await app.request("/api/contacts/companies?limit=5", { headers: headers(admin) })
    expect(r.status).toBe(200)
  })
})

describe("an admin turns a feature on", () => {
  it("from Settings: the route lists the admin switches (not the derived one) and turns deals on", async () => {
    await resetFeatures()
    const app = await buildTestApp()
    const listed = await app.request("/api/apps/projects/features", { headers: headers(admin) })
    expect(listed.status).toBe(200)
    const list = ((await listed.json()) as { data: Array<Record<string, unknown>> }).data
    expect(list.map((f) => f.feature)).toEqual(["client_reports", "deals"])
    expect(list.every((f) => f.enabled === false && f.canChange === true)).toBe(true)

    const put = await app.request("/api/apps/projects/features/deals", {
      method: "PUT",
      headers: headers(admin),
      body: JSON.stringify({ enabled: true }),
    })
    expect(put.status).toBe(200)
    await primeOrgApps(orgId, 0)
    expect(enabledFeaturesFor(orgId)).toEqual([{ app: "projects", feature: "deals" }])
    expect(catalog().gateway).toContain("projects__deals_search")
    expect(catalog().gateway).not.toContain("projects__client_reports_list")
    const out = await run("projects:deals_search", {})
    expect(out.error?.code).not.toBe("feature_off")

    // Off again hides it again; nothing else is touched.
    await app.request("/api/apps/projects/features/deals", {
      method: "PUT",
      headers: headers(admin),
      body: JSON.stringify({ enabled: false }),
    })
    await primeOrgApps(orgId, 0)
    expect(catalog().gateway).not.toContain("projects__deals_search")
  })

  it("refuses a member without kernel:apps:admin, and the derived time and budgets switch", async () => {
    await resetFeatures()
    const app = await buildTestApp()
    const byMember = await app.request("/api/apps/contacts/features/companies", {
      method: "PUT",
      headers: headers(member),
      body: JSON.stringify({ enabled: true }),
    })
    expect(byMember.status).toBe(403)
    const derived = await app.request("/api/apps/projects/features/time_budgets", {
      method: "PUT",
      headers: headers(admin),
      body: JSON.stringify({ enabled: true }),
    })
    expect(derived.status).toBe(403)
    expect(await rows()).toBe(0)
  })

  it("from config apply: companies on, idempotent on a second apply, unknown names refused", async () => {
    await resetFeatures()
    const parsed = configSchema.safeParse({
      org: { slug: "x", name: "X" },
      apps: [{ name: "contacts", enable: true, features: { companies: true } }],
    })
    expect(parsed.success).toBe(true)
    const ctx = {
      orgId,
      actor: { userId: admin.userId, scopes: ["*"], dimensionGrants: { "*": ["*"] } },
      log: () => {},
    } as never
    expect(await planAppFeatures(ctx, "contacts", { companies: true })).toEqual([
      "turn on app 'contacts' feature 'companies'",
    ])
    const first = await applyAppFeatures(ctx, "contacts", { companies: true })
    expect(first.changed).toEqual(["apps.contacts.features.companies"])
    const second = await applyAppFeatures(ctx, "contacts", { companies: true })
    expect(second.unchanged).toEqual(["apps.contacts.features.companies"])
    await primeOrgApps(orgId, 0)
    expect(catalog().gateway).toContain("kernel__companies_search")
    await expect(applyAppFeatures(ctx, "projects", { time_budgets: true })).rejects.toThrow(
      /not a feature of projects an admin switches/,
    )
  })
})

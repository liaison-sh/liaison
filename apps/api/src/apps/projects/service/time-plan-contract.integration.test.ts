// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The time plan's contract, on the real database: a call that sets nothing is refused before
// any approval card exists, the basis follows the project's own billing terms (a fixed price
// makes an omitted basis fixed, and a basis that contradicts the terms is refused), and a
// project created with its tasks can carry each task's timebox and milestone flag.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import * as handlers from "~/apps/projects/handlers"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import manifest from "../app.manifest.json"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

let orgId = ""
let owner: minimal.Session

function actorOf(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

type Bridge = Record<string, (json: string) => Promise<string>>

async function withBridge<T>(fn: (bridge: Bridge) => Promise<T>): Promise<T> {
  const a = actorOf(owner.userId, ["*"])
  const out = await withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    ) as unknown as Bridge
    return fn(bridge)
  })
  await awaitTimeRowWrites()
  return out
}

async function call<T = Record<string, any>>(method: string, input: unknown): Promise<T> {
  return withBridge(async (bridge) => JSON.parse(await bridge[method]!(JSON.stringify(input))) as T)
}

/** The gated tool's manifest preflight, run against the real bridge. */
async function preflight(input: unknown): Promise<{ ok?: true; error?: { code?: string } }> {
  const tools = manifest.tools as Record<string, { preflight?: string }>
  const name = tools.time_plan_set?.preflight
  expect(name).toBe("timePlanSetPreflight")
  const fn = (handlers as unknown as Record<string, (p: unknown, c: never) => Promise<unknown>>)[
    name as string
  ]
  expect(typeof fn).toBe("function")
  return withBridge(async (bridge) => (await fn!(input, bridge as never)) as never)
}

const planRow = async (projectId: string) =>
  extractRows<{ basis: string }>(
    await db.execute(drizzleSql`
      SELECT basis FROM app_projects.project_time_plan WHERE project_id = ${projectId}::uuid`),
  )[0] ?? null

let keys = 0
async function project(): Promise<string> {
  keys++
  const made = await call<{ id: string }>("projects_createProject", {
    name: `Contract plan ${keys}`,
    key: `TPC${keys}`,
    timeBudgets: true,
  })
  await awaitTimeFeatureSync(orgId)
  return made.id
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("time_plan_set refuses a call that sets nothing", () => {
  it("the preflight refuses an empty call before any card, naming the fields, and the write refuses too", async () => {
    const id = await project()
    const early = await preflight({ projectId: id })
    expect(early.error?.code).toBe("nothing_to_set")
    expect(JSON.stringify(early.error)).toContain("basis")
    expect(JSON.stringify(early.error)).toContain("timebox")
    const write = await call<{ error?: { code: string } }>("projects_timePlanSet", {
      projectId: id,
    })
    expect(write.error?.code).toBe("nothing_to_set")
    expect(await planRow(id)).toBeNull()
    expect((await preflight({ projectId: id, basis: "hourly" })).ok).toBe(true)
  })
})

describe("the basis follows the project's billing terms", () => {
  it("a fixed price makes an omitted basis fixed, and refuses hourly or daily", async () => {
    const id = await project()
    await call("projects_billingTermsSet", { projectId: id, fixedPrice: 12000, currency: "EUR" })
    for (const basis of ["hourly", "daily"]) {
      const early = await preflight({ projectId: id, basis })
      expect(early.error?.code).toBe("basis_conflicts_terms")
      const write = await call<{ error?: { code: string; message: string } }>(
        "projects_timePlanSet",
        { projectId: id, basis },
      )
      expect(write.error?.code).toBe("basis_conflicts_terms")
      expect(write.error?.message).toContain("fixed price")
    }
    expect(await planRow(id)).toBeNull()
    const saved = await call<{ basis: string; message: string }>("projects_timePlanSet", {
      projectId: id,
      timebox: "40 h",
    })
    expect(saved.basis).toBe("fixed")
    expect((await planRow(id))?.basis).toBe("fixed")
  })

  it("a rate refuses a fixed basis and leaves an omitted basis alone", async () => {
    const id = await project()
    await call("projects_billingTermsSet", { projectId: id, rate: 95, currency: "EUR" })
    const refused = await call<{ error?: { code: string; message: string } }>(
      "projects_timePlanSet",
      { projectId: id, basis: "fixed" },
    )
    expect(refused.error?.code).toBe("basis_conflicts_terms")
    expect(refused.error?.message).toContain("rate")
    const saved = await call<{ basis: string }>("projects_timePlanSet", {
      projectId: id,
      basis: "hourly",
    })
    expect(saved.basis).toBe("hourly")
    const again = await call<{ basis: string }>("projects_timePlanSet", {
      projectId: id,
      datedHours: true,
    })
    expect(again.basis).toBe("hourly")
  })
})

describe("createProject plans its tasks' hours", () => {
  it("each task takes a timebox and a milestone flag when the project uses time budgets", async () => {
    keys++
    const made = await call<{
      id?: string
      tasks?: Array<{ id: string; title: string }>
      error?: unknown
    }>("projects_createProject", {
      name: `Contract tasks ${keys}`,
      key: `TPC${keys}`,
      timeBudgets: true,
      tasks: [
        { title: "Design", timebox: "16 h" },
        { title: "Delivery", timebox: "2 days", isMilestone: true },
        { title: "Kick-off" },
      ],
    })
    expect(made.error).toBeUndefined()
    const rows = extractRows<{
      title: string
      timebox_minutes: number | null
      is_milestone: boolean
    }>(
      await db.execute(drizzleSql`
        SELECT title, timebox_minutes, is_milestone FROM app_projects.tasks
         WHERE project_id = ${made.id}::uuid ORDER BY title`),
    )
    expect(rows).toEqual([
      { title: "Delivery", timebox_minutes: 2 * 420, is_milestone: true },
      { title: "Design", timebox_minutes: 16 * 60, is_milestone: false },
      { title: "Kick-off", timebox_minutes: null, is_milestone: false },
    ])
  })

  it("a task timebox on a project without time budgets creates nothing", async () => {
    keys++
    const name = `Contract off ${keys}`
    const out = await call<{ id?: string; error?: { code?: string } }>("projects_createProject", {
      name,
      key: `TPC${keys}`,
      tasks: [{ title: "Design", timebox: "16 h" }],
    })
    expect(out.id).toBeUndefined()
    expect(out.error?.code).toBe("planning_off")
    const left = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_projects.projects
         WHERE org_id = ${orgId}::uuid AND name = ${name}`),
    )[0]
    expect(left?.n).toBe(0)
  })
})

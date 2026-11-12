// SPDX-License-Identifier: FSL-1.1-ALv2
// Per-org app usage and the per-UTC-day app caps:
//  - settled runs land in kernel.app_usage_daily per (org, app, day, executor),
//    batched, adding to the row; a capped org's runs and bridge calls are also
//    counted at once in Redis day counters (in-process platform code is not);
//  - the gate reads those counters: a top-level tool run is refused typed
//    (429 APP_RUNS_LIMIT_REACHED), nested and trusted runs never are, and
//    background work is held until the next UTC day;
//  - the loader's CPU is pulled over a v2 signed GET whose path carries the
//    query, replaces cpu_ms, and drives the CPU cap from the next run;
//  - the daily `apps.usage` report carries the caps version and the rows, and
//    a Control that refuses the type leaves `usage.report` delivered.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { CAPS_CONTRACT_VERSION } from "@liaison/control-plane-contract"
import { and, eq } from "drizzle-orm"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { appUsageDaily } from "~/db/schema/kernel"
import { _setEdition } from "~/lib/edition"
import { redis } from "~/lib/redis"
import type { RunSettledInfo } from "~/modules/apps/workers/run-settled"
import { verifyCellRequestV2 } from "~/modules/apps/workers/sign"
import { appsUsageOfDay, sendDailyAppsUsageReports } from "~/modules/cloud/apps-usage-report"
import { classifyReply } from "~/modules/liaison-team/outbox"
import { appDayKey, CapLimitError, msUntilNextUtcDay, utcDay } from "~/modules/org/caps"
import { seedOrgBillingState } from "~/seed/factories/billing/billing"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  AppDayCapHeldJobError,
  type AppDayCaps,
  AppDayCapTestAccess,
  appDayCapReached,
  appRunHoldMs,
  assertAppRunRoom,
  holdAppJobIfCapped,
} from "./app-day-cap"
import { AppUsageTestAccess, crossed, flushAppUsage, recordSettledRun } from "./app-usage"
import { fetchLoaderUsage, LoaderUsageTestAccess, storeLoaderUsage } from "./loader-usage"

const ORG = randomUUID()
const OTHER = randomUUID()
const NO_CAPS: AppDayCaps = {
  appRunsPerDay: null,
  appBridgeCallsPerDay: null,
  appCpuMsPerDay: null,
}
let caps: Record<string, AppDayCaps> = {}

function settled(over: Partial<RunSettledInfo> = {}): RunSettledInfo {
  return {
    app: "shopify",
    orgId: ORG,
    entry: "tool:orders_search",
    executor: "workers",
    nested: false,
    ms: 40,
    ok: true,
    at: Date.now(),
    bridgeCalls: 3,
    ...over,
  }
}

async function rowsOf(orgId: string) {
  return withSystemDb("t-app-usage", (db) =>
    db.select().from(appUsageDaily).where(eq(appUsageDaily.orgId, orgId)),
  )
}

/** Let the fire-and-forget counter writes land. */
const settle = () => new Promise((r) => setTimeout(r, 50))

async function clearCounters(orgId: string): Promise<void> {
  const day = utcDay(Date.now())
  await redis.del(
    appDayKey("appRunsPerDay", orgId, day),
    appDayKey("appBridgeCallsPerDay", orgId, day),
    appDayKey("appCpuMsPerDay", orgId, day),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  await seedOrgRow({ id: ORG, name: "Usage org", slug: `usage-${ORG.slice(0, 8)}` })
  await seedOrgRow({ id: OTHER, name: "Other org", slug: `usage-${OTHER.slice(0, 8)}` })
  AppDayCapTestAccess.setReader(async (orgId) => caps[orgId] ?? NO_CAPS)
})
afterEach(async () => {
  caps = {}
  AppDayCapTestAccess.clearCache()
  AppUsageTestAccess.clear()
  LoaderUsageTestAccess.setFetch(null)
  await clearCounters(ORG)
  await clearCounters(OTHER)
})
afterAll(async () => {
  AppDayCapTestAccess.setReader(null)
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER})`
  await releaseTestLock()
})

describe("recording settled runs", () => {
  it("adds to one row per (org, app, day, executor), batched", async () => {
    recordSettledRun(settled())
    recordSettledRun(settled({ ms: 60, bridgeCalls: 2 }))
    recordSettledRun(settled({ executor: "quickjs", bridgeCalls: undefined, ms: 5 }))
    expect(AppUsageTestAccess.pendingRows()).toHaveLength(2)
    await flushAppUsage()
    recordSettledRun(settled({ ms: 10, bridgeCalls: 1 }))
    await flushAppUsage()
    const rows = await rowsOf(ORG)
    const workers = rows.find((r) => r.executor === "workers")
    const quickjs = rows.find((r) => r.executor === "quickjs")
    expect(workers).toMatchObject({ app: "shopify", runs: 3, bridgeCalls: 6, wallMs: 110 })
    expect(workers?.cpuMs).toBeNull()
    expect(quickjs).toMatchObject({ runs: 1, bridgeCalls: 0, wallMs: 5 })
    await sql`DELETE FROM kernel.app_usage_daily WHERE org_id = ${ORG}`
  })

  it("counts a capped org's runs and bridge calls in Redis at once; never in-process ones", async () => {
    caps[ORG] = { ...NO_CAPS, appRunsPerDay: 100 }
    recordSettledRun(settled({ bridgeCalls: 4 }))
    recordSettledRun(settled({ executor: "inprocess", bridgeCalls: 0 }))
    recordSettledRun(settled({ orgId: OTHER }))
    await settle()
    const day = utcDay(Date.now())
    expect(await redis.get(appDayKey("appRunsPerDay", ORG, day))).toBe("1")
    expect(await redis.get(appDayKey("appBridgeCallsPerDay", ORG, day))).toBe("4")
    // An org without an app cap costs no counter.
    expect(await redis.get(appDayKey("appRunsPerDay", OTHER, day))).toBeNull()
    AppUsageTestAccess.clear()
  })

  it("a crossing is 80 % or 100 % reached by this step", () => {
    expect(crossed(78, 79, 100)).toBe(false)
    expect(crossed(79, 80, 100)).toBe(true)
    expect(crossed(80, 81, 100)).toBe(false)
    expect(crossed(99, 100, 100)).toBe(true)
    expect(crossed(70, 120, 100)).toBe(true)
  })
})

describe("the gate", () => {
  it("refuses a top-level run at the runs cap, typed 429 with {limit, used}", async () => {
    caps[ORG] = { ...NO_CAPS, appRunsPerDay: 2 }
    await redis.set(appDayKey("appRunsPerDay", ORG, utcDay(Date.now())), "2")
    const err = await assertAppRunRoom({ orgId: ORG, trusted: false }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CapLimitError)
    const cap = err as CapLimitError
    expect(cap.status).toBe(429)
    expect(cap.code).toBe("APP_RUNS_LIMIT_REACHED")
    expect(cap.details).toEqual({ limit: 2, used: 2 })
    expect(cap.message).toContain("midnight UTC")
  })

  it("never refuses a nested run, trusted code, an org under the cap or without one", async () => {
    caps[ORG] = { ...NO_CAPS, appRunsPerDay: 2 }
    await redis.set(appDayKey("appRunsPerDay", ORG, utcDay(Date.now())), "5")
    await assertAppRunRoom({ orgId: ORG, trusted: false, nested: true })
    await assertAppRunRoom({ orgId: ORG, trusted: true })
    expect(await appRunHoldMs({ orgId: ORG, trusted: false, nested: true })).toBeNull()
    caps[ORG] = { ...NO_CAPS, appRunsPerDay: 6 }
    AppDayCapTestAccess.clearCache()
    await assertAppRunRoom({ orgId: ORG, trusted: false })
    await assertAppRunRoom({ orgId: OTHER, trusted: false })
  })

  it("holds background work until the next UTC day (job: AppDayCapHeldJobError)", async () => {
    caps[ORG] = { ...NO_CAPS, appBridgeCallsPerDay: 10 }
    await redis.set(appDayKey("appBridgeCallsPerDay", ORG, utcDay(Date.now())), "10")
    const now = Date.now()
    const hold = await appRunHoldMs({ orgId: ORG, trusted: false }, now)
    expect(hold).not.toBeNull()
    expect(hold as number).toBeGreaterThanOrEqual(msUntilNextUtcDay(now))
    expect(hold as number).toBeLessThanOrEqual(msUntilNextUtcDay(now) + 5 * 60_000)
    const err = await holdAppJobIfCapped({ orgId: ORG, trusted: false }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AppDayCapHeldJobError)
    expect((err as AppDayCapHeldJobError).kind).toBe("appBridgeCallsPerDay")
  })

  it("Redis down reads as open (an unreadable counter never holds work back)", async () => {
    caps[ORG] = { ...NO_CAPS, appRunsPerDay: 1 }
    const real = redis.mget.bind(redis)
    ;(redis as unknown as { mget: unknown }).mget = async () => {
      throw new Error("redis down")
    }
    try {
      expect(await appDayCapReached(ORG)).toBeNull()
    } finally {
      ;(redis as unknown as { mget: unknown }).mget = real
    }
  })
})

describe("CPU from the loader", () => {
  const config = {
    apps: new Set<string>(),
    customApps: false,
    loaderUrl: "https://loader.test",
    cellId: "cell-test",
    loaderKey: "k".repeat(64),
    bridgeBaseUrl: "https://cell.test/api/app-bridge",
    bundles: new Map<string, string>(),
  }

  it("asks with a v2 signature over the path and its query, an empty body", async () => {
    const day = "2026-11-06"
    let seen: { url: string; headers: Headers; method?: string } | null = null
    LoaderUsageTestAccess.setFetch(async (url, init) => {
      seen = { url, headers: new Headers(init.headers), method: init.method }
      return Response.json({
        ok: true,
        cellId: "cell-test",
        day,
        rows: [
          { orgId: ORG, app: "shopify", runs: 3, cpuMs: 12.4, wallMs: 30, unattributedRuns: 0 },
          { orgId: "unknown", app: "x", runs: 1, cpuMs: 1, wallMs: 1, unattributedRuns: 1 },
        ],
      })
    })
    const rows = await fetchLoaderUsage(config, day)
    expect(rows).toEqual([{ orgId: ORG, app: "shopify", cpuMs: 12 }])
    const s = seen as unknown as { url: string; headers: Headers; method?: string }
    expect(s.url).toBe(`https://loader.test/usage?day=${day}`)
    expect(s.method).toBe("GET")
    const verdict = verifyCellRequestV2({
      cellKey: config.loaderKey,
      direction: "cell->loader",
      method: "GET",
      path: `/usage?day=${day}`,
      ts: s.headers.get("x-cell-ts"),
      signature: s.headers.get("x-cell-signature"),
      version: s.headers.get("x-cell-signature-version"),
      body: "",
    })
    expect(verdict).toEqual({ ok: true })
    expect(s.headers.get("x-cell-id")).toBe("cell-test")
  })

  it("a refused pull throws with the status and body", async () => {
    LoaderUsageTestAccess.setFetch(async () => new Response('{"error":"auth"}', { status: 401 }))
    await expect(fetchLoaderUsage(config, "2026-11-06")).rejects.toThrow(/401/)
  })

  it("replaces cpu_ms on the workers row and drives the CPU cap from the next run", async () => {
    const day = utcDay(Date.now())
    recordSettledRun(settled())
    await flushAppUsage()
    caps[ORG] = { ...NO_CAPS, appCpuMsPerDay: 500 }
    // The run above read (and cached for 60 s) the caps before they were set.
    AppDayCapTestAccess.clearCache()
    await storeLoaderUsage(day, [{ orgId: ORG, app: "shopify", cpuMs: 300 }])
    await storeLoaderUsage(day, [{ orgId: ORG, app: "shopify", cpuMs: 450 }])
    const [row] = await withSystemDb("t", (db) =>
      db
        .select()
        .from(appUsageDaily)
        .where(and(eq(appUsageDaily.orgId, ORG), eq(appUsageDaily.executor, "workers"))),
    )
    expect(row).toMatchObject({ runs: 1, cpuMs: 450 })
    expect(await appDayCapReached(ORG)).toBeNull()
    await storeLoaderUsage(day, [{ orgId: ORG, app: "shopify", cpuMs: 520 }])
    expect(await appDayCapReached(ORG)).toEqual({ kind: "appCpuMsPerDay", limit: 500, used: 520 })
    await sql`DELETE FROM kernel.app_usage_daily WHERE org_id = ${ORG}`
  })
})

describe("the daily apps.usage report", () => {
  it("goes out per org Control placed here, with the caps version and the day's rows", async () => {
    const now = new Date("2026-04-11T00:15:00Z")
    const day = "2026-04-10"
    recordSettledRun(settled({ at: Date.parse(`${day}T10:00:00Z`) }))
    recordSettledRun(settled({ at: Date.parse(`${day}T11:00:00Z`), executor: "quickjs" }))
    await flushAppUsage()
    await seedOrgBillingState(ORG, {}, { onConflict: "replace" })
    await seedOrgBillingState(OTHER, {}, { onConflict: "replace" })
    const usage = await appsUsageOfDay(day)
    expect(usage.get(ORG)).toEqual([
      { app: "shopify", executor: "quickjs", runs: 1, bridgeCalls: 3, wallMs: 40, cpuMs: null },
      { app: "shopify", executor: "workers", runs: 1, bridgeCalls: 3, wallMs: 40, cpuMs: null },
    ])
    await sql`DELETE FROM kernel.control_plane_outbox WHERE type = 'apps.usage'`
    expect(await sendDailyAppsUsageReports(now)).toBe(0) // self-hosted: nothing
    _setEdition("managed")
    try {
      expect(await sendDailyAppsUsageReports(now)).toBeGreaterThanOrEqual(2)
    } finally {
      _setEdition(null)
    }
    const queued = await sql`SELECT data FROM kernel.control_plane_outbox
      WHERE type = 'apps.usage' AND data->>'orgId' IN (${ORG}, ${OTHER})`
    const byOrg = new Map(queued.map((r) => [r.data.orgId, r.data]))
    expect(byOrg.get(ORG)).toMatchObject({
      day,
      capsVersion: CAPS_CONTRACT_VERSION,
      rows: usage.get(ORG),
    })
    // An org with no app runs still reports, so Control learns the caps version.
    expect(byOrg.get(OTHER)).toMatchObject({ day, capsVersion: 2, rows: [] })
    await sql`DELETE FROM kernel.control_plane_outbox WHERE type = 'apps.usage'`
    await sql`DELETE FROM kernel.org_billing_state WHERE org_id IN (${ORG}, ${OTHER})`
    await sql`DELETE FROM kernel.app_usage_daily WHERE org_id = ${ORG}`
  })

  it("old Control, new cell: a refused apps.usage is refused alone; usage.report still delivers", () => {
    const ctx = { now: new Date(), clockOffsetMs: 0 }
    const headers = new Headers()
    const refused = classifyReply(
      { type: "apps.usage", messageId: randomUUID(), attempts: 0 },
      { status: 200, headers, body: { data: { ok: false, code: "invalid_request" } } },
      ctx,
    )
    expect(refused.kind).toBe("refused")
    const http400 = classifyReply(
      { type: "apps.usage", messageId: randomUUID(), attempts: 0 },
      { status: 400, headers, body: { error: { message: "unknown type" } } },
      ctx,
    )
    expect(http400.kind).toBe("refused")
    const report = classifyReply(
      { type: "usage.report", messageId: randomUUID(), attempts: 0 },
      { status: 200, headers, body: { data: { ok: true } } },
      ctx,
    )
    expect(report.kind).toBe("delivered")
  })
})

describe("a run on the instance's sandbox service", () => {
  it("has its own row, executor workerd, no CPU", async () => {
    recordSettledRun(settled({ executor: "workerd", ms: 7, bridgeCalls: 3 }))
    await flushAppUsage()
    const rows = await rowsOf(ORG)
    const workerd = rows.find((r) => r.executor === "workerd")
    expect(workerd).toMatchObject({ app: "shopify", runs: 1, bridgeCalls: 3, wallMs: 7 })
    expect(workerd?.cpuMs).toBeNull()
    await sql`DELETE FROM kernel.app_usage_daily WHERE org_id = ${ORG}`
  })
})

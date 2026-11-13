// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/admin/app-health: the instance operator sees the cell's app-run
// health and the checks; another org's admin sees only their org's runs.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { app } from "~/app"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { resetOperatorOrgCache } from "~/modules/apps/operator-org"
import {
  flushRunHealth,
  RunHealthKeys,
  RunHealthTestAccess,
  recordRunHealth,
} from "~/modules/apps/usage/run-health"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const savedOperator = env.LIAISON_OPERATOR_ORG_ID
const setOperator = (v: string | undefined) => {
  ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = v
  resetOperatorOrgCache()
}

interface Body {
  data: {
    scope: "instance" | "org"
    alerts?: unknown[]
    cell?: { "15m": { apps: Array<{ app: string }> } } | null
    org?: { "15m": { total: { runs: number }; apps: Array<{ app: string }>; pools: object } } | null
  }
}

const get = (s: minimal.Session) =>
  app.request("/api/admin/app-health", { headers: { Authorization: `Bearer ${s.bearer}` } })

const at = Date.now()
const keys: string[] = []

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  setOperator(savedOperator)
  await releaseTestLock()
})
afterEach(async () => {
  RunHealthTestAccess.clear()
  if (keys.length) await redis.del(...keys.splice(0))
})

function seedRun(orgId: string, appName: string): void {
  recordRunHealth({
    app: appName,
    orgId,
    entry: "tool:search",
    executor: "workerd",
    nested: false,
    ms: 300,
    ok: true,
    at,
  })
  keys.push(
    RunHealthKeys.minute(at, orgId),
    RunHealthKeys.hour(at, orgId),
    RunHealthKeys.slow(at, orgId),
  )
}

describe("/api/admin/app-health", () => {
  it("a member without kernel:org:admin gets 403", async () => {
    const member = await minimal.session((await createTestOrg()).id)
    expect((await get(member)).status).toBe(403)
  })

  it("an org admin sees their org's apps only", async () => {
    const mine = await createTestOrg()
    // Another org's runs (Redis only) and an operator that is not this org.
    const other = { id: randomUUID() }
    setOperator(randomUUID())
    seedRun(mine.id, "health-mine")
    seedRun(other.id, "health-theirs")
    await flushRunHealth()
    const res = await get(await minimal.adminSession(mine.id))
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Body
    expect(data.scope).toBe("org")
    expect(data.org?.["15m"].total.runs).toBe(1)
    expect(data.org?.["15m"].apps.map((a) => a.app)).toEqual(["health-mine"])
    expect(data.org?.["15m"].pools).toEqual({})
    expect("cell" in data).toBe(false)
  })

  it("the instance operator sees every org's apps and the checks", async () => {
    const operator = await createTestOrg()
    const tenant = { id: randomUUID() }
    setOperator(operator.id)
    seedRun(tenant.id, "health-tenant")
    await flushRunHealth()
    const res = await get(await minimal.adminSession(operator.id))
    const { data } = (await res.json()) as Body
    expect(data.scope).toBe("instance")
    expect(Array.isArray(data.alerts)).toBe(true)
    expect(data.cell?.["15m"].apps.some((a) => a.app === "health-tenant")).toBe(true)
  })
})

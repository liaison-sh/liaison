// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boot registers no org (index.ts): each org registers on its first touch. A
// request or a job for an org not registered in this process must wait for
// that org and then run with its full app state, and only that org registers.
// Real database, real registration, real auth middleware and job dispatch.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { JobsTestAccess, registerJobWorker } from "~/infra/jobs/jobs"
import { env } from "~/lib/env"
import { authMiddleware } from "~/middleware/auth"
import { errorHandler } from "~/middleware/error-handler"
import { initializedOrgRuntimes, manifestRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const PROBE_JOB = "first-touch-registration-probe"

let orgA: string
let orgB: string
let tokenB: string
/** An app whose manifest every registered org carries. */
let probeApp: string

/** What the app registries hold for the org right now. */
function registryState(orgId: string) {
  return {
    registered: initializedOrgRuntimes.has(orgId),
    hasManifest: manifestRegistry.get([orgId, probeApp]) !== undefined,
  }
}

/** Org B as it is after a restart: in the database, absent from the registries. */
function forgetOrgB() {
  resetOrgRuntimeForTest(orgB)
  manifestRegistry.deleteByPrefix([orgB])
  expect(registryState(orgB)).toEqual({ registered: false, hasManifest: false })
}

/** What the probe job saw, each time it ran. */
const probeSaw: Array<ReturnType<typeof registryState>> = []

beforeAll(async () => {
  await acquireTestLock()
  orgA = (await createTestOrg()).id
  const second = await minimal.secondOrg()
  orgB = second.orgId
  tokenB = await minimal.token(second.adminUserId)
  const first = [...manifestRegistry.entries()].find(([[o]]) => o === orgB)
  if (!first) throw new Error("org B registered no manifest app")
  probeApp = first[0][1]
  registerJobWorker(
    "test",
    PROBE_JOB,
    async (payload: { orgId: string }) => {
      probeSaw.push(registryState(payload.orgId))
    },
    { txMode: "session" },
  )
})

beforeEach(() => {
  // A fresh process: neither org registered.
  resetOrgRuntimeForTest(orgA)
  manifestRegistry.deleteByPrefix([orgA])
  forgetOrgB()
})

afterAll(async () => {
  await releaseTestLock()
})

describe("an org not registered in this process (no boot registration)", () => {
  it("an authenticated request waits for its registration, then runs with its apps", async () => {
    const app = new Hono<AppEnv>()
    app.onError(errorHandler)
    app.use("*", authMiddleware(env.JWT_SECRET))
    app.get("/probe", (c) => c.json(registryState(c.get("orgId"))))

    const res = await app.request("/probe", { headers: { Authorization: `Bearer ${tokenB}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ registered: true, hasManifest: true })
    // Only the touched org registered.
    expect(registryState(orgA)).toEqual({ registered: false, hasManifest: false })
  })

  it("a job for it waits for its registration, then runs with its apps", async () => {
    probeSaw.length = 0
    await JobsTestAccess.processJob("test", PROBE_JOB, { orgId: orgB })
    expect(probeSaw).toEqual([{ registered: true, hasManifest: true }])
    expect(registryState(orgA)).toEqual({ registered: false, hasManifest: false })
  })
})

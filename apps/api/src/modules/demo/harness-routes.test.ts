// SPDX-License-Identifier: FSL-1.1-ALv2
// The load harness's signed flood (modules/demo/harness-routes.ts): 404 unless
// signed with the box key and aimed at a load org, batches of 500, and a cap on
// an org's outstanding synthetic jobs.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import type { enqueueAppJobs } from "~/infra/jobs/jobs"
import { LoadSyntheticTestAccess, readLoadSyntheticStats } from "~/infra/jobs/load-synthetic"
import {
  forgetLoadOrgFlag,
  HARNESS_HEADER_NONCE,
  HARNESS_HEADER_SIGNATURE,
  HARNESS_HEADER_TIMESTAMP,
  LoadHarnessTestAccess,
  rememberLoadOrg,
  signHarnessRequest,
} from "~/lib/load-harness"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { FLOOD_MAX_OUTSTANDING, HarnessRoutesTestAccess, harnessRoutes } from "./harness-routes"

const KEY = "k".repeat(48)
const app = new Hono<AppEnv>()
app.onError(errorHandler)
app.route("/api/demo/harness", harnessRoutes)

const FLOOD = "/api/demo/harness/flood"

/** A signed POST of `body` (its exact bytes are signed), or an unsigned one. */
async function signedPost(path: string, body: unknown, opts: { unsigned?: boolean } = {}) {
  const raw = JSON.stringify(body)
  const timestamp = Date.now()
  const nonce = `n${crypto.randomUUID().replaceAll("-", "")}`
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (!opts.unsigned) {
    headers[HARNESS_HEADER_TIMESTAMP] = String(timestamp)
    headers[HARNESS_HEADER_NONCE] = nonce
    headers[HARNESS_HEADER_SIGNATURE] = signHarnessRequest(
      { method: "POST", path, timestamp, nonce, body: raw },
      KEY,
    )
  }
  const res = await app.request(path, { method: "POST", headers, body: raw })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as {
      data?: { enqueued: number; queue: string }
      error?: { code?: string }
    },
  }
}

/** Records every enqueue call's batch instead of adding to BullMQ. */
function recordEnqueues(): number[] {
  const batches: number[] = []
  const fake: typeof enqueueAppJobs = async (appName, jobs) => {
    expect(appName).toBe("kernel")
    expect(jobs.every((j) => j.jobName === "load-synthetic")).toBe(true)
    batches.push(jobs.length)
  }
  HarnessRoutesTestAccess.setEnqueue(fake)
  return batches
}

const orgs: string[] = []
function loadOrg(): string {
  const orgId = crypto.randomUUID()
  orgs.push(orgId)
  rememberLoadOrg(orgId)
  return orgId
}

beforeAll(() => {
  DemoModeTestAccess.set(true)
})

afterEach(() => {
  HarnessRoutesTestAccess.setEnqueue(undefined)
  LoadHarnessTestAccess.setKey(undefined)
})

afterAll(async () => {
  DemoModeTestAccess.set(null)
  for (const o of orgs) {
    forgetLoadOrgFlag(o)
    await LoadSyntheticTestAccess.forget(o)
  }
})

describe("the signed flood", () => {
  it("flood without the key is 404", async () => {
    const batches = recordEnqueues()
    LoadHarnessTestAccess.setKey(null)
    const orgId = crypto.randomUUID()
    expect((await signedPost(FLOOD, { orgId, count: 10, sleepMs: 0 })).status).toBe(404)
    LoadHarnessTestAccess.setKey(KEY)
    const unsigned = await signedPost(FLOOD, { orgId, count: 10, sleepMs: 0 }, { unsigned: true })
    expect(unsigned.status).toBe(404)
    expect(batches).toEqual([])
  })

  it("flood for a non-load org is refused", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const batches = recordEnqueues()
    // An org id with no load flag (no such org at all): the same 404.
    const res = await signedPost(FLOOD, { orgId: crypto.randomUUID(), count: 10, sleepMs: 0 })
    expect(res.status).toBe(404)
    expect(batches).toEqual([])
  })

  it("flood enqueues count jobs", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const orgId = loadOrg()
    const batches = recordEnqueues()
    const res = await signedPost(FLOOD, { orgId, count: 1_200, sleepMs: 50 })
    expect(res.status).toBe(200)
    expect(res.body.data?.enqueued).toBe(1_200)
    expect(res.body.data?.queue).toBe("kernel-agent")
    // Batches of 500 at most, adding up to the count.
    expect(batches).toEqual([500, 500, 200])
    expect((await redis.hget(`load:synthetic:${orgId}`, "enqueued")) ?? "0").toBe("1200")
    // Over the bounds the body is refused before anything is enqueued.
    expect((await signedPost(FLOOD, { orgId, count: 20_001, sleepMs: 0 })).status).toBe(400)
    expect((await signedPost(FLOOD, { orgId, count: 1, sleepMs: 2_001 })).status).toBe(400)
    expect(batches).toEqual([500, 500, 200])
  })

  it("flood over the outstanding cap is refused", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const orgId = loadOrg()
    const batches = recordEnqueues()
    expect(FLOOD_MAX_OUTSTANDING).toBe(50_000)
    for (let i = 0; i < 2; i++) {
      expect((await signedPost(FLOOD, { orgId, count: 20_000, sleepMs: 0 })).status).toBe(200)
    }
    // 40 000 outstanding: 10 000 more fit, 10 001 do not.
    const over = await signedPost(FLOOD, { orgId, count: 10_001, sleepMs: 0 })
    expect(over.status).toBe(409)
    expect(over.body.error?.code).toBe("flood_outstanding_cap")
    const total = batches.reduce((a, b) => a + b, 0)
    expect(total).toBe(40_000)
    // Runs to the end free room again.
    await redis.hset(`load:synthetic:${orgId}`, "runs", "1")
    expect((await signedPost(FLOOD, { orgId, count: 10_001, sleepMs: 0 })).status).toBe(200)
    expect((await readLoadSyntheticStats(orgId)).runs).toBe(1)
  })

  it("flood with reset forgets jobs that left their queue unrun", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const orgId = loadOrg()
    recordEnqueues()
    for (let i = 0; i < 2; i++) {
      expect((await signedPost(FLOOD, { orgId, count: 20_000, sleepMs: 0 })).status).toBe(200)
    }
    await redis.hset(`load:synthetic:${orgId}`, "enqueued", "49999")
    expect((await signedPost(FLOOD, { orgId, count: 10, sleepMs: 0 })).status).toBe(409)
    expect((await signedPost(FLOOD, { orgId, count: 10, sleepMs: 0, reset: true })).status).toBe(
      200,
    )
    // The reset dropped the lost jobs: only this flood's 10 are outstanding.
    expect(await redis.hget(`load:synthetic:${orgId}`, "enqueued")).toBe("10")
  })
})

const REPORT = "/api/demo/harness/fanout-report"

describe("the signed fan-out report", () => {
  const window = { fromMs: Date.now() - 3 * 3600_000, toMs: Date.now() }

  it("report without a signature is 404", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const body = { orgIds: [loadOrg()], ...window }
    expect((await signedPost(REPORT, body, { unsigned: true })).status).toBe(404)
  })

  it("report refuses the whole request when any org is not a load org", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const body = { orgIds: [loadOrg(), crypto.randomUUID()], ...window }
    expect((await signedPost(REPORT, body)).status).toBe(404)
  })

  it("a signed report for load orgs echoes its window and the waits window read", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const res = await signedPost(REPORT, { orgIds: [loadOrg()], ...window })
    expect(res.status).toBe(200)
    const data = res.body.data as unknown as {
      window: { fromMs: number; toMs: number }
      waitsWindow: { fromMs: number; toMs: number }
    }
    expect(data.window).toEqual(window)
    // Waits are kept 2 h: only the last 120 minutes of a 3 h window were read.
    expect(data.waitsWindow.toMs).toBe(window.toMs)
    expect(data.waitsWindow.fromMs).toBe(window.toMs - 119 * 60_000)
  })
})

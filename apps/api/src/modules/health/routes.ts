// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { __privileged_db__ as db } from "~/db/connection"
import { markOwnDependencyDown } from "~/lib/own-dependency-down"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"
import { wantsHealthzDetail } from "~/modules/healthz"

export const health = new Hono<AppEnv>()

// Public health check — returns minimal info to avoid aiding reconnaissance.
// Detailed health info (DB/Redis connectivity) should live behind auth on /api/admin/health.
health.get("/", (c) => {
  return success(c, { status: "ok" })
})

const READY_TIMEOUT_MS = 2_000

async function withReadyTimeout(fn: () => Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn().catch(() => "error"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), READY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Readiness probe: checks real dependencies for load balancer health gating.
// The verdict (status code + ready/degraded) is public; which dependency is down
// is reconnaissance, so it goes only to the callers /healthz shows detail to (a
// local operator with no proxy trace, or the monitor bearer token).
health.get("/ready", async (c) => {
  const [dbStatus, redisStatus] = await Promise.all([
    withReadyTimeout(async () => {
      await db.execute(drizzleSql`SELECT 1`)
      return "ok"
    }),
    withReadyTimeout(async () => {
      await redis.ping()
      return "ok"
    }),
  ])

  const checks: Record<string, string> = { db: dbStatus, redis: redisStatus }
  const allOk = Object.values(checks).every((v) => v === "ok")
  const status = allOk ? "ready" : "degraded"
  c.header("Cache-Control", "no-store")
  const data = wantsHealthzDetail(c.req.raw.headers) ? { status, ...checks } : { status }
  if (!allOk) markOwnDependencyDown(c)
  return c.json({ data }, allOk ? 200 : 503)
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cell test seam (P3 T6), mounted only when `qaSeedRoutesEnabled`: a request
// that is still running when the process gets its SIGTERM, so the shutdown
// scenario can prove an in-flight request finishes (S9).
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { success } from "~/lib/response"

export const shutdownTestRoutes = new Hono<AppEnv>()

shutdownTestRoutes.use("*", async (_c, next) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  await next()
})

const MAX_SLOW_MS = 30_000

/** GET /api/_test/shutdown/slow?ms=4000: answers after `ms`. */
shutdownTestRoutes.get("/slow", async (c) => {
  const ms = Math.min(MAX_SLOW_MS, Math.max(0, Number(c.req.query("ms") ?? 4_000)))
  const startedAt = Date.now()
  await Bun.sleep(ms)
  return success(c, { sleptMs: ms, startedAt, endedAt: Date.now() })
})

const MAX_BLOCK_MS = 60_000

/**
 * GET /api/_test/shutdown/block?ms=30000: holds the main thread in a
 * synchronous loop for `ms` (no timer, no I/O runs meanwhile), the wedge the
 * shutdown watchdog exists for.
 */
shutdownTestRoutes.get("/block", (c) => {
  const ms = Math.min(MAX_BLOCK_MS, Math.max(0, Number(c.req.query("ms") ?? 30_000)))
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Busy on purpose.
  }
  return success(c, { blockedMs: ms })
})

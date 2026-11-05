// SPDX-License-Identifier: FSL-1.1-ALv2
// GET /readyz: 200 once this process's role has booted and it is not draining,
// 503 otherwise, with the same JSON body either way
// ({ status, role, instanceId, leader }). No auth and no dependency call: a
// load balancer polls it every second. /healthz stays the liveness and
// dependency probe.
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { markOwnDependencyDown } from "~/lib/own-dependency-down"
import { readiness } from "~/lib/readiness"

export const readyzRoutes = new Hono<AppEnv>().get("/", (c) => {
  const body = readiness()
  // Not ready is this process itself (booting, draining), never an upstream.
  if (body.status !== "ready") markOwnDependencyDown(c)
  return c.json(body, body.status === "ready" ? 200 : 503)
})

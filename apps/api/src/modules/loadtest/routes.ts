// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Load-test-only routes. Mounted by app.ts only when ENABLE_LOAD_TEST_ENDPOINT
// is "true" — keeps these out of every production image by accident. Spec
// V6/A2: "k6 test: emit kernel event server-side, measure time to client
// onmessage." The endpoint here is the server-side emit; A2's k6 script POSTs
// to it from inside its WS-connected VUs and the receiving handler measures
// elapsed `_serverEmittedAt`.

import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { authMiddleware } from "~/middleware/auth"

export function createLoadTestRoutes(jwtSecret: string) {
  const app = new Hono<AppEnv>()
  app.use("*", authMiddleware(jwtSecret))
  app.post("/ws-emit", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    await broadcastEphemeral({
      app: "kernel",
      entity: "loadtest",
      action: "emit",
      orgId,
      actorId: userId,
      data: { _serverEmittedAt: Date.now() },
    })
    return c.json({ data: { ok: true } })
  })
  return app
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/client-policy, UNAUTHENTICATED (S4).
//
// The desktop and phone shells are installed software: an old copy keeps
// talking to a server that has moved on. This route publishes the oldest shell
// version per platform the server still supports, so a shell below it can show
// its own update notice. It carries the three minimums and nothing else.
//
// THE HEADER. A shell that got an answer here sends `X-Liaison-Client:
// <desktop|ios|android>/<semver>` on its later calls. The header is in the CORS
// allowHeaders (app.ts) one release before any shell sends it, because a
// preflight that does not allow it fails every call of that shell. It is
// logged at debug level for diagnosis and NEVER used for an access decision:
// anyone can send any value.
import type { MiddlewareHandler } from "hono"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { success } from "~/lib/response"

export const CLIENT_HEADER = "X-Liaison-Client"

export interface ClientPolicy {
  desktop: string
  ios: string
  android: string
}

export const clientPolicyRoutes = new Hono<AppEnv>()

clientPolicyRoutes.get("/", (c) => {
  const policy: ClientPolicy = {
    desktop: env.LIAISON_MIN_CLIENT_DESKTOP,
    ios: env.LIAISON_MIN_CLIENT_IOS,
    android: env.LIAISON_MIN_CLIENT_ANDROID,
  }
  c.header("Cache-Control", "public, max-age=300")
  return success(c, policy)
})

/** Logs the shell's self-declared version at debug level. Diagnosis only, never access. */
export const logClientHeader: MiddlewareHandler<AppEnv> = async (c, next) => {
  const client = c.req.header(CLIENT_HEADER)
  if (client) rootLogger.debug({ client: client.slice(0, 64), path: c.req.path }, "client version")
  return next()
}

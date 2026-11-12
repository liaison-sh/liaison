// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bridge-only listener (LIAISON_APP_BRIDGE_PORT): a second port of the
// app that answers `POST /api/app-bridge/<runId>` and nothing else, for the
// sandbox network. The instance's sandbox service (workerd under gVisor, the
// `sandbox` compose service) reaches the app on this port only, so a run that
// escaped its isolate still finds no login, no API, no bundle route and no
// health page there: every other path and method is 404, before the app sees
// the request. A run's bridge calls carry its own run token, checked by the
// bridge route (bridge-route.ts) as on the public listener.
//
// It stays open until the process exits: a draining process's sandbox runs
// still call back on it while they finish.

import type { Server } from "bun"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "app-bridge-listener" })

/** A run's bridge call path: `/api/app-bridge/<runId>`, one segment, never `bundles/...`. */
const BRIDGE_CALL = /^\/api\/app-bridge\/(?!bundles(?:\/|$))[^/]+$/

/** Whether the bridge-only listener passes this request on to the app. */
export function isBridgeListenerRequest(method: string, path: string): boolean {
  return method === "POST" && BRIDGE_CALL.test(path)
}

/** A bridge call's body is a run's call (the cell's own bridge route bounds it further). */
const MAX_BRIDGE_BODY_BYTES = 16 * 1024 * 1024

export function startBridgeListener(
  fetchApp: { fetch: (req: Request) => Response | Promise<Response> },
  opts: { port: number; hostname?: string },
): Server<undefined> {
  const server = Bun.serve({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port,
    maxRequestBodySize: MAX_BRIDGE_BODY_BYTES,
    fetch: (req) =>
      isBridgeListenerRequest(req.method, new URL(req.url).pathname)
        ? fetchApp.fetch(req)
        : new Response("Not Found", { status: 404 }),
  })
  log.info({ port: server.port }, "App bridge listener (sandbox network) listening")
  return server
}

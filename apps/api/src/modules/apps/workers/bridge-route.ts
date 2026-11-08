// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/app-bridge/:runId — a remote isolate's ctx.* call for one run.
//
// The HTTP analogue of the subprocess pool's bridge_call/bridge_result IPC
// (sandbox/worker-pool.ts): the body is `{callId, method, args}` exactly as the
// shim sends it, the answer is `{data}` or `{error, errorStatus?, errorCode?}`.
// Mounted before the user JWT chain: its only credential is the run's bearer
// token (run-registry.ts), which binds the call to one run, one org and one
// app. The bridge called is the one the dispatching code registered; nothing
// here builds or widens it. Every path answers 404 unless the Workers executor
// is configured (config.ts).
//
// Statuses: 401 `unknown_run` / `bad_token` / `expired`, 403 another run's
// token, 404 unknown method, 409 another execution's nonce, 410 run settled,
// 504 the call outlived the run's deadline, 400 malformed body.
//
// Any process of the cell may receive the call. The run id names its owner
// (`<instanceId>:<uuid>`); a call for another process's run is forwarded to
// that process's internal listener (bridge-forward.ts), which answers it with
// answerBridgeCall (bridge-call.ts), so the statuses are the same on every
// process. Nothing of the call goes through Redis: only the owner's internal
// address is read there.

import { type Context, Hono } from "hono"
import { getClientIp } from "~/lib/request-context"
import { ownerInstanceOf } from "~/modules/agent/mailbox-plaintext/mailbox-forward"
import { answerBridgeCall } from "./bridge-call"
import { type BridgeForwarder, createBridgeForwarder } from "./bridge-forward"
import { workersConfigured } from "./config"
import { type RunRegistry, runRegistry } from "./run-registry"

/** The route's mount point; app.ts exempts it from the generic timeout, body cap and IP limiter. */
export const APP_BRIDGE_PATH_PREFIX = "/api/app-bridge/"

export interface AppBridgeRouteDeps {
  registry?: RunRegistry
  isConfigured?: () => boolean
  /** Hands a call for another process's run to its owner (bridge-forward.ts). */
  forwarder?: BridgeForwarder
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return m?.[1]
}

export function createAppBridgeRoutes(deps: AppBridgeRouteDeps = {}) {
  const registry = deps.registry ?? runRegistry
  const isConfigured = deps.isConfigured ?? workersConfigured
  const forwarder = deps.forwarder ?? createBridgeForwarder()

  return new Hono().post("/:runId", async (c) => {
    if (!isConfigured()) return c.json({ error: "Not found", reason: "not_found" }, 404)

    const runId = c.req.param("runId")
    const token = bearer(c.req.header("authorization"))
    const nonce = c.req.header("x-exec-nonce") || undefined
    const owner = ownerInstanceOf(runId)

    // A run of another process of the cell: checked here as far as a
    // non-owner can (the token's MAC), then handed to its owner.
    const res =
      owner !== null && owner !== registry.instanceId
        ? await forwarder.forward({
            runId,
            owner,
            token,
            nonce,
            clientIp: clientIpOf(c),
            body: () => c.req.arrayBuffer(),
            signal: c.req.raw.signal,
          })
        : await answerBridgeCall(registry, runId, token, nonce, () => c.req.json())
    return c.body(res.body, res.status as 200, { "content-type": "application/json" })
  })
}

function clientIpOf(c: Context): string {
  try {
    return getClientIp(c)
  } catch {
    return "unknown"
  }
}

export const appBridgeRoutes = createAppBridgeRoutes()

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One bridge call answered in the process that owns the run: the public route
// (bridge-route.ts) calls it for its own runs, the internal listener
// (bridge-forward.ts) for a run another process received the call for. One
// function, so both answer with the same statuses and shapes.

import { rootLogger } from "~/lib/logger"
import { typedBridgeFailure } from "~/modules/apps/sandbox/bridge-rejection"
import type { RunAuthResult, RunRegistry } from "./run-registry"
import { recordBridgeTiming } from "./timings"

const log = rootLogger.child({ module: "app-bridge" })

/** A bridge call body (a ctx.db.insertMany batch, a bulk page) may be large. */
export const APP_BRIDGE_BODY_MAX_BYTES = 8 * 1024 * 1024

const AUTH_FAILURE: Record<
  Exclude<RunAuthResult["kind"], "ok">,
  { status: 401 | 403 | 409 | 410; message: string }
> = {
  unknown_run: { status: 401, message: "Unknown run" },
  bad_token: { status: 401, message: "Invalid run token" },
  expired: { status: 401, message: "Run deadline passed" },
  wrong_run: { status: 403, message: "Token belongs to another run" },
  nonce_mismatch: { status: 409, message: "Execution nonce mismatch" },
  settled: { status: 410, message: "Run settled" },
}

class DeadlineExceeded extends Error {}

/** A bridge answer, as both the public route and the owner's internal route send it. */
export interface BridgeAnswer {
  status: number
  /** JSON text. */
  body: string
}

const answer = (status: number, value: unknown): BridgeAnswer => ({
  status,
  body: JSON.stringify(value),
})

/**
 * One bridge call in the process that owns the run: authenticate (401 / 403 /
 * 409 / 410), then read the body, then run the method within the run's
 * deadline. `readBody` is called only after authentication; it returns the
 * parsed JSON or throws.
 */
export async function answerBridgeCall(
  registry: RunRegistry,
  runId: string,
  token: string | undefined,
  nonce: string | undefined,
  readBody: () => Promise<unknown>,
): Promise<BridgeAnswer> {
  const now = () => registry.now()
  const auth = registry.authenticate(runId, token, nonce)
  if (auth.kind !== "ok") {
    const f = AUTH_FAILURE[auth.kind]
    log.warn({ runId, reason: auth.kind }, "App bridge call refused")
    return answer(f.status, { error: f.message, reason: auth.kind })
  }
  const entry = auth.entry

  let body: unknown
  try {
    body = await readBody()
  } catch {
    return answer(400, { error: "Body is not JSON", reason: "bad_request" })
  }
  const b = body as { callId?: unknown; method?: unknown; args?: unknown } | null
  if (!b || typeof b !== "object" || typeof b.method !== "string" || !Array.isArray(b.args)) {
    return answer(400, { error: "Body must be {callId, method, args[]}", reason: "bad_request" })
  }
  const method = b.method
  const args: unknown[] = b.args

  // Own property of the run's bridge AND listed for the run: never a
  // prototype member (`constructor`, `__proto__`, `toString`).
  const fn =
    entry.bridgeMethods.has(method) && Object.hasOwn(entry.bridge, method)
      ? entry.bridge[method]
      : undefined
  if (typeof fn !== "function") {
    log.warn({ runId, app: entry.appName, method }, "App bridge call to an unknown method")
    return answer(404, { error: `Unknown bridge method: ${method}`, reason: "unknown_method" })
  }

  if (entry.stats.bridgeCalls >= entry.maxBridgeCalls) {
    log.warn({ runId, app: entry.appName, method }, "App run over its subrequest limit")
    return answer(429, {
      error: `Too many subrequests: this run may make ${entry.maxBridgeCalls}`,
      errorStatus: 429,
      errorCode: "subrequest_limit",
    })
  }
  entry.stats.bridgeCalls++
  const started = now()
  const remaining = Math.max(0, entry.deadline - started)
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (status: number, ok: boolean) => {
    const ms = now() - started
    entry.stats.bridgeMsTotal += ms
    recordBridgeTiming({
      kind: "call",
      runId,
      app: entry.appName,
      executor: "workers",
      method,
      ms,
      status,
      ok,
      at: started,
    })
  }

  try {
    const data = await Promise.race([
      Promise.resolve().then(() => (fn as (...a: unknown[]) => unknown)(...args)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceeded()), remaining)
      }),
    ])
    let payload: string
    try {
      payload = JSON.stringify(data === undefined ? {} : { data })
    } catch (err) {
      finish(200, false)
      const message = `Bridge result of ${method} is not serializable: ${(err as Error).message}`
      log.error({ err, runId, app: entry.appName, method }, "App bridge result not serializable")
      return answer(200, { error: message })
    }
    finish(200, true)
    return { status: 200, body: payload }
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      finish(504, false)
      log.warn({ runId, app: entry.appName, method }, "App bridge call outlived its run")
      return answer(504, { error: "Run deadline passed during the bridge call", reason: "expired" })
    }
    // As worker-pool.ts's bridge_result: the message, plus a typed
    // refusal's HTTP class and code so the handler sees the same Error.
    const typed = typedBridgeFailure(err)
    finish(200, false)
    const message = err instanceof Error ? err.message : String(err)
    return answer(200, {
      error: message,
      ...(typed
        ? {
            errorStatus: typed.status,
            ...(typed.code !== undefined ? { errorCode: typed.code } : {}),
          }
        : {}),
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

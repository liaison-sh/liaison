// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One record per /api/app-bridge call that reached a run: kept in a ring buffer
// for diagnostics and tests, and appended as one JSON line to
// LIAISON_APP_BRIDGE_TIMINGS_FILE when that is set (measurement runs).

import { appendFile } from "node:fs/promises"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "app-bridge-timings" })

export interface BridgeTiming {
  runId: string
  app: string
  executor: "workers"
  method: string
  /** Wall time of the bridge call itself, in ms. */
  ms: number
  /** HTTP status the route answered. */
  status: number
  /** False when the bridge method threw (still answered 200 with an error body). */
  ok: boolean
  at: number
}

const RING_SIZE = 1000
const ring: BridgeTiming[] = []
let fileFailed = false

export function recordBridgeTiming(t: BridgeTiming): void {
  ring.push(t)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)
  const file = env.LIAISON_APP_BRIDGE_TIMINGS_FILE
  if (!file) return
  appendFile(file, `${JSON.stringify(t)}\n`).catch((err: unknown) => {
    if (fileFailed) return
    fileFailed = true
    log.error({ err, file }, "Cannot append bridge timings; further failures are not logged")
  })
}

/** The most recent records, oldest first. */
export function recentBridgeTimings(): readonly BridgeTiming[] {
  return ring.slice()
}

export function clearBridgeTimings(): void {
  ring.length = 0
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pool gauges of the executors this process holds a bounded pool for
// (run-health.ts samples them every second):
//
//   quickjs  the QuickJS worker pool (sandbox/worker-pool.ts): busy workers
//            over its ceiling, saturated when no worker is free and a run waits
//   workers  the Workers admission's transaction-holding slots
//            (workers/admission.ts): saturated when a run waits for one
//
// The instance's own sandbox service (`workerd`) holds its pool in another
// process: its saturation shows as the queue wait its runs report.

import { getWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { workersAdmission } from "~/modules/apps/workers/admission"
import { registerRunPoolGauge } from "./run-health"

export function registerRunPoolGauges(): void {
  registerRunPoolGauge("quickjs", () => {
    let s: ReturnType<ReturnType<typeof getWorkerPool>["stats"]>
    try {
      s = getWorkerPool().stats()
    } catch {
      return null
    }
    if (s.total === 0 && s.queued === 0) return null
    return { busy: s.busy, capacity: s.maxTotal, saturated: s.free === 0 && s.queued > 0 }
  })
  registerRunPoolGauge("workers", () => {
    const s = workersAdmission.stats()
    const cap = workersAdmission.getLimits().holdsTxGlobal
    if (s.holdsTx === 0 && s.queued === 0) return { busy: 0, capacity: cap, saturated: false }
    return { busy: s.holdsTx, capacity: cap, saturated: s.queued > 0 }
  })
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// The shutdown watchdog (lib/shutdown.ts), run as a Worker so its timer fires
// on its own thread: when the main thread is wedged (a synchronous loop, a
// blocking call, an exit that never completes), the hard deadline's own timer
// never runs and the process would outlive its SIGTERM until an outside
// SIGKILL. Past the hard deadline plus its grace, this kills the process.
import { writeSync } from "node:fs"

declare const self: Worker

self.onmessage = (event: MessageEvent<{ afterMs: number }>) => {
  setTimeout(() => {
    try {
      writeSync(
        2,
        `${JSON.stringify({
          level: 60,
          time: Date.now(),
          pid: process.pid,
          module: "shutdown",
          afterMs: event.data.afterMs,
          msg: "shutdown watchdog: the process is still alive past its hard deadline (main thread wedged), killing it",
        })}\n`,
      )
    } catch {
      // Best effort: the kill below is the point.
    }
    process.kill(process.pid, "SIGKILL")
  }, event.data.afterMs)
}

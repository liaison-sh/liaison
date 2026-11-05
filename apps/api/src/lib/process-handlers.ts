// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Logger } from "pino"

let registered = false

/**
 * Pino's default destination writes asynchronously -- calling process.exit() immediately
 * after logger.fatal() can terminate the process before the write reaches the underlying
 * fd, silently dropping the fatal line the watchdog needs. flush() + a short delay (rather
 * than trusting flush()'s callback alone) gives the write a chance to land first.
 */
function flushThenExit(logger: Logger, code: number): void {
  try {
    logger.flush()
  } catch {
    // flush() is a best-effort convenience; never let it block the exit path.
  }
  setTimeout(() => process.exit(code), 50)
}

/**
 * Registers process-level uncaughtException/unhandledRejection handlers: log fatal via
 * Pino with the full error (instantly captured by the watchdog's log-stream path since
 * fatal is level 60, >= the 50-threshold it watches for), then exit non-zero so the
 * container restarts cleanly. Idempotent -- calling twice does not double-register.
 *
 * Deliberately does NOT try to keep the process alive after an uncaught exception: the
 * process is in an unknown state at that point, and letting it die + restart is safer than
 * limping on.
 */
export function registerProcessHandlers(logger: Logger): void {
  if (registered) return
  registered = true

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception")
    flushThenExit(logger, 1)
  })

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logger.fatal({ err }, "unhandled rejection")
    flushThenExit(logger, 1)
  })
  // SIGTERM / SIGINT are not handled here: lib/shutdown.ts is the one entry
  // (installShutdownSignals), and the approvals drain is one of its phases
  // (lib/shutdown-phases.ts).
}

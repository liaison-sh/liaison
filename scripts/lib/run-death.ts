// SPDX-License-Identifier: FSL-1.1-ALv2
// Why the test runner died, in the log, every time.
//
// A full run once looked like a 12 minute stall: the last line in the log was a
// suite result, then nothing, then no bun process anywhere on the box. The
// runner had been killed by its own memory guard minutes earlier; the suite
// child it had just spawned inherited the log file and kept writing to it, so
// the log looked alive while the thing that sequences suites was gone, and
// nothing ever said so.
//
// Two rules come out of that:
//   1. A runner that dies says why, as the LAST line in the log.
//   2. It takes its current child with it, so nothing keeps writing afterwards.
//
// Every way a runner can die goes through here: an uncaught exception, an
// unhandled rejection, a signal, or a plain exit.

export type DeathCause =
  | { kind: "uncaughtException"; error: unknown }
  | { kind: "unhandledRejection"; error: unknown }
  | { kind: "signal"; signal: string }
  | { kind: "memory-guard"; detail: string }

export interface RunDeathOptions {
  /** What died, for the line. e.g. "test-run.ts full". */
  label: string
  /** Defaults to console.error. */
  log?: (message: string) => void
  /** Kill the in-flight suite child, if any. Must not throw. */
  killCurrentChild?: () => void
  exit?: (code: number) => void
  /** Process-like target, for tests. */
  target?: {
    on(event: string, handler: (...args: any[]) => void): unknown
  }
}

/** The one line. No dash punctuation: this is read by people, in a log. */
export function formatDeathLine(label: string, cause: DeathCause): string {
  if (cause.kind === "memory-guard") {
    return `RUNNER DIED: ${label} was stopped by the memory guard (${cause.detail}). No further suite will start.`
  }
  if (cause.kind === "signal") {
    return `RUNNER DIED: ${label} received ${cause.signal}. No further suite will start.`
  }
  const err = cause.error
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : `${String(err)}`
  return `RUNNER DIED: ${label} hit an ${cause.kind}: ${detail}. No further suite will start.`
}

/** Exit code used when a runner dies from an exception, a rejection or a signal. */
export const RUN_DEATH_EXIT_CODE = 98

/**
 * Installs the handlers. Returns a `report(cause)` the caller can also invoke
 * directly (the memory guard path, which exits with its own code).
 */
export function installRunDeathLogging(options: RunDeathOptions): (cause: DeathCause) => void {
  const log = options.log ?? ((message: string) => console.error(message))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const target = options.target ?? process
  let reported = false

  const report = (cause: DeathCause): void => {
    if (reported) return
    reported = true
    log("")
    log(formatDeathLine(options.label, cause))
    try {
      options.killCurrentChild?.()
    } catch (err) {
      log(`RUNNER DIED: could not kill the in flight suite child: ${err}`)
    }
  }

  target.on("uncaughtException", (error: unknown) => {
    report({ kind: "uncaughtException", error })
    exit(RUN_DEATH_EXIT_CODE)
  })
  target.on("unhandledRejection", (error: unknown) => {
    report({ kind: "unhandledRejection", error })
    exit(RUN_DEATH_EXIT_CODE)
  })
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    target.on(signal, () => {
      report({ kind: "signal", signal })
      exit(RUN_DEATH_EXIT_CODE)
    })
  }
  return report
}

/**
 * Does the composite run go on after a suite finished with `code`?
 *
 * A failing suite is a RESULT, never a reason to stop: the whole point of the
 * composite run is the summary at the end, and it was stopping only because the
 * runner itself was being killed. The memory guard is the one thing that stops
 * the sequence, because the machine it needs is gone.
 */
export function shouldContinueFullRun(opts: { code: number; guardTripped: boolean }): boolean {
  return !opts.guardTripped
}

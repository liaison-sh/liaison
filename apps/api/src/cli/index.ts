// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison` CLI entry. Subcommands that need no deployment environment run
 * here, before anything reads it: `api-connector validate` checks an adapter
 * file and `app verify` an app package from a bare checkout (no JWT_SECRET, ENCRYPTION_KEY, database or
 * Redis). Every other subcommand loads `cli/main.ts`, whose imports validate
 * the environment (`~/lib/env`, exit 2 when it is invalid or missing).
 *
 * Exit codes: 0 success, 1 runtime failure (or adapter issues for
 * `validate`), 2 usage, validation or environment.
 */
// FIRST import: sets LIAISON_CLI=1 before any module evaluates the logger.
import "~/cli/cli-env"
import { runApiConnectorOffline } from "~/cli/api-connector/validate"
import { runAppOffline } from "~/cli/app/verify"

async function run(argv: string[]): Promise<number> {
  if (argv[0] === "api-connector") {
    const res = runApiConnectorOffline(argv.slice(1))
    if (res) {
      if (res.message) process.stderr.write(`${res.message}\n`)
      if (res.report !== null) process.stdout.write(`${JSON.stringify(res.report)}\n`)
      return res.exitCode
    }
  }
  if (argv[0] === "app") {
    const res = await runAppOffline(argv.slice(1))
    if (res) {
      if (res.message) process.stderr.write(`${res.message}\n`)
      if (res.report !== null) process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
      return res.exitCode
    }
  }
  const { main } = await import("~/cli/main")
  return main(argv)
}

/** How long the exit waits for stdout to drain before giving up (a reader that stopped reading). */
export const STDOUT_FLUSH_TIMEOUT_MS = 120_000

/**
 * Resolves true once every byte written to stdout so far has left the process. `process.exit` drops
 * whatever is still buffered: a large stdout through a pipe (an org transfer bundle read by a slower
 * consumer) arrived cut short, at a different place each run. Resolves false past `timeoutMs` (a
 * reader that stays open but stops reading), so the process exits instead of hanging.
 */
export function flushStdout(
  out: Pick<NodeJS.WriteStream, "end" | "once"> = process.stdout,
  timeoutMs = STDOUT_FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  // `end`'s callback runs once the stream drained (a `write("", cb)` callback does not wait in Bun).
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
    const done = (ok: boolean) => {
      clearTimeout(timer)
      resolve(ok)
    }
    out.once("error", () => done(false))
    out.end(() => done(true))
  })
}

if (import.meta.main) {
  run(process.argv.slice(2))
    .then(async (code) => {
      const drained = await flushStdout()
      if (!drained) process.stderr.write("stdout did not drain in time; output is incomplete\n")
      process.exit(drained ? code : 1)
    })
    .catch(async (e) => {
      process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
      await flushStdout()
      process.exit(1)
    })
}

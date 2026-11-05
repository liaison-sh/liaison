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

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
    process.exit(1)
  })

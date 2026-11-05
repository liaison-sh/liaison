// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Side-effect module: a SEED process must never become a BullMQ worker.
 *
 * Import it BARE and FIRST (`import "../lib/no-job-workers"`) from every seed
 * entrypoint. ES imports hoist, and the app import graph creates the
 * `app-kernel` worker at module scope (spawn-agent's placeholder
 * registration), so anything later than the first import statement is too
 * late.
 *
 * Job hosting is opt-in (infra/jobs/jobs.ts: only a process that calls
 * `hostJobWorkers()` creates workers), so a seed run is not a host to begin
 * with. This guard is the belt over those braces: `disableJobWorkers()` makes
 * the process permanently incapable of owning a worker, even if something in
 * the import graph asked it to host, so the jobs it enqueues stay in Redis for
 * the app process.
 *
 * Why the entry check and not an unconditional call: seed code is ALSO
 * imported by the running API server (the demo signup seeds through
 * `modules/demo/demo-seeder.ts`). Disabling unconditionally at module scope
 * would kill the SERVER's own workers the first time a visitor signs up. The
 * process's entry script is therefore what decides, plus an explicit env
 * override for any other one-shot invocation. The demo world is seeded through
 * the `liaison seed` CLI, whose process can never host jobs (`cli/cli-env.ts`).
 */
/**
 * Entry scripts that seed rows and nothing else. Matched against the process's
 * entry path (`Bun.main`), suffix-wise, so a checkout at any location matches.
 */
export const SEED_ENTRYPOINTS = ["scripts/seed-qa.ts"] as const

/** Env escape hatch for any other one-shot script: `LIAISON_NO_JOB_WORKERS=1`. */
export const NO_JOB_WORKERS_ENV = "LIAISON_NO_JOB_WORKERS"

/**
 * Pure decision, exported for the test: does a process started on `mainPath`
 * (with `env`) have to refuse job workers?
 */
export function shouldDisableJobWorkers(
  mainPath: string,
  env: Record<string, string | undefined> = {},
): boolean {
  const flag = env[NO_JOB_WORKERS_ENV]
  if (flag === "1" || flag === "true") return true
  const normalized = mainPath.replaceAll("\\", "/")
  return SEED_ENTRYPOINTS.some((entry) => normalized.endsWith(`/${entry}`) || normalized === entry)
}

const entryPath = typeof Bun !== "undefined" ? Bun.main : (process.argv[1] ?? "")
if (shouldDisableJobWorkers(entryPath, process.env)) {
  // Imported lazily so that merely importing this module (the guard's own
  // unit test, a lint) does not pull the api graph. Top-level await inside a
  // dependency settles BEFORE the importing module's later imports evaluate,
  // which is the ordering the guard depends on.
  const { disableJobWorkers } = await import("../../apps/api/src/infra/jobs/jobs")
  disableJobWorkers()
}

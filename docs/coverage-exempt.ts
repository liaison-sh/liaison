// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Environment variables the code reads that the reference docs deliberately
 * leave out: test, dev and harness switches, and internals a deployment never
 * sets. `scripts/docs/gen-reference.ts` drops them from the "read outside the
 * schema" table of docs/reference/env.md; every other variable read under
 * `apps/` or `bundled-apps/` is listed there (and a coverage check can require
 * it to be documented).
 *
 * Exempt a variable by name with the reason, or a whole family by prefix.
 */

/** Exact names → why they are not operator configuration. */
export const ENV_EXEMPT: Record<string, string> = {
  AGENT_STREAM_STUB: "Test-only stream stub, read only under a test environment.",
  BUN_ENV: "Read only to detect a test run (lib/env.ts isTestEnv).",
  BUN_TEST: "Set by the Bun test runner.",
  CI: "Set by CI runners; changes test and build behaviour only.",
  CONTRACT_RECORD_DEBUG: "Developer switch of the contract fixture recorder (apps/api/src/modules/apps/contract).",
  CONTRACT_RECORD_ONLY: "Developer switch of the contract fixture recorder (apps/api/src/modules/apps/contract).",
  DEV: "Vite build-time flag (import.meta.env.DEV) in the web app.",
  HOME: "Operating-system variable, passed through to sandbox workers.",
  LIAISON_CLI: "Set by the CLI entry itself (cli/cli-env.ts) to pick the synchronous logger.",
  LIAISON_DEV_APP_ROOTS: "Dev and test app discovery, ignored outside a test environment.",
  LIAISON_MODEL_PROVIDER: "Selects the scripted model provider for tests.",
  LIAISON_TEST_NS: "Test-run namespace (scripts/test-run.ts).",
  META_ADS_E2E: "End-to-end test switch.",
  PATH: "Operating-system variable, passed through to sandbox workers.",
  PROD: "Vite build-time flag (import.meta.env.PROD) in the web app.",
  PW_UPDATE_SNAPSHOTS: "Playwright snapshot update switch.",
  REDIS_PREFIX: "Redis key prefix for test-worker isolation.",
  RUN_ID: "Chaos simulator run id (read with CHAOS_DEBUG only).",
  SCHEMA_PREFIX: "Database schema prefix for test-worker isolation.",
  VITE_TEST_MODE: "Web app test-mode switch.",
  VITEST: "Set by the Vitest runner.",
  VITEST_MAX_WORKERS: "Vitest worker count.",
}

/** Name prefixes → why the whole family is exempt. */
export const ENV_EXEMPT_PREFIXES: Record<string, string> = {
  E2E_: "End-to-end test harness switches.",
  CHAOS_: "Chaos simulator harness switches.",
  CONTRACT_RECORD_: "App contract fixture recorder switches (apps/api/src/modules/apps/contract/*.recorder.test.ts), run by hand.",
  PLAYWRIGHT_: "Playwright browser test harness.",
  LIAISON_TEST_: "Test-run plumbing (namespaces, slots, ports).",
  LIAISON_E2E_: "End-to-end test harness switches.",
  LIAISON_CHAOS_: "Chaos simulator harness switches.",
  TICKETS_E2E_: "End-to-end test fakes for the tickets mail sync.",
  TEST_: "Test-run plumbing (memory budget, fixtures).",
  npm_: "Set by the package manager for scripts.",
}

/** True when `name` is exempt by name or by prefix. */
export function isEnvExempt(
  name: string,
  exact: Record<string, string> = ENV_EXEMPT,
  prefixes: Record<string, string> = ENV_EXEMPT_PREFIXES,
): boolean {
  if (Object.hasOwn(exact, name)) return true
  return Object.keys(prefixes).some((p) => name.startsWith(p))
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Suite-wide test env defaults, preloaded by bunfig.toml before any test file.
//
// Several route tests assert behaviour that only exists under a non-default
// setting: the rate limiter keys on the X-Forwarded-For client (needs a trusted
// proxy hop), the device flow admits a test client (needs DEVICE_FLOW_CLIENTS),
// the auth routes hand the refresh token back in the body (needs
// EXPOSE_REFRESH_TOKEN_IN_BODY), and GET /diag answers a bearer token (needs
// MONITOR_TOKEN). Those values used to come only from the developer's own
// `.env.test`, so a checkout with a minimal `.env.test` (a fresh worktree, a CI
// box) failed some 40 tests for no reason in the code.
//
// A per-file `process.env.X ||= …` shim is not enough: `~/lib/env` parses
// process.env ONCE, the first time any test file imports it, and several routes
// freeze their value at import. In a whole-suite run the first file wins, so a
// shim only works when its file happens to run first. A preload runs before
// every file, which is the only point that is early enough in both a single-file
// and a whole-suite run.
//
// `||=` keeps any value the surrounding environment (or `.env.test`, which
// `--env-file` loads before this runs) already provides.
process.env.TRUSTED_PROXY_HOPS ||= "1"
process.env.DEVICE_FLOW_CLIENTS ||= "*"
process.env.EXPOSE_REFRESH_TOKEN_IN_BODY ||= "true"
process.env.ALLOW_INSECURE_PUSH ||= "true"
process.env.AUTH_ENUMERATION_FLOOR_MS ||= "0"
process.env.MONITOR_TOKEN ||= "test-monitor-token-0123456789abcdef0123456789"

// Mailbox encryption: the suites are written against private (zero-access)
// mailboxes unless a case picks managed itself (mailbox-crypto/mode-switch.test.ts).
// Unset, the deployment default is `auto` and resolves to managed, so a
// checkout whose `.env.test` predates the setting would flip every suite.
process.env.MAILBOX_ENCRYPTION_DEFAULT ||= "private"

// AI provider keys: a FIXED placeholder, overwriting any real key the shell or
// `.env.test` carries. No unit test may depend on a real provider key: a test
// that passed only on a machine whose environment held one (web_search, the
// media analysis preCheck, the self-hosted credit meter) failed everywhere
// else, and a real key lets a test reach a real provider. A placeholder is a
// key for every "is a key configured?" gate and useless for anything past it,
// so a call that escapes its fake fails loudly instead of spending. A test that
// needs "no key" sets the variable to "" itself (and puts it back). The list
// is every provider key `ENV_KEY_MAP` in credit-meter.ts resolves.
//
// The live suite drives real models on purpose, and so do the e2e suites when a
// run opts in with LIAISON_E2E_LIVE_LLM=1; scripts/test-run.ts sets
// LIAISON_TEST_REAL_PROVIDER_KEYS=1 for those, and only those.
const PROVIDER_KEY_VARS = [
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "EXA_API_KEY",
] as const
if (process.env.LIAISON_TEST_REAL_PROVIDER_KEYS !== "1") {
  for (const name of PROVIDER_KEY_VARS) {
    process.env[name] = `test-placeholder-${name.toLowerCase().replaceAll("_", "-")}`
  }
}

// Job hosting is opt-in (infra/jobs/jobs.ts): only the API server and the test
// harness entrypoints call `hostJobWorkers`. A `bun test` process registers
// handlers the way the server does and expects them to run, so the suite opts
// in here, through the env rather than an import (a preload must not pull the
// app graph). jobs.ts honours it only when NODE_ENV is test and never in a
// `liaison` CLI process, which is never a host.
process.env.LIAISON_TEST_JOB_HOST ||= "1"

// A privileged-pool acquisition made while the same caller already holds a
// privileged slot (a nested acquisition) deadlocks a full pool in production,
// where it is only counted. Every test run makes it throw instead, so a code
// path that takes a second slot under the first fails its tests. A test that
// proves the counter itself sets "0" around its own case.
process.env.NESTED_PRIVILEGED_STRICT ||= "1"

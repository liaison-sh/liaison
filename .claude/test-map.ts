// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Path → suite mapping for `run-tests --files`.
 *
 * Order matters: the first glob that matches a file determines its suites.
 * Keep entries specific → general.
 */
export const TEST_MAP: { glob: string; suites: string[] }[] = [
  // Schema/migration changes ripple wide
  { glob: "apps/api/src/db/schema/**", suites: ["unit", "integration", "e2e-parallel", "demo-seed"] },
  { glob: "apps/api/src/db/migrations/**", suites: ["integration", "e2e-parallel", "guards", "demo-seed"] },

  // API code
  // Soak tests run only by hand with LIAISON_SOAK=1 (minutes each, GBs of temp
  // disk) and skip themselves otherwise: no gate runs them.
  { glob: "apps/api/src/**/*.soak.test.ts", suites: [] },
  // The elevation helpers pick their path from the transaction's login: both
  // shapes run (split in unit, one login in unsplit-logins).
  { glob: "apps/api/src/db/privileged.ts", suites: ["unit", "integration", "unsplit-logins"] },
  { glob: "apps/api/src/db/connection.ts", suites: ["unit", "integration", "unsplit-logins"] },
  { glob: "apps/api/src/db/elevation-both-logins.test.ts", suites: ["unit", "unsplit-logins"] },
  { glob: "apps/api/src/modules/sharing/service.ts", suites: ["unit", "integration", "unsplit-logins"] },
  {
    glob: "apps/api/src/modules/threads/message-acting-agent-tx.integration.test.ts",
    suites: ["unit", "unsplit-logins"],
  },
  { glob: "apps/api/src/tests/security/**", suites: ["security", "integration"] },
  { glob: "scripts/db-readonly-role*", suites: ["security"] },
  { glob: "apps/api/src/apps/database/generated/**", suites: ["unit", "integration", "e2e-parallel", "security"] },
  // The WebSocket state is one Redis implementation: its tests are unit tests
  // against real Redis, and the cell scenarios prove it across replicas.
  { glob: "apps/api/src/infra/websocket*", suites: ["unit", "cell"] },
  { glob: "apps/api/src/infra/websocket-state/**", suites: ["unit", "cell"] },
  // The cron fan-out's one-run-per-org-and-epoch is what the fanout cell scenario proves.
  { glob: "apps/api/src/modules/apps/runtime.ts", suites: ["unit", "integration", "cell"] },
  // A sub-run's nested admission past the fairness cap is what the fairness cell scenario proves.
  {
    glob: "apps/api/src/modules/agent/subruns/spawn-agent.ts",
    suites: ["unit", "integration", "cell"],
  },
  { glob: "apps/api/src/modules/**", suites: ["unit", "integration"] },
  // Event delivery across processes is what the cell scenarios prove.
  { glob: "apps/api/src/infra/events/**", suites: ["unit", "integration", "cell"] },
  { glob: "apps/api/src/infra/jobs/fanout*", suites: ["unit", "integration", "cell"] },
  { glob: "apps/api/src/infra/jobs/jobs.ts", suites: ["unit", "integration", "cell"] },
  // Fair queues across processes (the cell's slots come from the instance records).
  { glob: "apps/api/src/infra/jobs/fairness*", suites: ["unit", "integration", "cell"] },
  { glob: "apps/api/src/infra/jobs/load-synthetic*", suites: ["unit", "cell"] },
  { glob: "apps/api/src/infra/instance-registry.ts", suites: ["unit", "integration", "cell"] },
  { glob: "apps/api/src/infra/**", suites: ["unit", "integration"] },
  { glob: "apps/api/src/middleware/**", suites: ["unit", "integration"] },
  // The agent's authoring reference carries generated tables (drift test in root).
  { glob: "apps/api/src/apps/api-connector/reference/**", suites: ["root", "unit"] },
  { glob: "apps/api/src/apps/**", suites: ["unit", "integration", "e2e-parallel"] },
  { glob: "apps/api/src/services/**", suites: ["unit", "integration"] },
  { glob: "apps/api/src/cli/**", suites: ["unit"] },
  // The seed engine (demo tier today) and its test support: the demo-seed suite,
  // plus integration for the api modules it reaches.
  // The standard tier and its QA fiction are the world every Playwright and
  // api e2e lane starts from; the lane snapshot test pins it.
  { glob: "apps/api/src/seed/tiers/standard/**", suites: ["e2e-parallel", "playwright"] },
  { glob: "apps/api/src/seed/world/qa.ts", suites: ["e2e-parallel", "playwright"] },
  { glob: "apps/api/src/seed/**", suites: ["demo-seed", "integration"] },
  { glob: "apps/api/test-support/seed/**", suites: ["demo-seed"] },
  { glob: "apps/api/test-support/harness/shutdown-routes.ts", suites: ["cell"] },
  { glob: "apps/api/test-support/harness/job-effects-routes.ts", suites: ["cell"] },
  { glob: "apps/api/test-support/harness/fanout-routes.ts", suites: ["cell"] },
  { glob: "apps/api/test-support/harness/fairness-routes.ts", suites: ["cell"] },
  { glob: "apps/api/test-support/**", suites: ["unit", "integration", "e2e-parallel"] },
  // The multi-process scenarios (about 3 servers per file) run only in `cell`.
  { glob: "apps/api/src/tests/e2e/cell/**", suites: ["cell"] },
  { glob: "apps/api/src/tests/e2e/**", suites: ["e2e-parallel"] },
  // src/tests also holds the files of the two side suites (integration-extra,
  // integration-mocked) that cannot share the integration process.
  { glob: "apps/api/src/tests/**", suites: ["integration", "integration-extra", "integration-mocked"] },
  // The shutdown sequence and the listener's drain are proven across real
  // processes by the cell shutdown scenario.
  { glob: "apps/api/src/lib/shutdown*", suites: ["unit", "integration", "cell"] },
  { glob: "apps/api/src/lib/server.ts", suites: ["unit", "integration", "cell"] },
  { glob: "apps/api/src/lib/effect-*", suites: ["unit", "integration", "cell"] },
  { glob: "apps/api/src/lib/load-harness*", suites: ["unit", "integration", "cell"] },
  { glob: "apps/api/src/lib/**", suites: ["unit", "integration"] },
  { glob: "apps/api/src/db/**", suites: ["unit", "integration"] },
  { glob: "apps/api/src/*.ts", suites: ["unit", "integration", "e2e-parallel"] },

  // Web code
  // A testid a tour names can be renamed here: the tour anchor check is in guards.
  { glob: "apps/web/src/modules/**", suites: ["web-unit", "playwright", "api-guards", "guards"] },
  { glob: "apps/web/src/framework/**", suites: ["web-unit", "playwright"] },
  // The isolated-app frame runtime (an app UI in its own frame): its own tests
  // are web-unit, and the bundled-app UIs that run in it are playwright.
  { glob: "apps/web/src/app-frame/**", suites: ["web-unit", "playwright"] },
  { glob: "apps/web/src/ui/**", suites: ["web-unit", "playwright"] },
  { glob: "apps/web/src/tests/e2e/**", suites: ["playwright"] },
  { glob: "apps/web/src/lib/**", suites: ["web-unit", "playwright"] },
  // The socket and other shared reactive primitives: the blip and live-order
  // scenarios (playwright) drive them end to end.
  { glob: "apps/web/src/primitives/**", suites: ["web-unit", "playwright"] },
  // The root component and its routes: App.test and reserved-web-routes (web-unit),
  // the testids the tours name (guards), the whole shell in the browser (playwright).
  { glob: "apps/web/src/App.tsx", suites: ["web-unit", "guards", "playwright"] },
  // Vite's config: the zod alias zod-jitless.test reads (web-unit), the mobile
  // build's stand-in alias and plugin checks (mobile), the served bundle (playwright).
  { glob: "apps/web/vite.config.ts", suites: ["web-unit", "mobile", "playwright"] },

  // Shared packages. The SDK's manifest format and the requiredScopes guards
  // (in api-guards) must move together.
  { glob: "packages/app-sdk/**", suites: ["workspace-packages", "api-guards"] },
  // The host handle bundled-app UIs import: its own tests (workspace-packages),
  // the frozen bundles that embed it (bundled-freeze), the web host that
  // implements it (web-unit) and the app UIs in the browser (playwright).
  {
    glob: "packages/host-sdk/**",
    suites: ["workspace-packages", "bundled-freeze", "web-unit", "playwright"],
  },
  // Tour definitions: their anchors are checked against the web source (guards).
  { glob: "packages/shared/src/tours/**", suites: ["unit", "web-unit", "integration", "guards"] },
  { glob: "packages/shared/**", suites: ["shared", "unit", "web-unit", "integration"] },
  // The schema and the role registry also feed docs/api-connector.md's generated tables.
  {
    glob: "packages/api-connector-core/adapter.schema.json",
    suites: ["workspace-packages", "unit", "integration", "root"],
  },
  {
    glob: "packages/api-connector-core/src/schema.ts",
    suites: ["workspace-packages", "unit", "integration", "root"],
  },
  { glob: "packages/api-connector-core/**", suites: ["workspace-packages", "unit", "integration"] },
  {
    glob: "packages/control-plane-contract/**",
    suites: ["workspace-packages", "unit", "integration"],
  },
  { glob: "packages/db-core/**", suites: ["workspace-packages", "unit", "integration"] },
  { glob: "packages/test-helpers/src/{role-processes,cell-clients}*", suites: ["cell"] },
  // The lane attach handle (TestWorld) and the standard world every lane reads.
  {
    glob: "packages/test-helpers/src/{test-world,test-world-threads,rng,standard-world}*",
    suites: ["worker-env", "integration", "e2e-parallel", "playwright"],
  },
  { glob: "packages/test-helpers/**", suites: ["worker-env", "integration", "e2e-parallel"] },

  // Bundled apps. Each app's own bun:test files are discovered by NOTHING but
  // that app's `bundled-<name>` suite in scripts/test-run.ts: the workspace
  // globs behind "unit"/"integration" cover only apps/* and packages/*, so
  // routing a bundled-app edit to those suites runs none of its tests and
  // reports green. Route each app to its OWN suite, plus "bundled-freeze" for
  // the ship-artifact oracles and "e2e-parallel" for the cross-app paths. The
  // round-trip + installAppFromTarball + post-install kernel integration tests
  // live in apps/api/src/apps/**, which those entries already cover.
  // An app's manifest and schema shape the rows the demo seed snapshot pins.
  { glob: "bundled-apps/ads/**", suites: ["api-guards", "bundled-ads", "bundled-freeze", "e2e-parallel", "demo-seed"] },
  { glob: "bundled-apps/boxtal/**", suites: ["api-guards", "bundled-boxtal", "bundled-boxtal-ui", "bundled-freeze", "e2e-parallel", "demo-seed"] },
  { glob: "bundled-apps/calls/**", suites: ["api-guards", "bundled-calls", "bundled-freeze", "e2e-parallel", "demo-seed"] },
  { glob: "bundled-apps/invoicing/**", suites: ["api-guards", "bundled-invoicing", "bundled-freeze", "e2e-parallel", "demo-seed"] },
  { glob: "bundled-apps/monitoring/**", suites: ["api-guards", "bundled-monitoring", "bundled-monitoring-ui", "bundled-freeze", "e2e-parallel", "demo-seed"] },
  { glob: "bundled-apps/pennylane/**", suites: ["api-guards", "bundled-pennylane", "bundled-freeze", "e2e-parallel", "demo-seed"] },
  { glob: "bundled-apps/shopify/**", suites: ["api-guards", "bundled-shopify", "bundled-freeze", "e2e-parallel", "demo-seed"] },
  { glob: "bundled-apps/social/**", suites: ["api-guards", "bundled-social", "bundled-social-ui", "bundled-freeze", "e2e-parallel", "demo-seed"] },
  { glob: "bundled-apps/*/**", suites: ["api-guards", "bundled-freeze", "e2e-parallel", "demo-seed"] },

  // The repo-root guards: each one fails a deploy or a shipped string rather
  // than a feature, and each is cheap, so a targeted run that touches them
  // runs the suite that holds them.
  { glob: "scripts/dockerfile-workspaces*", suites: ["guards"] },
  { glob: "scripts/dockerfile-cli-shim*", suites: ["guards"] },
  { glob: "scripts/check-desktop-no-node*", suites: ["guards"] },
  { glob: "scripts/lint-copy-dashes.repo*", suites: ["guards"] },
  { glob: "scripts/test-run.suites*", suites: ["guards"] },
  { glob: "scripts/test-file-names*", suites: ["guards"] },
  { glob: "scripts/check-workflow-hardening*", suites: ["guards"] },
  { glob: "scripts/tour-anchors-check*", suites: ["guards"] },
  { glob: "scripts/check-migration-safety*", suites: ["guards"] },
  { glob: "scripts/check-bundled-app-version*", suites: ["guards"] },
  { glob: "scripts/migration-safety-baseline.json", suites: ["guards"] },
  { glob: "scripts/__fixtures__/migration-safety/**", suites: ["guards"] },
  { glob: ".github/workflows/**", suites: ["guards"] },
  { glob: "apps/api/Dockerfile", suites: ["guards"] },

  // Desktop shell, demo seeder, and the compose files the root suite validates.
  { glob: "apps/desktop/**", suites: ["desktop", "desktop-ui"] },
  { glob: "apps/mobile/**", suites: ["mobile"] },
  // One-off api scripts (bake-offs, probes) run by hand; the guards scan them.
  { glob: "apps/api/scripts/**", suites: ["api-guards"] },
  // The French table feeds the fr dictionaries; its parity test is in shared.
  { glob: "scripts/i18n-*.ts", suites: ["shared"] },
  { glob: "docker-compose.yml", suites: ["root"] },
  { glob: "deploy/**", suites: ["root"] },
  // The deploy and load-test tooling and their repo-root tests (compose file
  // shape, shutdown budgets, image pins, the load-test runner, deploy counters).
  { glob: "scripts/compose-*.test.ts", suites: ["root"] },
  // The secret and address gates: the hooks, their config and their test.
  { glob: "scripts/git-hooks/**", suites: ["root"] },
  { glob: "scripts/git-hooks.test.ts", suites: ["root"] },
  { glob: ".gitleaks.toml", suites: ["root"] },
  { glob: "scripts/load-test*.ts", suites: ["root"] },
  { glob: "scripts/lib/load-seed.ts", suites: ["root"] },
  // The k6 profiles: their client logic is pinned by scripts/lib/load-harness-client.test.ts.
  { glob: "qa/load/**", suites: ["root"] },
  { glob: "scripts/deploy-counters.ts", suites: ["root"] },
  // Ignore rules change what git tracks, never what a test runs.
  { glob: ".gitignore", suites: [] },

  // Scripts
  { glob: "scripts/check-bundled-app-purity*", suites: ["unit"] },
  // The freezer: the bundled-app build round-trips freeze through it.
  { glob: "scripts/freeze-app*", suites: ["bundled-freeze"] },
  // The test runner and its helpers: the runner's own unit tests (root) and
  // the suite-routing guards that read scripts/test-run.ts (guards).
  { glob: "scripts/test-run*.ts", suites: ["root", "guards"] },
  { glob: "scripts/test-gate*.ts", suites: ["root"] },
  { glob: "scripts/test-unit-parallel.ts", suites: ["root"] },
  { glob: "scripts/test-e2e-parallel.ts", suites: ["root"] },
  { glob: "scripts/with-test-lock*.ts", suites: ["root"] },
  { glob: "scripts/slots.ts", suites: ["root"] },
  { glob: "scripts/lib/**", suites: ["root"] },
  { glob: ".claude/test-map.ts", suites: ["root"] },
  // The docs map feeds check-docs (its test is in root) and ci-scope (guards).
  { glob: ".claude/docs-map.ts", suites: ["root", "guards"] },
  { glob: "scripts/backup-secrets*", suites: ["root"] },
  // Read only by CI's gitleaks job (.github/workflows/codeql.yml); no test reads it.
  { glob: ".gitleaks.toml", suites: [] },
  // A lockfile change can move any dependency of any workspace: every core
  // suite, plus the frozen bundled-app artifacts that embed their dependencies.
  {
    glob: "bun.lock",
    suites: [
      "unit",
      "integration",
      "integration-extra",
      "integration-mocked",
      "e2e-parallel",
      "security",
      "web-unit",
      "playwright",
      "workspace-packages",
      "shared",
      "api-guards",
      "guards",
      "root",
      "bundled-freeze",
    ],
  },
  // The api-connector doc generator, its drift test, and the doc + skill it checks.
  { glob: "scripts/api-connector-schema-doc*", suites: ["root"] },
  { glob: "docs/api-connector.md", suites: ["root"] },
  { glob: ".claude/skills/api-connector-authoring/**", suites: ["root"] },
]

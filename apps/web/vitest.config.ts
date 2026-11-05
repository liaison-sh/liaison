// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolve } from "node:path"
import solid from "vite-plugin-solid"
import { defineConfig } from "vitest/config"

// Worker ceiling from the computed memory budget (scripts/lib/mem-budget.ts),
// injected as VITEST_MAX_WORKERS by the runner. Unset, vitest defaults to
// cpus-1 parallel jsdom workers, which on a busy 16GB host is how a web-unit
// run got the whole machine OOM killed. A ceiling of 1 also turns off file
// parallelism, because one worker still forks per file otherwise.
const maxWorkersEnv = Number(process.env.VITEST_MAX_WORKERS)
const maxWorkers =
  Number.isFinite(maxWorkersEnv) && maxWorkersEnv > 0 ? Math.floor(maxWorkersEnv) : undefined

export default defineConfig({
  // No hot refresh under a test runner: nothing reloads, and on Windows the
  // virtual `@solid-refresh` module it injects is a path node refuses
  // ("filename must be a file URL"), which failed every component test there.
  plugins: [solid({ hot: false })],
  resolve: {
    alias: { "~": resolve(__dirname, "src") },
    // As in vite.config.ts: the editor parses with the app's own marked.
    dedupe: ["marked"],
  },
  test: {
    environment: "jsdom",
    ...(maxWorkers !== undefined
      ? { maxWorkers, ...(maxWorkers === 1 ? { fileParallelism: false } : {}) }
      : {}),
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    transformMode: { web: [/\.[jt]sx?$/] },
    // Playwright owns `*.scenario.test.ts` (its own testMatch) and the
    // Shopify e2e fixtures use `bun:test`, so both stay out of vitest's
    // collection; a plain `*.test.ts` elsewhere under `tests/e2e` (e.g.
    // phone-helpers.test.ts) is a real vitest unit test and must run here.
    exclude: ["**/e2e/**/*.scenario.test.ts", "**/e2e/shopify/**", "**/node_modules/**"],
    server: { deps: { inline: ["zod"] } },
    // 5s default trips legitimate Solid+Kobalte renders under parallel-worker
    // CPU pressure (102 test files × parallel jsdom envs). 30s gives the
    // first-import compile cost and Tooltip portal init enough headroom
    // without hiding real hangs.
    testTimeout: 30000,
    // Two restorable-state tests (auth-store online retry, OAuthComplete
    // exchange + navigate) intermittently time out their inner `vi.waitFor`
    // when 100+ files run in parallel jsdom workers. Each passes deterministically
    // in isolation. One retry contains the flake without masking real bugs.
    retry: 1,
  },
})

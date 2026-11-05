// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The overlay's components are Solid JSX, and `bun test` cannot render them:
// it has no JSX transform for Solid's compiler. So the component half runs
// under vitest + jsdom + @solidjs/testing-library, exactly as apps/web does,
// and the pure modules (the sidecar protocol, the shell scripts) stay on
// `bun test`. Both are wired into the root desktop suite.
import { resolve } from "node:path"
import solid from "vite-plugin-solid"
import { defineConfig } from "vitest/config"

// Worker ceiling from the computed memory budget (scripts/lib/mem-budget.ts),
// injected as VITEST_MAX_WORKERS by the runner, same as apps/web.
const maxWorkersEnv = Number(process.env.VITEST_MAX_WORKERS)
const maxWorkers =
  Number.isFinite(maxWorkersEnv) && maxWorkersEnv > 0 ? Math.floor(maxWorkersEnv) : undefined

export default defineConfig({
  // No hot refresh under a test runner: nothing reloads, and on Windows the
  // virtual `@solid-refresh` module it injects is a path node refuses
  // ("filename must be a file URL"), which failed every component test there.
  plugins: [solid({ hot: false })],
  resolve: {
    alias: {
      "~": resolve(import.meta.dirname, "src"),
      // apps/web declares no `exports` map, so the two gating helpers this
      // overlay must NOT re-implement are reached by workspace path. The same
      // three aliases exist in tsconfig.json and vite.config.ts: typecheck,
      // test and bundle all have to resolve them identically.
      "@liaison/web": resolve(import.meta.dirname, "../web/src"),
      "@liaison/shared/": `${resolve(import.meta.dirname, "../../packages/shared/src")}/`,
    },
  },
  test: {
    environment: "jsdom",
    ...(maxWorkers !== undefined
      ? { maxWorkers, ...(maxWorkers === 1 ? { fileParallelism: false } : {}) }
      : {}),
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // src/tests/e2e is the live scenario's home: bun files driving the real
    // compiled sidecar against a real server, run by the `desktop` suite.
    exclude: ["**/node_modules/**", "**/dist/**", "src/tests/**"],
    testTimeout: 30000,
    // As apps/web: zod 4 is ESM-only, and under the test runner its named
    // `z` export reads undefined unless vitest inlines it. The page imports
    // packages/shared's session protocol (P1-T39), which builds on zod.
    server: { deps: { inline: ["zod"] } },
  },
})

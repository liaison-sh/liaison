// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kit's DOM tests. `bun test` has no Solid JSX transform, so a component
// test here runs under vitest + jsdom exactly as apps/web's and apps/desktop's
// do; the package's pure modules (ctx-iframe) stay on `bun:test` in the
// `workspace-packages` suite. Both halves run in CI, because a half no suite
// runs is decoration.
//
// The include pattern is `*.vitest.tsx`, NOT `*.test.tsx`: the
// `workspace-packages` bun suite points `bun test` at this whole directory and
// would otherwise discover a Solid component test it cannot transform.
import solid from "vite-plugin-solid"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.vitest.tsx"],
    transformMode: { web: [/\.[jt]sx?$/] },
    testTimeout: 30000,
  },
})

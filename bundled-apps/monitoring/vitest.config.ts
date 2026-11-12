// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DOM tests for the monitoring UI (`*.vitest.tsx`). `bun test` has no Solid JSX
// transform, so these render under vitest + jsdom. The toolchain (vitest,
// vite-plugin-solid, jsdom, @solidjs/testing-library) is the one
// packages/app-ui already installs for its own kit tests (same setup as
// bundled-apps/social). Solid resolves to ONE copy (this app's, else the
// workspace root's) so the renderer and the components share one runtime.
//
// Run: packages/app-ui/node_modules/.bin/vitest run --config bundled-apps/monitoring/vitest.config.ts
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const toolchain = resolve(here, "../../packages/app-ui/node_modules")
const { default: solid } = await import(resolve(toolchain, "vite-plugin-solid/dist/esm/index.mjs"))
const solidRoot = [
  resolve(here, "node_modules/solid-js"),
  resolve(here, "../../node_modules/solid-js"),
].find((p) => existsSync(p)) as string

export default {
  root: here,
  plugins: [solid({ hot: false })],
  resolve: {
    alias: [
      { find: /^solid-js\/web$/, replacement: resolve(solidRoot, "web/dist/dev.js") },
      { find: /^solid-js\/store$/, replacement: resolve(solidRoot, "store/dist/dev.js") },
      { find: /^solid-js$/, replacement: resolve(solidRoot, "dist/dev.js") },
      {
        find: "@solidjs/testing-library",
        replacement: resolve(toolchain, "@solidjs/testing-library/dist/index.js"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.vitest.tsx"],
    // Named here so vite-plugin-solid does not add its own bare
    // "@testing-library/jest-dom/vitest", which cannot resolve from this app.
    setupFiles: [resolve(toolchain, "@testing-library/jest-dom/dist/vitest.mjs")],
    transformMode: { web: [/\.[jt]sx?$/] },
    testTimeout: 30000,
  },
}

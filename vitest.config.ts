// SPDX-License-Identifier: FSL-1.1-ALv2
// Root vitest config. The only vitest test suite in this monorepo lives in
// `apps/web`; everything else (`apps/api`, `packages/*`, `scripts/*`) uses
// `bun:test`. Without this file, a vitest invocation from the repo root walks
// the entire tree, drags in ~650 bun-only `*.test.ts` files that fail to
// import `bun:test`, and degrades the run so the real web tests never execute
// (they report as "pending"). Scoping to the `apps/web` project makes any
// root-level vitest run (including Strobe's auto-detected adapter) collect and
// run exactly the web suite, using `apps/web/vitest.config.ts`.
//
// NOTE: `vitest` is not hoisted to the repo root (it lives in
// `apps/web/node_modules`), so this file must NOT `import` from
// `vitest/config`. Vitest accepts a plain default-exported config object; the
// `apps/web` project resolves its own vitest/plugins from `apps/web`.
export default {
  test: {
    projects: ["apps/web"],
  },
}

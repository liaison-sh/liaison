// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun test` preload for bundled apps whose tests import Solid `.tsx` modules.
//
// A bundled app's tsconfig says `"jsx": "preserve", "jsxImportSource": "solid-js"`:
// the real UI build compiles JSX with babel-preset-solid (scripts/freeze-app.ts),
// and the rendered-screen tests run under vitest + vite-plugin-solid. `bun test`
// has no Solid compiler, so it applies its own JSX transform to every `.tsx` it
// loads, including the components a pure-logic test imports for their helpers.
//
// Bun 1.3 treated `preserve` as the classic transform (`React.createElement`,
// no import), so a test that only imported a component module loaded fine.
// Bun 1.4 treats it as the automatic development transform, which imports
// `jsxDEV` from `solid-js/jsx-dev-runtime`. Solid publishes that subpath only
// as an alias of `dist/solid.js`, which exports no `jsxDEV`, so every such test
// file failed at link time ("Export named 'jsxDEV' not found") before a single
// test ran.
//
// This preload compiles every first-party `.tsx` that `bun test` loads with
// the automatic transform pointed at Solid's own hyperscript JSX runtime
// (`solid-js/h/jsx-runtime`, which does export `jsx`, `jsxs`, `jsxDEV` and
// `Fragment`), resolved from the importing app's own copy of solid-js. The
// tsconfig's `jsxImportSource` cannot be redirected instead: it outranks
// bunfig's, and a plugin onResolve never sees the transpiler-injected import.
// Unused imports are trimmed as TypeScript (and bun's own loader) would.
//
// First-party means outside node_modules, or a workspace package (`@liaison/*`)
// reached through one: scripts/build-bundled-app.sh installs an app's `file:`
// dependencies as copies under bundled-apps/<app>/node_modules/@liaison/, and
// their Solid components need the same transform. Third-party packages
// (anything else under node_modules, including inside an @liaison copy) keep
// bun's own loader.
// Nothing else changes: typechecking, the production build and the vitest
// suites never read this file.
//
// Wire it from the app's bunfig.toml:
//   [test]
//   preload = ["../../scripts/lib/bun-solid-jsx-preload.ts"]
import { plugin } from "bun"

const transpiler = new Bun.Transpiler({
  loader: "tsx",
  autoImportJSX: true,
  trimUnusedImports: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "solid-js/h" } },
})

plugin({
  name: "solid-jsx-runtime-for-bun-test",
  setup(build) {
    build.onLoad({ filter: /^(?!.*\/node_modules\/(?!@liaison\/)).*\.tsx$/ }, async (args) => ({
      contents: transpiler.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})

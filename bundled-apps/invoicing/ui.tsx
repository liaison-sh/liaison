// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 — Frontend UI bundle entrypoint.
//
// `liaison/scripts/freeze-app.ts` looks for `<appDir>/ui.tsx` and bundles
// it as the app's frontend `ui.js`. Every component name the manifest
// references (`views.*.component`, `slots.*.component`) must be re-exported
// here.
export * from "./src/ui/index"

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 — shared Playwright fixtures + constants for the Boxtal E2E
// scenarios. Extends the base test (re-exports `test`/`expect`). Boxtal
// **depends on Invoicing** (invoice → shipment dogfood), so several scenarios
// install both bundles.
//
// The Boxtal v1 (cotation, XML) + v3 (orders, JSON) APIs are mocked at the
// sandbox-fetch bridge inside the spawned server (see
// `apps/api/test-support/harness/boxtal-mock-fetch.ts`), driven per-scenario by
// the `/api/_test/boxtal/mock/*` control routes (helpers/mock-boxtal.ts).

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { bundledAppTarball } from "../bundled-app-tarball"
import { test as base } from "../fixtures/test"

// __dirname = liaison/apps/web/src/tests/e2e/boxtal
// Walk up 6 levels: boxtal → e2e → tests → src → web → apps → liaison
export const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
export const BOXTAL_BUNDLE = bundledAppTarball(LIAISON_ROOT, "boxtal")
export const BOXTAL_MANIFEST = resolve(LIAISON_ROOT, "bundled-apps/boxtal/app.manifest.json")
export const INVOICING_BUNDLE = bundledAppTarball(LIAISON_ROOT, "invoicing")

/** Assert the frozen bundle exists before any scenario tries to install it. */
export function assertBoxtalBundle(): void {
  if (!existsSync(BOXTAL_BUNDLE)) {
    throw new Error(
      `Boxtal bundle missing at ${BOXTAL_BUNDLE} — run \`bash scripts/build-bundled-app.sh boxtal --skip-sign\``,
    )
  }
}

export const test = base
export { expect } from "../fixtures/test"

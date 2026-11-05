// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B10 — shared Playwright fixtures + constants for the Social "Ground Control"
// E2E. Extends the base test (re-exports `test`/`expect`). The social app is
// registered FROM SOURCE by the `_test` install route (never frozen/installed),
// and its platform fetch (Facebook Graph) is mocked at the sandbox-fetch bridge
// inside the spawned server, composed at boot with the Boxtal mock.
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { test as base } from "../../fixtures/test"

// __dirname = liaison/apps/web/src/tests/e2e/social-ground-control/helpers
// Walk up 7 levels: helpers → social-ground-control → e2e → tests → src → web → apps → liaison
export const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..", "..")
export const SOCIAL_MANIFEST = resolve(LIAISON_ROOT, "bundled-apps/social/app.manifest.json")

export function assertSocialBundle(): void {
  if (!existsSync(SOCIAL_MANIFEST)) {
    throw new Error(`Social manifest missing at ${SOCIAL_MANIFEST}`)
  }
}

export const test = base
export { expect } from "../../fixtures/test"

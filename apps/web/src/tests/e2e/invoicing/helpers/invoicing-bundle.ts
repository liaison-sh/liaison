// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Resolves the invoicing app's frozen `.liaisonapp` tarball by reading the
// version from the app manifest, so a version bump never strands the e2e
// suite pointing at a deleted tarball (bit the 0.1.0 → 0.2.0 bump).
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// __dirname = liaison/apps/web/src/tests/e2e/invoicing/helpers
export const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..", "..")

export const INVOICING_MANIFEST = resolve(LIAISON_ROOT, "bundled-apps/invoicing/app.manifest.json")

const manifestVersion = (
  JSON.parse(readFileSync(INVOICING_MANIFEST, "utf8")) as { version: string }
).version

export const INVOICING_BUNDLE = resolve(
  LIAISON_ROOT,
  `bundled-apps/invoicing/dist/invoicing-${manifestVersion}.liaisonapp`,
)

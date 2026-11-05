// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Resolve a bundled app's frozen `.liaisonapp` tarball path by reading the
// version from its manifest. The freeze tool names tarballs
// `<app>-<manifest version>.liaisonapp`, so every hardcoded
// `<app>-0.1.0.liaisonapp` literal strands its suite the moment the app is
// bumped (bit the shopify 0.1.6+ bumps and the invoicing 0.1.0 → 0.2.0 bump;
// `invoicing/helpers/invoicing-bundle.ts` is the single-app
// predecessor of this generic helper).
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export function bundledAppTarball(liaisonRoot: string, appName: string): string {
  const manifestPath = resolve(liaisonRoot, "bundled-apps", appName, "app.manifest.json")
  const { version } = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }
  return resolve(liaisonRoot, "bundled-apps", appName, "dist", `${appName}-${version}.liaisonapp`)
}

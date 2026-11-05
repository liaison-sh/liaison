// SPDX-License-Identifier: FSL-1.1-ALv2
import testManifestJson from "./app.manifest.json"

export const testAppManifest = {
  ...testManifestJson,
  _format: "manifest" as const,
  _bundlePath: new URL("./handler-bundle.ts", import.meta.url).pathname,
}

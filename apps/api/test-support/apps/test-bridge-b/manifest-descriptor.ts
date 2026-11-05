// SPDX-License-Identifier: FSL-1.1-ALv2
import testBridgeBManifestJson from "./app.manifest.json"

export const testBridgeBManifest = {
  ...testBridgeBManifestJson,
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
}

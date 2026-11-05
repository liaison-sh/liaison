// SPDX-License-Identifier: FSL-1.1-ALv2
import testBridgeAManifestJson from "./app.manifest.json"

export const testBridgeAManifest = {
  ...testBridgeAManifestJson,
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
}

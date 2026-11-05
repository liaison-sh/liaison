// SPDX-License-Identifier: FSL-1.1-ALv2
import manifest from "./app.manifest.json"

export const __APP_CLASS__AppManifest = {
  ...manifest,
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
}

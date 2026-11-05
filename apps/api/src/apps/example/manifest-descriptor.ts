// SPDX-License-Identifier: FSL-1.1-ALv2
// Reference app descriptor. Task 1 ships a minimal-but-valid placeholder so the
// auto-discovery loader registers `example` end-to-end; Task 11 fleshes out the
// schema, tools, events, jobs, and connections this descriptor will carry.
import exampleManifestJson from "./app.manifest.json"

export const exampleAppManifest = {
  ...exampleManifestJson,
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
}

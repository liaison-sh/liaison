// SPDX-License-Identifier: FSL-1.1-ALv2
import projectsManifestJson from "./app.manifest.json"

export const projectsAppManifest = {
  ...projectsManifestJson,
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
}

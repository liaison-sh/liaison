// SPDX-License-Identifier: FSL-1.1-ALv2
import contactsManifestJson from "./app.manifest.json"

export const contactsAppManifest = {
  ...contactsManifestJson,
  _format: "manifest" as const,
}

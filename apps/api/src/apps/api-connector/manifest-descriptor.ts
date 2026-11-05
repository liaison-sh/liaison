// SPDX-License-Identifier: FSL-1.1-ALv2

import apiConnectorManifestJson from "./app.manifest.json"
import { registerAdapterAuthoringTools } from "./authoring-tools"
import { createApiConnectorBridgeExtension } from "./bridge"

export const apiConnectorAppManifest = {
  ...apiConnectorManifestJson,
  _format: "manifest" as const,
  // Headless connector: the agent tools are sandboxed delegators in this
  // bundle; the adapter, the credentials and every HTTP call stay host-side
  // in the `connector_*` bridge methods. Admin routes live in the kernel
  // module `modules/api-connector/routes.ts` (mounted at /api/api-connector).
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
  _bridgeExtension: createApiConnectorBridgeExtension,
  // The adapter save and restore: host tools decided by api-connector:admin
  // (a manifest tool's approvals are always decided by <app>:approve).
  _registerHostTools: registerAdapterAuthoringTools,
}

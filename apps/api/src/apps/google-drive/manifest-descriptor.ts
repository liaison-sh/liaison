// SPDX-License-Identifier: FSL-1.1-ALv2

import googleDriveManifestJson from "./app.manifest.json"
import { createGoogleDriveBridgeExtension } from "./bridge"

export const googleDriveAppManifest = {
  ...googleDriveManifestJson,
  _format: "manifest" as const,
  // Drive is a headless connector — its agent tools (`search`, `import`) are
  // sandboxed handlers in this bundle that delegate to host `drive_*` bridge
  // methods. Same wiring as any manifest app with a tool surface.
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
  // Host-side `drive_*` bridge methods, merged into this app's sandbox bridge
  // only. Keeps the Drive REST plumbing with the app instead of the kernel.
  _bridgeExtension: createGoogleDriveBridgeExtension,
  // No `_oauthClientResolvers`: Drive's client is the workspace's own
  // (`oauth_providers` row `google-drive:drive`), else the instance's
  // (GOOGLE_DRIVE_OAUTH_*), both through modules/apps/connections/oauth-client.ts.
}

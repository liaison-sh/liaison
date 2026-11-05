// SPDX-License-Identifier: FSL-1.1-ALv2

import databaseManifestJson from "./app.manifest.json"
import { createDatabaseBridgeExtension } from "./bridge"

export const databaseAppManifest = {
  ...databaseManifestJson,
  _format: "manifest" as const,
  // Headless connector — its agent tools are sandboxed handlers in this
  // bundle that delegate to host `db_*` bridge methods. Same wiring as
  // gitlab/google-drive.
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
  // Host-side `db_*` bridge methods — credential resolution + transport
  // execution happen here with host privileges, never in the QuickJS sandbox.
  _bridgeExtension: createDatabaseBridgeExtension,
  // No OAuth client resolvers — database uses a credentials-type connection
  // (DSN or gate URL+token).
}

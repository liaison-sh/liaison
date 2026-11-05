// SPDX-License-Identifier: FSL-1.1-ALv2

import gitlabManifestJson from "./app.manifest.json"
import { createGitlabBridgeExtension } from "./bridge"

export const gitlabAppManifest = {
  ...gitlabManifestJson,
  _format: "manifest" as const,
  // GitLab is a headless connector — its agent tools (13 read primitives) are
  // sandboxed handlers in this bundle that delegate to host `gitlab_*` bridge
  // methods. Same wiring as Drive.
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
  // Host-side `gitlab_*` bridge methods — credential resolution + REST calls
  // happen here with host privileges, never in the QuickJS sandbox.
  _bridgeExtension: createGitlabBridgeExtension,
  // No OAuth client resolvers — GitLab uses credentials-type connection (PAT).
}

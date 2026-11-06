// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test fixture, run as its own process by teardown-boundary.test.ts: the worker
// that drains the outbox is not the api process that took the disconnect, so it
// shares no memory with it. It knows only the committed event's connection id.

import { connectionConfigRegistry, initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { revokeOnDisconnectEvent } from "~/modules/apps/connections/revoke"

const [orgId, appName, connectionName, connectionId, revocationUrl, watchStopUrl] =
  process.argv.slice(2) as [string, string, string, string, string, string]

initializedOrgRuntimes.add(orgId)
connectionConfigRegistry.set([orgId, appName, connectionName], {
  type: "oauth2",
  allowedDomains: [],
  tokenUrl: "https://oauth2.example.test/token",
  revocationUrl,
  watchStopUrl,
})
await revokeOnDisconnectEvent({
  app: "kernel",
  entity: "connected_account",
  action: "disconnect",
  entityId: connectionId,
})
process.exit(0)

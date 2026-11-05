// SPDX-License-Identifier: FSL-1.1-ALv2
// The scope that administers one app connection for the organization: connect
// it org-owned, share a personal account with the organization, disconnect or
// reconcile an org-owned account. A manifest names it per connection
// (`connections.<name>.adminScope`, one of the app's own scopes); without one it
// is `<app>:accounts:admin`. The connections routes check it and the
// connections listing serves it, so the settings page offers those actions to
// exactly the people the server lets take them.
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { connectionAdminScopeOf } from "~/modules/apps/settings-schema-from-manifest"

export function connectionAdminScope(
  orgId: string,
  appName: string,
  connectionName: string,
): string {
  return connectionAdminScopeOf(
    appName,
    connectionConfigRegistry.get([orgId, appName, connectionName]),
  )
}

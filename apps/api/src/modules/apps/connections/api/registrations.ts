// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the platform-held API connections register with the rest of the host,
// once, on import (the `ctx.api` bridge methods import this module):
//   - the generic credentials route's check for an API connection's account:
//     its adapter must exist, and the fields must be exactly those of its auth
//     type (the oauth2 token URL is the adapter's, never a credential);
//   - the demo box's in-process answerer for a demo org's fixture connection.

import { AUTH_CREDENTIAL_FIELDS } from "@liaison/api-connector-core"
import { registerMultiInstanceCredentialResolver } from "~/modules/apps/connections/service"
import { maybeDemoApiConnectorResponse } from "~/modules/demo/api-connector/responder"
import { assertDemoEgressAllowed, isDemoRestriction } from "~/modules/demo/demo-egress"
import { invalidateConnectionCaches } from "./cache"
import { apiConnFor } from "./declarations"
import { getAdapterRow } from "./store"
import { registerDemoApiConnectorResponder } from "./transport"

/** A demo org's connections are pre-configured: changing them is refused, as JSON text. */
export async function demoChangeRefusal(orgId: string): Promise<string | null> {
  try {
    await assertDemoEgressAllowed(orgId, "api_connector_change")
    return null
  } catch (err) {
    if (isDemoRestriction(err)) {
      return JSON.stringify({
        error: {
          code: "demo_restricted",
          message: err instanceof Error ? err.message : String(err),
          status: 403,
        },
      })
    }
    throw err
  }
}

// Any app's API connection (declarations.ts): its credentials are admitted
// only for an adapter of that very app and connection.
registerMultiInstanceCredentialResolver((orgId, appName, connectionName) => {
  const api = apiConnFor(orgId, appName)
  if (!api || api.connection !== connectionName) return undefined
  return async ({ identifier, credentials }) => {
    // Before the generic credential refusal, so a demo org reads why: its
    // connections are pre-configured, not merely "no real credentials".
    await assertDemoEgressAllowed(orgId, "api_connector_change")
    const row = await getAdapterRow(api, identifier)
    if (!row) {
      return {
        ok: false,
        status: 404,
        message: `Upload the adapter for "${identifier}" before its credentials.`,
      }
    }
    const needed = AUTH_CREDENTIAL_FIELDS[row.adapter.auth.type]
    const missing = needed.filter((f) => !credentials[f])
    if (missing.length > 0) {
      return {
        ok: false,
        status: 400,
        message: `The ${row.adapter.auth.type} auth of "${identifier}" needs: ${missing.join(", ")}`,
      }
    }
    const extra = Object.keys(credentials).filter((f) => !needed.includes(f))
    if (extra.length > 0) {
      return {
        ok: false,
        status: 400,
        message: `The ${row.adapter.auth.type} auth of "${identifier}" takes no ${extra.join(", ")}`,
      }
    }
    await invalidateConnectionCaches(api, identifier)
    return { ok: true }
  }
})

// A demo org's connection (installed by the demo seeder) is answered by the
// in-process fixture CRM; every other request goes on to the egress checks.
registerDemoApiConnectorResponder(maybeDemoApiConnectorResponse)

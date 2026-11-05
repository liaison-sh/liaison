// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CONFIG TOOL'S PENDING ITEMS, AS THE CARDS THAT FINISH THEM.
//
// A config section the agent applies can leave entries waiting on a person:
// a secret (a password, a client secret) or an OAuth consent (Gmail, Shopify).
// Each becomes the `request_secret` call that shows its card:
//
//   credentials   one card for the secret (targets.ts, secretRequestForPending)
//   oauth         the client card first when the connection has no OAuth
//                 client yet, then the consent card (`oauth_connect`)
//
// A config tool's connections are the organization's, so a consent card here
// connects a shared account (mode org). A person's own account (their Gmail)
// is asked for directly with mode personal.

import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { oauthConnectionKey, resolveOAuthClient } from "~/modules/apps/connections/oauth-client"
import { connectionTurnedOff } from "~/modules/apps/connections/oauth-client-config"
import {
  type PendingSecretItem,
  type RequestSecretParams,
  secretRequestForPending,
  usesGoogleIntegrationClient,
} from "~/modules/secret-requests/targets"

/**
 * Pending items that name a connection by another name: invoicing waits on
 * the Shopify store connection to map an issuer to its shop.
 */
const CONNECTION_ALIASES: Record<string, { app: string; connection: string }> = {
  "invoicing:shopify-shop-mapping": { app: "shopify", connection: "shop" },
}

/**
 * Whether a connect needs a client card first: the connection has no OAuth
 * client to start a consent with. Decided by the one resolver (the org's own
 * client, then the instance's): only "none" asks for a client.
 */
export async function needsClientCard(
  orgId: string,
  app: string,
  connection: string,
): Promise<boolean> {
  return (await resolveOAuthClient(orgId, oauthConnectionKey(app, connection))).source === "none"
}

/**
 * The `request_secret` calls that finish a pending item, in the order the
 * person answers them; empty when no card can (a knowledge source, a
 * connection the org no longer declares).
 */
export async function secretRequestsForPending(
  orgId: string,
  item: PendingSecretItem,
): Promise<RequestSecretParams[]> {
  if (item.kind === "credentials") {
    const params = secretRequestForPending(orgId, item)
    return params ? [params] : []
  }
  if (item.kind !== "oauth" || !item.connection) return []
  const named = CONNECTION_ALIASES[`${item.app}:${item.connection}`] ?? {
    app: item.app,
    connection: item.connection,
  }
  const config = connectionConfigRegistry.get([orgId, named.app, named.connection])
  if (config?.type !== "oauth2") return []
  const consent: RequestSecretParams = {
    kind: "oauth_connect",
    target: { app: named.app, connection: named.connection, mode: "org" },
  }
  if (!(await needsClientCard(orgId, named.app, named.connection))) return [consent]
  const client: RequestSecretParams = usesGoogleIntegrationClient(named.app, named.connection)
    ? { kind: "google_integration_client", target: {} }
    : { kind: "oauth_client", target: { app: named.app, connection: named.connection } }
  return [client, consent]
}

/** The call a pending item names: its card. */
export interface AskWith {
  tool: "kernel__request_secret"
  params: RequestSecretParams
}

/**
 * A config tool's pending items with the card each needs (`askWith`), in the
 * order the person answers them. An OAuth item without a client gets a client
 * item before it; one client card is asked once even when several items wait
 * on it (two Gmail inboxes, one Google client). The CLI's own words for an
 * OAuth item (`liaison connect ...`) are replaced: on this path a card does it.
 */
export async function pendingWithCards<T extends PendingSecretItem>(
  orgId: string,
  items: readonly T[],
): Promise<Array<T | (T & { askWith: AskWith }) | (PendingSecretItem & { askWith: AskWith })>> {
  const out: Array<T | (T & { askWith: AskWith }) | (PendingSecretItem & { askWith: AskWith })> = []
  const asked = new Set<string>()
  for (const item of items) {
    const calls = await secretRequestsForPending(orgId, item)
    if (calls.length === 0) {
      out.push(item)
      continue
    }
    for (const [i, params] of calls.entries()) {
      const key = JSON.stringify(params)
      const askWith: AskWith = { tool: "kernel__request_secret", params }
      if (i < calls.length - 1) {
        // A client card before the consent, once.
        if (asked.has(key)) continue
        asked.add(key)
        const target = params.target as { app?: string; connection?: string }
        out.push({
          kind: "credentials",
          app: target.app ?? item.app,
          ...(target.connection ? { connection: target.connection } : {}),
          action: "the person enters the OAuth client on the card askWith names, before connecting",
          askWith,
        })
        continue
      }
      asked.add(key)
      // A connection the workspace switched off is turned on before its card.
      const consentOf = params.target as { app?: string; connection?: string }
      const off =
        params.kind === "oauth_connect" && consentOf.app && consentOf.connection
          ? await connectionTurnedOff(orgId, consentOf.app, consentOf.connection)
          : null
      out.push({
        ...item,
        ...(item.kind === "oauth"
          ? {
              action: off
                ? `${off.turnOn} The person then signs in at the provider on the card askWith names`
                : "the person signs in at the provider on the card askWith names",
            }
          : {}),
        askWith,
      })
    }
  }
  return out
}

// SPDX-License-Identifier: FSL-1.1-ALv2
import { HTTPException } from "hono/http-exception"
import { type OAuthClientConfig, oauthClientResolverRegistry } from "~/modules/apps/app-registries"
import {
  type MintingClientRecord,
  oauthConnectionKey,
  resolveMintingClient,
  resolveOAuthClientCredentials,
} from "~/modules/apps/connections/oauth-client"

export type { OAuthClientConfig } from "~/modules/apps/app-registries"

/**
 * An app's resolver refusing a connect because the workspace turned the
 * connection's provider off (Gmail mailboxes switched off): a 403, as before,
 * plus what turns it on. Not a missing client: a person cannot fix it on a
 * client card, an admin flips the switch. A connect card is not posted while it
 * stands (secret-request-tools.ts), and a card that meets it says so with a code.
 */
export class ConnectionTurnedOffError extends HTTPException {
  readonly code = "connection_turned_off"
  constructor(
    message: string,
    /** What turns it on, for the agent: the config tool call the person approves. */
    readonly turnOn: string,
  ) {
    super(403, { message })
    this.name = "ConnectionTurnedOffError"
  }
}

/**
 * The refusal an app's resolver gives because the connection is turned off for
 * the workspace, or null (on, no resolver, or any other answer: a missing client
 * is the client card's business). Callers must have the org's apps registered.
 */
export async function connectionTurnedOff(
  orgId: string,
  appName: string,
  connectionName: string,
): Promise<ConnectionTurnedOffError | null> {
  const resolver = oauthClientResolverRegistry.get([orgId, appName, connectionName])
  if (!resolver) return null
  try {
    await resolver({ orgId, appName, connectionName })
    return null
  } catch (err) {
    return err instanceof ConnectionTurnedOffError ? err : null
  }
}

/**
 * The client an OAuth flow (authorize, code exchange, refresh) uses for a
 * connection. An app's own resolver (`_oauthClientResolvers`) goes first: it may
 * refuse (throw, e.g. the provider is turned off for the org) or return the
 * client it picks through `resolveOAuthClientCredentials`. A resolver returning
 * null, or no resolver, leaves the choice to the one resolver: the org's own
 * client, then the instance's (oauth-client.ts).
 */
export async function resolveOAuthClientConfig(params: {
  orgId: string
  appName: string
  connectionName: string
  auditAction?: string
}): Promise<OAuthClientConfig | null> {
  const resolver = oauthClientResolverRegistry.get([
    params.orgId,
    params.appName,
    params.connectionName,
  ])

  if (resolver) {
    const resolved = await resolver({
      orgId: params.orgId,
      appName: params.appName,
      connectionName: params.connectionName,
    })
    if (resolved) return resolved
  }

  const credentials = await resolveOAuthClientCredentials(
    params.orgId,
    oauthConnectionKey(params.appName, params.connectionName),
    { auditAction: params.auditAction },
  )
  if (!credentials) return null
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    source: credentials.source === "org" ? "org" : "deployment",
  }
}

/**
 * The client a refresh uses: the one that minted the account's tokens.
 *
 * - An account recorded as minted by the org's or the instance's client uses
 *   that client while it still resolves (`resolveMintingClient`). An app's own
 *   resolver may still refuse (403: Gmail turned off for the org); the client it
 *   would pick is ignored, since a refresh token works only with its own client.
 * - A "legacy" account (connected before the minting client was recorded)
 *   resolves in the order that applied when it connected: the app's own resolver
 *   first, then the old per-connection order (Drive: the instance's client, then
 *   its stored row).
 *
 * Null: the minting client is gone; the caller marks the account for reconnect.
 */
export async function resolveRefreshClient(
  account: MintingClientRecord,
): Promise<OAuthClientConfig | null> {
  const resolver = oauthClientResolverRegistry.get([
    account.orgId,
    account.appName,
    account.connectionName,
  ])
  const legacy = (account.oauthClientSource ?? "legacy") === "legacy"
  if (resolver) {
    const params = {
      orgId: account.orgId,
      appName: account.appName,
      connectionName: account.connectionName,
    }
    if (legacy) {
      const resolved = await resolver(params)
      if (resolved) return resolved
    } else {
      try {
        await resolver(params)
      } catch (err) {
        // A refusal (403: turned off) stands; "no client configured" does not,
        // the minting client decides.
        if (err instanceof HTTPException && err.status === 403) throw err
      }
    }
  }
  return resolveMintingClient(account, "oauth-refresh-lookup")
}

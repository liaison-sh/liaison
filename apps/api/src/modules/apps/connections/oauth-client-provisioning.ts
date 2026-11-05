// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Headless provisioning of a per-connection OAuth CLIENT (client id + secret)
// for INSTALLED apps (shopify, social, ...). These apps declare `type: oauth2`
// connections but -- unlike in-tree apps -- cannot carry a TS
// `_oauthClientResolvers`, so their client credentials must live in the
// `kernel.oauth_providers` table keyed by `<app>:<connection>` (exactly the key
// `lookupOAuthProviderClientConfig` reads at flow time). Before this module the
// ONLY writer of that table was the OIDC-SSO admin endpoint, which does OIDC
// discovery and rejects app integrations -- so a self-host had no way to set
// these clients. This closes that gap with one shared upsert used by BOTH the
// `config apply` CLI and the Settings > Apps UI, so the two surfaces cannot drift.
//
// The auth/token URLs come from the app MANIFEST at flow time (see
// `startOAuthFlow`), never from this row -- `lookupOAuthProviderClientConfig`
// reads only `client_id` + `client_secret_encrypted`. So `issuer_url` (NOT NULL
// in the shared SSO schema) is a sentinel that also marks the row as an
// app-connection client, which the SSO provider lists filter out by name.
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { oauthClientResolverRegistry } from "~/modules/apps/app-registries"
import { resolveOAuthClient } from "~/modules/apps/connections/oauth-client"

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? ""

/** oauth_providers.name for a per-connection app OAuth client. Matches the key
 *  `lookupOAuthProviderClientConfig` builds (`<appName>:<connectionName>`). */
export function connectionProviderName(appName: string, connectionName: string): string {
  return `${appName}:${connectionName}`
}

/** Sentinel `issuer_url` for app-connection client rows. Never dereferenced --
 *  the real auth/token URLs come from the app manifest at flow time -- and its
 *  `.invalid` host makes accidental use fail loudly. Also lets the SSO lists tell
 *  app-connection clients apart from real login providers. */
function appConnectionIssuer(name: string): string {
  return `https://app-connection.invalid/${name}`
}

/**
 * Upsert the OAuth client (client id + encrypted secret) for an installed app's
 * oauth2 connection. Idempotent: updates the existing row (by org + name) or
 * inserts a new one. `oauth_providers` has no unique (org, name) index, so this
 * does a select-then-write inside one privileged transaction rather than an
 * ON CONFLICT. Returns whether a row was created (vs updated).
 */
export async function upsertConnectionOAuthClient(opts: {
  orgId: string
  appName: string
  connectionName: string
  clientId: string
  clientSecret: string
}): Promise<{ created: boolean }> {
  const name = connectionProviderName(opts.appName, opts.connectionName)
  const clientSecretEncrypted = encryptSecret(
    opts.clientSecret,
    ENCRYPTION_KEY,
    CryptoContext.oauthProviderClientSecret,
  )
  return withPrivilegedDb(opts.orgId, "oauth-client-upsert", async (tx) => {
    const existing = await tx
      .select({ id: oauthProviders.id })
      .from(oauthProviders)
      .where(and(eq(oauthProviders.orgId, opts.orgId), eq(oauthProviders.name, name)))
      .limit(1)
    if (existing[0]) {
      await tx
        .update(oauthProviders)
        .set({ clientId: opts.clientId, clientSecretEncrypted, updatedAt: new Date() })
        .where(eq(oauthProviders.id, existing[0].id))
      return { created: false }
    }
    await tx.insert(oauthProviders).values({
      orgId: opts.orgId,
      name,
      issuerUrl: appConnectionIssuer(name),
      clientId: opts.clientId,
      clientSecretEncrypted,
    })
    return { created: true }
  })
}

/**
 * The end of a client id an admin can recognise: Google ids end in a shared
 * `.apps.googleusercontent.com`, so the hint is taken before the first dot.
 */
export function oauthClientIdHint(clientId: string): string {
  return `...${(clientId.split(".")[0] ?? clientId).slice(-7)}`
}

/** What `GET /connections/:app/:conn/oauth-client` reports. Never a secret. */
export interface ConnectionOAuthClientStatus {
  configured: boolean
  /** Where the client comes from: the org's own (a stored row, or the org's
   *  setting an app resolver read), the deployment's environment, or the app's
   *  own configuration. */
  source?: "org" | "deployment" | "app"
  /** The stored row's client id (an org-provided client set here). */
  clientId?: string
  /** The end of a client the app resolves itself. */
  clientIdHint?: string
  /** Why the app's resolver refused, e.g. the provider is turned off. */
  reason?: string
  /** The app supplies (or refuses) its client itself: a client set from the
   *  connect dialog would be ignored at sign-in, so the dialog asks for none. */
  appManaged: boolean
}

/**
 * Whether an OAuth client is configured for a connection. The app's own
 * resolver (`_oauthClientResolvers`) goes first, exactly as at sign-in
 * (oauth-client-config.ts): a client it returns, or its refusal, is the
 * answer. A resolver that returns null leaves the stored row in charge, per
 * the resolver contract: the workspace's own client, then the instance's
 * (oauth-client.ts). Callers must have the org's apps registered
 * (`ensureAppsForOrg`) for the resolver to be found.
 */
export async function getConnectionOAuthClient(
  orgId: string,
  appName: string,
  connectionName: string,
): Promise<ConnectionOAuthClientStatus> {
  const resolver = oauthClientResolverRegistry.get([orgId, appName, connectionName])
  if (resolver) {
    try {
      const resolved = await resolver({ orgId, appName, connectionName })
      if (resolved) {
        return {
          configured: true,
          source: resolved.source ?? "app",
          clientIdHint: oauthClientIdHint(resolved.clientId),
          appManaged: true,
        }
      }
    } catch (err) {
      return {
        configured: false,
        reason: err instanceof Error ? err.message : String(err),
        appManaged: true,
      }
    }
  }
  const resolved = await resolveOAuthClient(orgId, connectionProviderName(appName, connectionName))
  if (resolved.source === "org" && resolved.clientId) {
    return { configured: true, source: "org", clientId: resolved.clientId, appManaged: false }
  }
  if (resolved.source === "instance" && resolved.clientId) {
    return {
      configured: true,
      source: "deployment",
      clientIdHint: oauthClientIdHint(resolved.clientId),
      appManaged: false,
    }
  }
  return { configured: false, appManaged: false }
}

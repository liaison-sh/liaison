// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Where an app connection's OAuth client comes from: the one resolver.
 *
 * Order, for every connection: the workspace's own client first ("org"), then a
 * client the instance provides for every workspace ("instance", from the server's
 * environment), else none. A workspace that brings its own client always wins
 * over the instance's.
 *
 * - Org client: the workspace's Google client (Settings, Google) for the
 *   connections that share it (Gmail in Mail and Tickets, Google Calendar);
 *   for every other connection, its own `oauth_providers` row `<app>:<connection>`.
 * - Instance client: the environment pair the table below names for the
 *   connection; a key the table does not name reads the convention pair
 *   `LIAISON_OAUTH_<KEY>_CLIENT_ID` / `_CLIENT_SECRET` (`instanceClientEnvNames`).
 *
 * The key is `<app>:<connection>`, or the key the connection's manifest names
 * (`connections.<name>.oauthClient.key`, always in the app's own namespace) so
 * two connections of one app share one client (`oauthClientKey`). An installed
 * app gets its client this way: it carries no resolver code.
 *   The Facebook connections' pair (META_APP_ID + META_APP_SECRET) is the
 *   managed cell's shared Meta app and applies in the managed edition only.
 *
 * `resolveOAuthClient` says which source applies and the client id, never the
 * secret: guides, setup state and cards use it to decide whether a person has a
 * client to create. Only the OAuth flows and the webhook secret mirror read the
 * secret, through `resolveOAuthClientCredentials`. No other module reads a
 * connection's client (guarded by oauth-client.guard.test.ts).
 */
import { type OAuthClientSource, orgKernelSettingsSchema } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts, oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { isManagedEdition } from "~/lib/edition"
import { encryptionKey, env } from "~/lib/env"
import { getOrgKernelSettings } from "~/lib/settings"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"

export type { OAuthClientSource } from "@liaison/shared"

export interface OAuthClientResolution {
  source: OAuthClientSource
  /** The client id, when there is a client. Never the secret. */
  clientId?: string
}

export interface OAuthClientCredentials {
  source: "org" | "instance"
  clientId: string
  clientSecret: string
}

/** `<app>:<connection>`, the key of a connection's client everywhere. */
export function oauthConnectionKey(appName: string, connectionName: string): string {
  return `${appName}:${connectionName}`
}

/**
 * The key a connection's client is stored and resolved under: the one its
 * manifest declares (`oauthClient.key`), else `<app>:<connection>`. Reads the
 * org's registered manifest; an unregistered app gets the default.
 */
export function oauthClientKey(orgId: string, appName: string, connectionName: string): string {
  const declared = (
    connectionConfigRegistry.get([orgId, appName, connectionName]) as
      | { oauthClient?: { key?: unknown } }
      | undefined
  )?.oauthClient?.key
  // The manifest validator keeps it in the app's own namespace; re-checked here.
  if (typeof declared === "string" && declared.startsWith(`${appName}:`)) return declared
  return oauthConnectionKey(appName, connectionName)
}

/** The connections that share the workspace's Google client (Settings, Google). */
export const GOOGLE_WORKSPACE_CLIENT_CONNECTIONS: ReadonlySet<string> = new Set([
  "mail:gmail",
  "tickets:gmail",
  "calendar:google-calendar",
])

/** The environment variables an instance client is read from (plus, for a key the
 *  table does not name, its convention pair: `instanceClientEnvNames`). */
export interface InstanceClientEnv {
  GMAIL_OAUTH_CLIENT_ID?: string
  GMAIL_OAUTH_CLIENT_SECRET?: string
  GOOGLE_DRIVE_OAUTH_CLIENT_ID?: string
  GOOGLE_DRIVE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_MARKETING_OAUTH_CLIENT_ID?: string
  GOOGLE_MARKETING_OAUTH_CLIENT_SECRET?: string
  SHOPIFY_APP_CLIENT_ID?: string
  SHOPIFY_APP_CLIENT_SECRET?: string
  META_APP_ID?: string
  META_APP_SECRET?: string
}

/** `managedOnly`: the pair is the managed cell's shared app, never a self-hosted default. */
type EnvPair = {
  id: keyof InstanceClientEnv
  secret: keyof InstanceClientEnv
  managedOnly?: boolean
}

/** The cell's shared Meta app (Facebook login): Facebook, and Instagram through Facebook login. */
const CELL_META_ENV: EnvPair = { id: "META_APP_ID", secret: "META_APP_SECRET", managedOnly: true }

const GOOGLE_WORKSPACE_ENV: EnvPair = {
  id: "GMAIL_OAUTH_CLIENT_ID",
  secret: "GMAIL_OAUTH_CLIENT_SECRET",
}
const GOOGLE_MARKETING_ENV: EnvPair = {
  id: "GOOGLE_MARKETING_OAUTH_CLIENT_ID",
  secret: "GOOGLE_MARKETING_OAUTH_CLIENT_SECRET",
}

/** The instance client of each connection that can have one. */
const INSTANCE_CLIENT_ENV: Readonly<Record<string, EnvPair>> = {
  "mail:gmail": GOOGLE_WORKSPACE_ENV,
  "tickets:gmail": GOOGLE_WORKSPACE_ENV,
  "calendar:google-calendar": GOOGLE_WORKSPACE_ENV,
  "google-drive:drive": {
    id: "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
    secret: "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
  },
  "ads:google": GOOGLE_MARKETING_ENV,
  "ads:merchant": GOOGLE_MARKETING_ENV,
  "social:google": GOOGLE_MARKETING_ENV,
  "shopify:shop": { id: "SHOPIFY_APP_CLIENT_ID", secret: "SHOPIFY_APP_CLIENT_SECRET" },
  "social:facebook": CELL_META_ENV,
  "social:instagram_unified": CELL_META_ENV,
}

/** The connections an instance can provide a client for (docs, tests). */
export const INSTANCE_CLIENT_CONNECTIONS: readonly string[] = Object.keys(INSTANCE_CLIENT_ENV)

/** The app part of a key with a convention pair: lowercase words joined by single `-`. */
const CONVENTION_KEY_APP = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The rest of the key: lowercase words joined by single `-` or `_`. */
const CONVENTION_KEY_REST = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/

/**
 * The convention pair of a key the table does not name: `LIAISON_OAUTH_<KEY>_CLIENT_ID`
 * and `_CLIENT_SECRET`, the key upper-cased with `-` and `_` as `_` and the `:`
 * between the app and the rest as `__` (`my-app:crm` ->
 * `LIAISON_OAUTH_MY_APP__CRM_CLIENT_ID`). The mapping is one to one: a part never
 * holds `__` (single separators only), so `__` only ever comes from the `:`, and
 * app `api` with key `api:connector-crm` reads a different pair than app
 * `api-connector` with key `api-connector:crm`. A key outside that shape (an
 * uppercase letter, a doubled or edge separator, a second `:`) has no convention
 * pair: null.
 */
export function instanceClientEnvNames(
  connectionKey: string,
): { id: string; secret: string } | null {
  const parts = connectionKey.split(":")
  const [app, rest] = parts
  if (
    parts.length !== 2 ||
    !CONVENTION_KEY_APP.test(app ?? "") ||
    !CONVENTION_KEY_REST.test(rest ?? "")
  ) {
    return null
  }
  // `-` and `_` both become `_`. The app part holds no `_`, so it maps one to
  // one; in the rest, `crm-x` and `crm_x` share a pair, but both are keys of
  // the same app (a key is always in its app's own namespace).
  const norm = parts.map((p) => p.toUpperCase().replace(/[-_]/g, "_")).join("__")
  return { id: `LIAISON_OAUTH_${norm}_CLIENT_ID`, secret: `LIAISON_OAUTH_${norm}_CLIENT_SECRET` }
}

/** The instance's client for a connection, or null when it provides none. */
export function instanceOAuthClient(
  connectionKey: string,
  source?: InstanceClientEnv,
): { clientId: string; clientSecret: string } | null {
  const pair = INSTANCE_CLIENT_ENV[connectionKey]
  if (pair?.managedOnly && !isManagedEdition()) return null
  const names = pair ?? instanceClientEnvNames(connectionKey)
  if (!names) return null
  // The table's pairs are parsed env (lib/env.ts); a convention pair is read raw.
  const from = (source ?? (pair ? env : process.env)) as Record<string, unknown>
  const clientId = from[names.id]
  const clientSecret = from[names.secret]
  return typeof clientId === "string" &&
    clientId &&
    typeof clientSecret === "string" &&
    clientSecret
    ? { clientId, clientSecret }
    : null
}

/** The workspace's Google client as stored (secret still encrypted), or null. */
export async function loadOrgGoogleOAuthClient(
  orgId: string,
): Promise<{ clientId: string; clientSecretEncrypted: string } | null> {
  const settings = await withPrivilegedDb(orgId, "google-integration-load", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const oauthClient = settings.integrations?.google?.oauthClient
  if (!oauthClient?.clientId || !oauthClient?.clientSecretEncrypted) return null
  return {
    clientId: oauthClient.clientId,
    clientSecretEncrypted: oauthClient.clientSecretEncrypted,
  }
}

/** The connection's own `oauth_providers` row, or null. */
async function loadOrgConnectionClientRow(
  orgId: string,
  connectionKey: string,
  auditAction: string,
): Promise<{ clientId: string; clientSecretEncrypted: string } | null> {
  const rows = await withPrivilegedDb(orgId, auditAction, (tx) =>
    tx
      .select({
        clientId: oauthProviders.clientId,
        clientSecretEncrypted: oauthProviders.clientSecretEncrypted,
      })
      .from(oauthProviders)
      .where(and(eq(oauthProviders.orgId, orgId), eq(oauthProviders.name, connectionKey)))
      .limit(1),
  )
  return rows[0] ?? null
}

type Credentials = { clientId: string; clientSecret: string }

function decryptGoogleSetting(google: { clientId: string; clientSecretEncrypted: string }) {
  return {
    clientId: google.clientId,
    clientSecret: decryptSecret(
      google.clientSecretEncrypted,
      encryptionKey,
      CryptoContext.googleClientSecret,
    ),
  }
}

function decryptRow(row: { clientId: string; clientSecretEncrypted: string }): Credentials {
  return {
    clientId: row.clientId,
    clientSecret: decryptSecret(
      row.clientSecretEncrypted,
      process.env.ENCRYPTION_KEY ?? encryptionKey,
      CryptoContext.oauthProviderClientSecret,
    ),
  }
}

/**
 * The workspace's own client for a connection, as stored (secret encrypted).
 * Gmail and Calendar take the workspace Google client first, then a client
 * stored for the connection itself (`PUT /api/connections/:app/:conn/oauth-client`,
 * `config apply`); every other connection only its stored row.
 */
async function loadOrgClient(
  orgId: string,
  connectionKey: string,
  auditAction: string,
): Promise<{ kind: "google" | "row"; clientId: string; clientSecretEncrypted: string } | null> {
  if (GOOGLE_WORKSPACE_CLIENT_CONNECTIONS.has(connectionKey)) {
    const google = await loadOrgGoogleOAuthClient(orgId)
    if (google) return { kind: "google", ...google }
  }
  const row = await loadOrgConnectionClientRow(orgId, connectionKey, auditAction)
  return row ? { kind: "row", ...row } : null
}

/** The workspace's own client for a connection, secret decrypted, or null. */
async function orgOAuthClient(
  orgId: string,
  connectionKey: string,
  auditAction: string,
): Promise<Credentials | null> {
  const stored = await loadOrgClient(orgId, connectionKey, auditAction)
  if (!stored) return null
  return stored.kind === "google" ? decryptGoogleSetting(stored) : decryptRow(stored)
}

/**
 * Which client a connection uses (org, then instance) and its id. Never the secret.
 * `connectionKey` is `<app>:<connection>` (oauthConnectionKey).
 */
export async function resolveOAuthClient(
  orgId: string,
  connectionKey: string,
): Promise<OAuthClientResolution> {
  const org = await loadOrgClient(orgId, connectionKey, "oauth-client-source")
  if (org) return { source: "org", clientId: org.clientId }
  const instance = instanceOAuthClient(connectionKey)
  if (instance) return { source: "instance", clientId: instance.clientId }
  return { source: "none" }
}

/**
 * The client a connection's OAuth flow uses, secret included: org, then instance.
 * For the OAuth flows (authorize, code exchange) and the webhook secret only.
 * `instanceEnv` replaces the environment in tests.
 */
export async function resolveOAuthClientCredentials(
  orgId: string,
  connectionKey: string,
  options: { auditAction?: string; instanceEnv?: InstanceClientEnv } = {},
): Promise<OAuthClientCredentials | null> {
  const org = await orgOAuthClient(orgId, connectionKey, options.auditAction ?? "oauth-client")
  if (org) return { source: "org", ...org }
  const instance = instanceOAuthClient(connectionKey, options.instanceEnv)
  if (instance) return { source: "instance", ...instance }
  return null
}

// ─── The client that minted an account's tokens ─────────────────────────────

/** What a connected account records about the client that minted its tokens. */
export type MintingClientSource = "org" | "instance" | "legacy"

export interface MintingClientRecord {
  orgId: string
  appName: string
  connectionName: string
  /** Null on rows written before the record existed: treated as "legacy". */
  oauthClientSource: string | null
  oauthClientId: string | null
}

/**
 * The client order before the one resolver, for accounts connected before the
 * minting client was recorded ("legacy"): Google Drive took the instance's
 * client first, then its stored row; Gmail and Calendar the workspace Google
 * client, then the instance's, then a stored row; every other connection its
 * stored row only.
 */
async function legacyOAuthClient(
  orgId: string,
  connectionKey: string,
  auditAction: string,
): Promise<Credentials | null> {
  if (connectionKey === "google-drive:drive") {
    const instance = instanceOAuthClient(connectionKey)
    if (instance) return instance
    const row = await loadOrgConnectionClientRow(orgId, connectionKey, auditAction)
    return row ? decryptRow(row) : null
  }
  if (GOOGLE_WORKSPACE_CLIENT_CONNECTIONS.has(connectionKey)) {
    const google = await loadOrgGoogleOAuthClient(orgId)
    if (google) return decryptGoogleSetting(google)
    const instance = instanceOAuthClient(connectionKey)
    if (instance) return instance
  }
  const row = await loadOrgConnectionClientRow(orgId, connectionKey, auditAction)
  return row ? decryptRow(row) : null
}

/** The org's own client with the recorded id: the Google setting or the stored row. */
async function orgClientById(
  account: MintingClientRecord,
  key: string,
  auditAction: string,
): Promise<Credentials | null> {
  if (!account.oauthClientId) return orgOAuthClient(account.orgId, key, auditAction)
  if (GOOGLE_WORKSPACE_CLIENT_CONNECTIONS.has(key)) {
    const google = await loadOrgGoogleOAuthClient(account.orgId)
    if (google?.clientId === account.oauthClientId) return decryptGoogleSetting(google)
  }
  const row = await loadOrgConnectionClientRow(account.orgId, key, auditAction)
  return row?.clientId === account.oauthClientId ? decryptRow(row) : null
}

/**
 * The client that minted an account's tokens, while it can still be resolved:
 * the source recorded at connect, and the same client id. Null when that client
 * is gone (the instance stopped providing it, or the org replaced its own): the
 * account then needs a reconnect, which moves it to the current client.
 */
export async function resolveMintingClient(
  account: MintingClientRecord,
  auditAction = "oauth-minting-client",
): Promise<Credentials | null> {
  const key = oauthClientKey(account.orgId, account.appName, account.connectionName)
  const source = account.oauthClientSource ?? "legacy"
  let client: Credentials | null
  if (source === "instance") client = instanceOAuthClient(key)
  else if (source === "org") client = await orgClientById(account, key, auditAction)
  else client = await legacyOAuthClient(account.orgId, key, auditAction)
  if (!client) return null
  if (account.oauthClientId && client.clientId !== account.oauthClientId) return null
  return client
}

/** The status message of an account whose minting client is gone. */
export const MINTING_CLIENT_GONE_MESSAGE =
  "The OAuth client this account was connected with is no longer configured -- reconnect required"

/**
 * The active accounts of these connections that a reconnect would move to
 * `clientId`: their tokens were minted by another client. They keep working on
 * their own client until then.
 */
export async function accountsMintedByAnotherClient(
  orgId: string,
  connectionKeys: readonly string[],
  clientId: string,
): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "oauth-minting-client-count", (tx) =>
    tx
      .select({
        appName: connectedAccounts.appName,
        connectionName: connectedAccounts.connectionName,
        oauthClientId: connectedAccounts.oauthClientId,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.status, "active"),
          eq(connectedAccounts.providerType, "oauth2"),
        ),
      ),
  )
  const keys = new Set(connectionKeys)
  return rows.filter(
    (r) =>
      keys.has(oauthConnectionKey(r.appName, r.connectionName)) && r.oauthClientId !== clientId,
  ).length
}

/**
 * For a webhook verifier with no secret stored at connect: the current client
 * secret of the connection that declares `key` as its `clientSecretConfigKey`
 * (providers such as Shopify sign webhooks with the app's client secret), org
 * then instance. Null when no connection declares the key or there is no client.
 */
export async function connectionClientSecretForConfigKey(
  orgId: string,
  appName: string,
  key: string,
  connections: Record<string, { clientSecretConfigKey?: string }> | null | undefined,
): Promise<string | null> {
  if (!connections) return null
  const connectionName = Object.entries(connections).find(
    ([, c]) => c?.clientSecretConfigKey === key,
  )?.[0]
  if (!connectionName) return null
  const credentials = await resolveOAuthClientCredentials(
    orgId,
    oauthClientKey(orgId, appName, connectionName),
    { auditAction: "webhook-client-secret" },
  )
  return credentials?.clientSecret ?? null
}

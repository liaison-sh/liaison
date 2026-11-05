// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The values a Google setup needs, computed, never guessed: the redirect URIs
 * built from BASE_URL exactly as the connection and sign-in code build them, the
 * union of the Google scopes of the apps that are on in this workspace, and the
 * Google APIs those scopes need turned on. The guide copy lives in
 * `@liaison/shared` (setup-guides.ts); this file only feeds it.
 */
import {
  GMAIL_PUSH_PUBLISHER,
  type GoogleClientInfo,
  type GoogleClients,
  type GoogleSetupConnection,
  type GoogleSetupValues,
  type OAuthClientSource,
} from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import {
  GOOGLE_WORKSPACE_CLIENT_CONNECTIONS,
  type InstanceClientEnv,
  instanceOAuthClient,
  oauthConnectionKey,
  resolveOAuthClient,
} from "~/modules/apps/connections/oauth-client"
import { CONNECTIONS_CALLBACK_PATH, SIGN_IN_CALLBACK_PATH } from "~/modules/connection-guides/paths"

const GOOGLE_AUTHORIZE_HOST = "accounts.google.com"

/** Scopes that only identify the account: no API to turn on. */
const IDENTITY_SCOPES = new Set([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
])

/** Google API per scope prefix (after `https://www.googleapis.com/auth/`). */
const SCOPE_APIS: Array<{ prefix: string; id: string; name: string }> = [
  { prefix: "gmail.", id: "gmail.googleapis.com", name: "Gmail API" },
  { prefix: "calendar", id: "calendar-json.googleapis.com", name: "Google Calendar API" },
  { prefix: "drive", id: "drive.googleapis.com", name: "Google Drive API" },
  { prefix: "adwords", id: "googleads.googleapis.com", name: "Google Ads API" },
  { prefix: "content", id: "merchantapi.googleapis.com", name: "Merchant API" },
  { prefix: "youtube", id: "youtube.googleapis.com", name: "YouTube Data API v3" },
]

/** The Google API a scope needs, or null for an identity scope. Undefined: unknown. */
export function googleApiForScope(scope: string): { id: string; name: string } | null | undefined {
  if (IDENTITY_SCOPES.has(scope)) return null
  const rest = scope.startsWith("https://www.googleapis.com/auth/")
    ? scope.slice("https://www.googleapis.com/auth/".length)
    : null
  if (rest === null) return undefined
  const hit = SCOPE_APIS.find((a) => rest === a.prefix || rest.startsWith(a.prefix))
  return hit ? { id: hit.id, name: hit.name } : undefined
}

/** A connection's config is a Google OAuth one when it authorizes at Google. */
export function isGoogleConnection(config: { type?: string; authorizationUrl?: string }): boolean {
  if (config.type !== "oauth2" || !config.authorizationUrl) return false
  try {
    return new URL(config.authorizationUrl).host === GOOGLE_AUTHORIZE_HOST
  } catch {
    return false
  }
}

export interface GoogleSetupInput {
  baseUrl: string
  signInEnabled: boolean
  /** The org's id, for the Gmail push endpoint. */
  orgId: string
  connections: Array<{
    app: string
    connection: string
    scopes: string[]
    /** Its client today (resolveOAuthClient). Absent: none yet. */
    clientSource?: OAuthClientSource
    /** An account of it was connected with the workspace's current client. */
    clientProven?: boolean
  }>
  /** The instance provides a shared Gmail push topic (GMAIL_PUBSUB_TOPIC). */
  instancePushTopic?: boolean
  /** The client of each Google family (resolveGoogleClients). Absent: none known. */
  clients?: GoogleClients
  /** The Cloud project's id, when the person gave it (console links preselect it). */
  projectId?: string
  /** The address of the admin setting Google up: the consent screen's support email. */
  supportEmail?: string
  /** One feature (an app name: mail, calendar, google-drive...) being set up: the
   *  APIs and scopes are its own, the other apps' APIs an optional aside. */
  feature?: string
}

const NO_CLIENT: GoogleClientInfo = { source: "none", restrictedVerified: false }

/** Pure: the setup values from the deployment and the Google connections that are on. */
export function googleSetupValuesFrom(input: GoogleSetupInput): GoogleSetupValues {
  const base = input.baseUrl.replace(/\/+$/, "")
  const connectionsRedirectUri = `${base}${CONNECTIONS_CALLBACK_PATH}`
  const signInRedirectUri = `${base}${SIGN_IN_CALLBACK_PATH}`
  const connections: GoogleSetupConnection[] = [...input.connections]
    .sort((a, b) => `${a.app}:${a.connection}`.localeCompare(`${b.app}:${b.connection}`))
    .map((c) => ({
      app: c.app,
      connection: c.connection,
      scopes: [...c.scopes],
      workspaceClient: GOOGLE_WORKSPACE_CLIENT_CONNECTIONS.has(
        oauthConnectionKey(c.app, c.connection),
      ),
      clientSource: c.clientSource ?? "none",
      ...(c.clientProven ? { clientProven: true } : {}),
    }))
  // A client the person creates serves the connections that have none yet (the
  // workspace's own client and the instance's both count as one): its scopes and
  // APIs are theirs only. When every one has a client, nothing is created and
  // the values list them all, for reference.
  // The workspace's own client covers a connection it was never used for only
  // if that connection's APIs and scopes are on in the client's project: they
  // are listed to check (a client set up for Gmail, Calendar turned on later).
  // With the workspace's own Google client set, a connection that takes a client
  // of its own (Drive, YouTube) and has none is not part of this setup: nothing
  // is created for it until the person asks for it, on its own client card.
  const ownWorkspaceClient = connections.some((c) => c.workspaceClient && c.clientSource === "org")
  const separate = ownWorkspaceClient
    ? connections.filter((c) => !c.workspaceClient && c.clientSource === "none")
    : []
  const toCreate = connections.filter((c) => c.clientSource === "none" && !separate.includes(c))
  // A connection asking only for scopes a proven one already got with that client
  // (tickets' Gmail beside mail's) has nothing left to check.
  const provenScopes = new Set(
    connections.filter((c) => c.clientSource === "org" && c.clientProven).flatMap((c) => c.scopes),
  )
  const toVerify = connections.filter(
    (c) =>
      c.clientSource === "org" && !c.clientProven && c.scopes.some((s) => !provenScopes.has(s)),
  )
  const clientReady = connections.length > 0 && toCreate.length === 0
  const verifyApis = clientReady && toVerify.length > 0
  const instanceClientOnly =
    connections.length > 0 && connections.every((c) => c.clientSource === "instance")
  const all = clientReady
    ? verifyApis
      ? toVerify
      : connections.filter((c) => !separate.includes(c))
    : [...toCreate, ...toVerify]
  // One feature at a time: its own APIs and scopes; the others are an aside. A
  // feature with no Google connection here keeps the whole list (nothing to narrow).
  const feature = input.feature && all.some((c) => c.app === input.feature) ? input.feature : null
  const listed = feature ? all.filter((c) => c.app === feature) : all
  const scopes: string[] = []
  for (const c of listed) for (const s of c.scopes) if (!scopes.includes(s)) scopes.push(s)
  const apis: Array<{ id: string; name: string }> = []
  const unmappedScopes: string[] = []
  for (const s of scopes) {
    const api = googleApiForScope(s)
    if (api === undefined) unmappedScopes.push(s)
    else if (api && !apis.some((a) => a.id === api.id)) apis.push(api)
  }
  const apiNamesOf = (list: readonly string[]) => {
    const names: string[] = []
    for (const s of list) {
      const api = googleApiForScope(s)
      if (api && !names.includes(api.name)) names.push(api.name)
    }
    return names
  }
  const alsoApis: Array<{ id: string; name: string }> = []
  if (feature) {
    for (const c of all) {
      if (c.app === feature) continue
      for (const s of c.scopes) {
        const api = googleApiForScope(s)
        if (api && !apis.some((a) => a.id === api.id) && !alsoApis.some((a) => a.id === api.id)) {
          alsoApis.push(api)
        }
      }
    }
  }
  const separateClients = separate.map((c) => ({
    app: c.app,
    connection: c.connection,
    scopes: [...c.scopes],
    apis: apiNamesOf(c.scopes),
  }))
  const mailOn = connections.some((c) => c.app === "mail" && c.connection === "gmail")
  return {
    baseUrl: base,
    connectionsRedirectUri,
    signIn: { enabled: input.signInEnabled, redirectUri: signInRedirectUri },
    // One Web client serves sign-in and every connection: both URIs on it by default.
    redirectUris: [connectionsRedirectUri, signInRedirectUri],
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.supportEmail ? { supportEmail: input.supportEmail } : {}),
    ...(feature ? { feature } : {}),
    ...(alsoApis.length > 0 ? { alsoApis } : {}),
    scopes,
    apis,
    unmappedScopes,
    connections,
    gmailPush: {
      publisher: GMAIL_PUSH_PUBLISHER,
      endpoint: mailOn ? `${base}/webhooks/${input.orgId}/mail/gmail-push` : null,
      instanceTopic: input.instancePushTopic === true,
    },
    instanceClientOnly,
    clientReady,
    verifyApis,
    ...(separateClients.length > 0 ? { separateClients } : {}),
    clients: input.clients ?? { workspace: NO_CLIENT, drive: NO_CLIENT },
  }
}

/** GOOGLE_OAUTH_INTERNAL_DOMAINS: comma-separated Workspace domains, lower-cased. */
export function parseInternalDomains(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "")
}

/** The connection whose client stands for each Google family. */
const FAMILY_KEYS = { workspace: "mail:gmail", drive: "google-drive:drive" } as const

/**
 * Where each Google family's client comes from (org, then instance), whether its
 * apps are on or not, and whether the instance's passed Google's verification for
 * restricted scopes (GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED). The instance client
 * id is public; the secret is never read here.
 */
export async function resolveGoogleClients(
  orgId: string,
  instanceEnv: InstanceClientEnv & {
    GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED?: boolean
    GOOGLE_OAUTH_INTERNAL_DOMAINS?: string
  } = env,
): Promise<GoogleClients> {
  const verified = instanceEnv.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED === true
  const internalDomains = parseInternalDomains(instanceEnv.GOOGLE_OAUTH_INTERNAL_DOMAINS)
  const one = async (key: string): Promise<GoogleClientInfo> => {
    const resolved = await resolveOAuthClient(orgId, key)
    if (resolved.source === "org") return { source: "org", restrictedVerified: false }
    const instance = instanceOAuthClient(key, instanceEnv)
    if (instance) {
      return {
        source: "instance",
        instanceClientId: instance.clientId,
        restrictedVerified: verified,
        ...(internalDomains.length > 0 ? { internalDomains } : {}),
      }
    }
    return NO_CLIENT
  }
  return { workspace: await one(FAMILY_KEYS.workspace), drive: await one(FAMILY_KEYS.drive) }
}

/** The Google connections registered for one workspace (its apps that are on). */
export function googleConnectionsOf(
  orgId: string,
): Array<{ app: string; connection: string; scopes: string[] }> {
  const connections: Array<{ app: string; connection: string; scopes: string[] }> = []
  for (const [[org, app, connection], config] of connectionConfigRegistry.entriesOf(orgId)) {
    if (org !== orgId || !isGoogleConnection(config)) continue
    connections.push({ app, connection, scopes: config.scopes ?? [] })
  }
  return connections
}

/**
 * The Google setup values of one workspace: its apps that are on, this deployment's
 * URL. `clientSources` (connection key to source, from `resolveGoogleClientSources`)
 * says which connections already have a client; absent, none has.
 */
export function computeGoogleSetupValues(
  orgId: string,
  clientSources: ReadonlyMap<string, OAuthClientSource> = new Map(),
  /** Connection keys an account was connected for with the workspace's current client. */
  provenConnections: ReadonlySet<string> = new Set(),
  /** Each Google family's client (resolveGoogleClients). Absent: none known. */
  clients?: GoogleClients,
  /** The Cloud project's id and the one feature being set up, when known. */
  focus: { projectId?: string; feature?: string; supportEmail?: string } = {},
): GoogleSetupValues {
  return googleSetupValuesFrom({
    baseUrl: env.BASE_URL,
    signInEnabled: Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET),
    orgId,
    connections: googleConnectionsOf(orgId).map((c) => ({
      ...c,
      clientSource: clientSources.get(oauthConnectionKey(c.app, c.connection)) ?? "none",
      clientProven: provenConnections.has(oauthConnectionKey(c.app, c.connection)),
    })),
    instancePushTopic: Boolean(env.GMAIL_PUBSUB_TOPIC),
    ...(clients ? { clients } : {}),
    ...(focus.projectId ? { projectId: focus.projectId } : {}),
    ...(focus.supportEmail ? { supportEmail: focus.supportEmail } : {}),
    ...(focus.feature ? { feature: focus.feature } : {}),
  })
}

/** Where each Google connection of the workspace gets its client (org, instance, none). */
export async function resolveGoogleClientSources(
  orgId: string,
): Promise<Map<string, OAuthClientSource>> {
  const out = new Map<string, OAuthClientSource>()
  for (const c of googleConnectionsOf(orgId)) {
    const key = oauthConnectionKey(c.app, c.connection)
    out.set(key, (await resolveOAuthClient(orgId, key)).source)
  }
  return out
}

/**
 * The Google connections of the workspace that an account was ever connected
 * for with the workspace's CURRENT own client (the minting client each
 * connected account records, migration 0217). Those connections' APIs and
 * scopes are known to work in that client's project; the others are checked.
 */
export async function resolveGoogleClientProven(orgId: string): Promise<Set<string>> {
  const proven = new Set<string>()
  const byKey = new Map<string, string>()
  for (const c of googleConnectionsOf(orgId)) {
    const key = oauthConnectionKey(c.app, c.connection)
    const client = await resolveOAuthClient(orgId, key)
    if (client.source === "org" && client.clientId) byKey.set(key, client.clientId)
  }
  if (byKey.size === 0) return proven
  const rows = await withPrivilegedDb(orgId, "google-setup-proven-clients", (tx) =>
    tx
      .selectDistinct({
        app: connectedAccounts.appName,
        connection: connectedAccounts.connectionName,
        clientId: connectedAccounts.oauthClientId,
      })
      .from(connectedAccounts)
      .where(
        and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.oauthClientSource, "org")),
      ),
  )
  for (const r of rows) {
    const key = oauthConnectionKey(r.app, r.connection)
    if (r.clientId && byKey.get(key) === r.clientId) proven.add(key)
  }
  return proven
}

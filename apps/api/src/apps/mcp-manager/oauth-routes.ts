// SPDX-License-Identifier: FSL-1.1-ALv2
//
// OAuth sign-in for MCP servers, per the MCP authorization spec (2025-11-25
// semantics plus the 2026-07-28 client MUSTs):
//
//   start     — probe the server (its 401 challenge), discover PRM and the AS
//               (oauth-discovery.ts), pick the client (pre-registered > CIMD >
//               DCR > ask, oauth-registration.ts), select the scope, and build
//               the authorize URL with PKCE S256 and `resource`. The state row
//               records the issuer, resource and scope the request is bound to.
//   callback  — state + browser binding, then RFC 9207: the `iss` must be the
//               issuer the sign-in started with, and must be present when the AS
//               advertises it. Then the code exchange, with `resource`.
//
// `oauth_static` rows created with explicit endpoints (before discovery
// existed) keep using them; every other sign-in is discovered.
//
// All writes on the callback (secrets, oauth_metadata, health reset, state row
// delete, audit queueEvent) run inside ONE transaction so a successful audit can
// never desynchronise from token reality.
import crypto from "node:crypto"
import {
  exchangeAuthorization,
  selectClientAuthMethod,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { advisoryXactLock } from "~/db/advisory-lock"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { mcpConnectionHealth, mcpConnections, mcpOAuthState } from "~/db/schema/app_mcp_manager"
import { localeFromAcceptLanguage } from "~/lib/html-page"
import { rootLogger } from "~/lib/logger"
import {
  connectBindingEnabled,
  connectBindingMatches,
  setConnectBindingCookie,
} from "~/lib/oauth-browser-binding"
import { hostAllowsOrg } from "~/lib/org-host"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { UnsafeOutboundUrlError, validateOutboundUrlNoDns } from "~/lib/outbound-fetch"
import { redis } from "~/lib/redis"
import { isAppOriginRequest } from "~/lib/response"
import {
  ConnectHandoffRefusedError,
  claimConnectHandoff,
  parkConnectHandoff,
  parseConnectClient,
  type ShellConnectFlow,
  shellConnectFlowOf,
} from "~/modules/apps/connections/shell-connect"
import { desktopHandoffResponse } from "~/modules/auth/desktop-oauth"
import { invalidateMcpConnection } from "~/modules/mcp-client/index"
import { isAllowedOAuthEndpoint, UnsafeOAuthUrlError } from "~/modules/mcp-client/oauth-fetch"
import {
  authorizationServerUrlOf,
  clientInformationFor,
  persistedTokenFields,
  recordingOAuthFetch,
  tokenRequestMetadata,
} from "~/modules/mcp-client/oauth-tokens"
import {
  type ClientIdSource,
  decryptSecretsBlobForWrite,
  encryptSecretsBlob,
  type McpOAuthMetadata,
  type McpSecretsBlob,
  metadataOf,
  SecretsUnreadableError,
} from "~/modules/mcp-client/secrets"
import { mcpAllowsPrivateTargets } from "~/modules/mcp-client/transports/safe-fetch"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { CALLBACK_PAGE_HEADERS, renderCallbackPage } from "./callback-page"
import {
  canonicalServerUri,
  discoverOAuthContext,
  OAuthDiscoveryError,
  probeMcpServer,
  selectScope,
} from "./oauth-discovery"
import {
  callbackUrl,
  chooseClient,
  cimdDocumentUrl,
  clientMetadataDocument,
  MCP_OAUTH_CALLBACK_PATH,
  mcpOAuthBaseUrl,
  OAuthRegistrationError,
} from "./oauth-registration"
import {
  canWriteConnection,
  ORG_CONNECTION_WRITE_SCOPE,
  PERSONAL_CONNECTION_WRITE_SCOPE,
} from "./service/connections"

const log = rootLogger.child({ module: "mcp-manager/oauth-routes" })

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes per spec
const MCP_BINDING_COOKIE = "__mcp_oauth_state"

/**
 * A sign-in the desktop or mobile shell started (modules/apps/connections/
 * shell-connect.ts): the shell cannot hold the binding cookie, so the flow is
 * bound to the PKCE verifier the shell keeps. Its challenge and return state
 * sit beside the state row for as long as the state lives, and are claimed
 * (GETDEL) by the callback.
 */
const MCP_SHELL_FLOW_PREFIX = "oauth:mcp-shell"

async function rememberShellFlow(state: string, flow: ShellConnectFlow): Promise<void> {
  await redis.set(
    `${MCP_SHELL_FLOW_PREFIX}:${state}`,
    JSON.stringify(flow),
    "EX",
    Math.ceil(STATE_TTL_MS / 1000),
  )
}

/**
 * The success page's server name, handed from the callback (which verified the
 * OAuth state) to `/oauth/done` under a random key that lives as long as a
 * state. The page reads no row: an unauthenticated request learns a name only
 * by holding the key the callback redirected its own browser with.
 */
const MCP_DONE_PAGE_PREFIX = "oauth:mcp-done"
const DONE_PAGE_KEY_RE = /^[A-Za-z0-9_-]{32}$/

async function rememberDonePageName(serverName: string): Promise<string | null> {
  const key = crypto.randomBytes(24).toString("base64url")
  try {
    await redis.set(
      `${MCP_DONE_PAGE_PREFIX}:${key}`,
      serverName,
      "EX",
      Math.ceil(STATE_TTL_MS / 1000),
    )
    return key
  } catch (err) {
    log.warn({ err }, "MCP sign-in success page name not stored; the page says Server connected")
    return null
  }
}

async function readDonePageName(key: string): Promise<string | null> {
  if (!DONE_PAGE_KEY_RE.test(key)) return null
  try {
    return await redis.get(`${MCP_DONE_PAGE_PREFIX}:${key}`)
  } catch {
    return null
  }
}

async function takeShellFlow(state: string): Promise<ShellConnectFlow | null> {
  const raw = await redis.getdel(`${MCP_SHELL_FLOW_PREFIX}:${state}`)
  if (!raw) return null
  try {
    return shellConnectFlowOf(JSON.parse(raw))
  } catch {
    return null
  }
}

/** What a parked shell callback carries until the shell redeems it. */
interface McpHandoffRecord {
  orgId: string
  userId: string
  stateId: string
}

/**
 * Required-session variant: used on the authenticated `/oauth/start` route
 * (scope-checked in its handler), so `userId`/`orgId` are guaranteed to be populated.
 */
function actorFromCtx(c: Context<AppEnv>): UserContext {
  return {
    actorType: "user",
    userId: c.get("userId"),
    orgId: c.get("orgId"),
    scopes: c.get("scopes") ?? [],
    dimensionGrants: c.get("dimensionGrants") ?? {},
  }
}

/**
 * Optional-session variant: the `/oauth/callback` route is loaded by a
 * third-party redirect that carries no Bearer token, so `userId`/`orgId` may
 * be unset. Returns empty actor fields rather than throwing so the
 * initiator-binding check (`actor.userId && …`) can distinguish "session
 * absent" (expected, allowed) from "session present but mismatched" (rejected).
 */
function maybeActorFromCtx(c: Context<AppEnv>): UserContext {
  // Variables are typed non-optional on AppEnv because they're always set on
  // authenticated routes, but the /oauth/callback path is hit by a third-party
  // browser redirect that runs no auth middleware — the underlying `Map.get`
  // returns `undefined`. Coerce defensively here; the security check is the
  // `state` row lookup downstream, not the actor.
  return {
    actorType: "user",
    userId: (c.get("userId") as string | undefined) ?? "",
    orgId: (c.get("orgId") as string | undefined) ?? "",
    scopes: c.get("scopes") ?? [],
    dimensionGrants: c.get("dimensionGrants") ?? {},
  }
}

/**
 * A callback failure. The callback is a page a person's browser lands on, so
 * a browser gets a page that says what happened and what to do; an API client
 * (tests, tools) gets the usual JSON envelope.
 */
function callbackError(
  c: Context<AppEnv>,
  status: 400 | 403 | 409 | 410 | 502,
  error: { message: string; code: string },
): Response {
  const accept = c.req.header("accept") ?? ""
  if (!accept.includes("text/html")) return c.json({ error }, status)
  const html = renderCallbackPage({
    kind: "error",
    locale: localeFromAcceptLanguage(c.req.header("accept-language")),
    message: error.message,
    code: error.code,
  })
  return c.html(html, status, { ...CALLBACK_PAGE_HEADERS })
}

/** Where the authorization request goes, and what it is bound to. */
interface AuthorizationPlan {
  authorizationServerUrl: string
  metadata: AuthorizationServerMetadata
  /** The validated AS `issuer`; null for endpoints an operator typed in. */
  issuer: string | null
  issSupported: boolean
  resource: string
  scope?: string
  client: {
    clientId: string
    clientSecret?: string
    source: ClientIdSource
    tokenEndpointAuthMethod?: string
  }
}

class StartRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * An `oauth_static` connection created with explicit endpoints, before
 * discovery existed: its endpoints stand, there is no issuer to check.
 */
function manualPlan(
  httpUrl: string,
  meta: McpOAuthMetadata,
  secrets: McpSecretsBlob,
): AuthorizationPlan {
  const authorizationEndpoint = meta.authorizationEndpoint ?? ""
  const tokenEndpoint = meta.tokenEndpoint ?? ""
  for (const [name, value] of [
    ["authorization_endpoint", authorizationEndpoint],
    ["token_endpoint", tokenEndpoint],
  ] as const) {
    if (!isAllowedOAuthEndpoint(value)) {
      throw new StartRefusedError(
        "unsafe_endpoint",
        `Refusing unsafe OAuth ${name}: only https URLs are allowed`,
      )
    }
  }
  const clientId = meta.clientId ?? ""
  const secret = secrets.oauthClientSecret
  return {
    authorizationServerUrl: new URL(authorizationEndpoint).origin,
    metadata: {
      issuer: new URL(authorizationEndpoint).origin,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    },
    issuer: null,
    issSupported: false,
    resource: canonicalServerUri(httpUrl),
    ...(meta.scopes && meta.scopes.length > 0 ? { scope: meta.scopes.join(" ") } : {}),
    client: {
      clientId,
      ...(secret ? { clientSecret: secret } : {}),
      source: "preregistered",
      // What these connections always did: the secret in the form body.
      tokenEndpointAuthMethod: secret ? "client_secret_post" : "none",
    },
  }
}

function isManualStatic(authFlavor: string, meta: McpOAuthMetadata): boolean {
  return (
    authFlavor === "oauth_static" &&
    !meta.issuer &&
    Boolean(meta.authorizationEndpoint && meta.tokenEndpoint && meta.clientId)
  )
}

async function planAuthorization(
  conn: { authFlavor: string; httpUrl: string },
  meta: McpOAuthMetadata,
  secrets: McpSecretsBlob,
  /** The client's base (mcpOAuthBaseUrl). */
  base: string,
): Promise<AuthorizationPlan> {
  if (isManualStatic(conn.authFlavor, meta)) return manualPlan(conn.httpUrl, meta, secrets)

  const probe = await probeMcpServer(conn.httpUrl)
  const ctx = await discoverOAuthContext(conn.httpUrl, { challenge: probe.challenge })
  const extra = [...(meta.scopes ?? []), ...(meta.requiredScope ?? "").split(/\s+/).filter(Boolean)]
  const scope = selectScope(ctx, extra)
  const client = await chooseClient({
    base,
    authFlavor: conn.authFlavor,
    existing: {
      clientId: meta.clientId ?? secrets.oauthClientId,
      clientSecret: secrets.oauthClientSecret,
      clientIdSource:
        meta.clientIdSource ?? (conn.authFlavor === "oauth_static" ? "preregistered" : undefined),
      clientIssuer: meta.clientIssuer,
    },
    ctx,
    ...(scope ? { scope } : {}),
  })
  return {
    authorizationServerUrl: ctx.authorizationServerUrl,
    metadata: ctx.metadata,
    issuer: ctx.issuer,
    issSupported: ctx.issSupported,
    resource: ctx.resource,
    ...(scope ? { scope } : {}),
    client,
  }
}

function startRefusal(err: unknown): { status: 502; code: string; message: string } | null {
  if (err instanceof OAuthDiscoveryError || err instanceof OAuthRegistrationError) {
    return { status: 502, code: err.code, message: err.message }
  }
  if (err instanceof StartRefusedError) return { status: 502, code: err.code, message: err.message }
  if (err instanceof UnsafeOAuthUrlError) {
    return { status: 502, code: "unsafe_url", message: `Refusing unsafe OAuth URL: ${err.message}` }
  }
  return null
}

/** What the add flow needs to know about a server before adding it. */
export interface McpProbeResult {
  /**
   * How the person will authenticate: `none` (open server), `bearer` (a token
   * to paste), or OAuth with a client that is registered automatically
   * (`dcr`, `cimd`) or must be created at the vendor (`preregistered`).
   */
  mode: "none" | "bearer" | "dcr" | "cimd" | "preregistered"
  /** The exact redirect URL to register with the vendor. */
  callbackUrl: string
  /** The resource the server identifies as (send this URL). */
  resource: string
  /** The scopes the sign-in will ask for. */
  scopes: string[]
  /** A pre-registered client needs a secret (the AS accepts no public client). */
  requiresClientSecret: boolean
  /** The authorization server's issuer, or null without OAuth. */
  issuer: string | null
}

async function probeServer(
  url: string,
  /** The client's base (mcpOAuthBaseUrl). */
  clientBase: string,
): Promise<McpProbeResult | { error: { message: string; code: string } }> {
  const base = {
    callbackUrl: callbackUrl(clientBase),
    resource: canonicalServerUri(url),
    scopes: [] as string[],
    requiresClientSecret: false,
    issuer: null,
  }
  try {
    const probe = await probeMcpServer(url)
    if (probe.status >= 200 && probe.status < 300) return { ...base, mode: "none" }
    if (probe.status !== 401) {
      return {
        error: {
          code: "probe_failed",
          message: `The server answered HTTP ${probe.status} to an MCP initialize. Check the URL (it is the MCP endpoint, often ending in /mcp).`,
        },
      }
    }
    let ctx: Awaited<ReturnType<typeof discoverOAuthContext>>
    try {
      ctx = await discoverOAuthContext(url, { challenge: probe.challenge })
    } catch (err) {
      // A 401 and no OAuth discovery at all: a server that takes a token.
      if (err instanceof OAuthDiscoveryError && err.noOAuthAdvertised) {
        return { ...base, mode: "bearer" }
      }
      throw err
    }
    const metadata = ctx.metadata
    const cimd =
      cimdDocumentUrl(clientBase) !== null &&
      (metadata as Record<string, unknown>).client_id_metadata_document_supported === true
    const mode = cimd ? "cimd" : metadata.registration_endpoint ? "dcr" : "preregistered"
    // RFC 8414: no list means client_secret_basic only, which needs a secret.
    const methods = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"]
    return {
      mode,
      callbackUrl: callbackUrl(clientBase),
      resource: ctx.resource,
      scopes: (selectScope(ctx) ?? "").split(" ").filter(Boolean),
      requiresClientSecret: mode === "preregistered" && !methods.includes("none"),
      issuer: ctx.issuer,
    }
  } catch (err) {
    if (err instanceof OAuthDiscoveryError) {
      return { error: { code: err.code, message: err.message } }
    }
    throw err
  }
}

type FinalizeOutcome =
  | { ok: true; connectionId: string; orgId: string; displayName: string }
  | {
      ok: false
      status: 400 | 409 | 410 | 502
      error: { message: string; code: string }
    }

/**
 * RFC 9207 (a 2026-07-28 MUST): the authorization response names the issuer
 * that answered. It must be the issuer the request was sent to, and an AS that
 * advertises the parameter must send it — the defence against a mix-up attack
 * where another AS's code is replayed here.
 */
function issProblem(
  stateRow: typeof mcpOAuthState.$inferSelect,
  iss: string | undefined,
): { message: string; code: string } | null {
  // Endpoints an operator typed in: no issuer to compare with.
  if (!stateRow.issuer) return null
  if (iss === undefined) {
    return stateRow.issSupported
      ? {
          code: "iss_missing",
          message:
            "The authorization server did not say who it is (no iss), though it says it always does. The response cannot be trusted.",
        }
      : null
  }
  if (iss !== stateRow.issuer) {
    return {
      code: "iss_mismatch",
      message: `The sign-in answer came from ${iss}, not from ${stateRow.issuer} where the sign-in started. It cannot be trusted.`,
    }
  }
  return null
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The provider's code for a verified state: the token exchange and the
 * writes. Shared by the browser callback and a shell's redemption.
 */
async function finalizeOAuth(
  stateRow: typeof mcpOAuthState.$inferSelect,
  code: string,
  actorId: string,
  /** The client's base (mcpOAuthBaseUrl): the redirect_uri the start sent. */
  base: string,
): Promise<FinalizeOutcome> {
  const who = actorId || stateRow.initiatorUserId || null
  const [conn] = await withSystemDb("mcp-oauth-callback-conn", (db) =>
    db.select().from(mcpConnections).where(eq(mcpConnections.id, stateRow.connectionId)),
  )
  if (!conn) {
    await withSystemDb("mcp-oauth-callback-orphan", (db) =>
      db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id)),
    )
    return {
      ok: false,
      status: 410,
      error: { message: "Connection no longer exists", code: "connection_gone" },
    }
  }
  // The sign-in was started for the server the connection pointed at then; a
  // connection re-pointed since must not receive tokens meant for the old one.
  if (stateRow.resource && originOf(stateRow.resource) !== originOf(conn.httpUrl)) {
    await withSystemDb("mcp-oauth-callback-retargeted", (db) =>
      db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id)),
    )
    return {
      ok: false,
      status: 409,
      error: {
        message:
          "The connection's server address changed after this sign-in started. Sign in again.",
        code: "server_changed",
      },
    }
  }

  // The plan THIS state was started with (RFC 9207 mix-up defence): its token
  // endpoint and client, never whatever a later start discovered. A state row
  // written before the plan rode with it falls back to the connection's.
  const pending = stateRow.pendingMetadata ? metadataOf(stateRow.pendingMetadata) : null
  const meta: McpOAuthMetadata = { ...metadataOf(conn.oauthMetadata), ...(pending ?? {}) }
  if (!meta.tokenEndpoint || !meta.clientId) {
    return {
      ok: false,
      status: 400,
      error: {
        message: "OAuth metadata missing tokenEndpoint/clientId — re-run start",
        code: "metadata_missing",
      },
    }
  }

  // The client secret lives only in the encrypted secrets blob (never in
  // plaintext oauth_metadata), and is carried forward into the new blob. A blob
  // that cannot be decrypted is never overwritten.
  let existingSecrets: McpSecretsBlob
  try {
    existingSecrets = decryptSecretsBlobForWrite(conn.secretsEncrypted)
    if (pending) {
      existingSecrets = {
        ...existingSecrets,
        oauthClientSecret: decryptSecretsBlobForWrite(stateRow.pendingSecretsEncrypted)
          .oauthClientSecret,
      }
    }
  } catch (err) {
    if (!(err instanceof SecretsUnreadableError)) throw err
    return { ok: false, status: 400, error: { message: err.message, code: err.code } }
  }
  const resource = stateRow.resource ?? meta.resource
  const recording = recordingOAuthFetch()
  let fields: ReturnType<typeof persistedTokenFields>
  try {
    const tokens = await exchangeAuthorization(authorizationServerUrlOf(meta), {
      metadata: tokenRequestMetadata(meta),
      clientInformation: clientInformationFor(meta, existingSecrets),
      authorizationCode: code,
      codeVerifier: stateRow.pkceVerifier,
      redirectUri: callbackUrl(base),
      ...(resource ? { resource } : {}),
      fetchFn: recording.fetchFn,
    })
    fields = persistedTokenFields(tokens, null)
  } catch (err) {
    const codeName =
      err instanceof UnsafeOAuthUrlError ? "unsafe_token_endpoint" : "token_exchange_failed"
    log.error(
      { err, connectionId: conn.id, status: recording.last.status },
      "oauth token exchange failed",
    )
    return {
      ok: false,
      status: 502,
      error: {
        message: `The token exchange failed${recording.last.status ? ` (HTTP ${recording.last.status})` : ""}: ${(err as Error).message}`,
        code: codeName,
      },
    }
  }
  const raw = recording.last.body ?? {}
  const subject =
    (typeof raw.sub === "string" ? raw.sub : undefined) ??
    (typeof raw.subject === "string" ? raw.subject : undefined)

  await withPrivilegedDb(conn.orgId, "mcp-oauth-callback-finalize", async (db) => {
    // An edit (or a refresh) may have written the blob since it was read above:
    // take the connection's lock and merge the new tokens onto the current one.
    await db.execute(advisoryXactLock(`mcp-oauth-refresh:${conn.id}`))
    const [current] = await db
      .select({ secretsEncrypted: mcpConnections.secretsEncrypted })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, conn.id))
    const newSecrets: McpSecretsBlob = {
      ...decryptSecretsBlobForWrite(current?.secretsEncrypted ?? null),
      // The client secret this sign-in was started with, when it carried one.
      ...(pending ? { oauthClientSecret: existingSecrets.oauthClientSecret } : {}),
      accessToken: fields.accessToken,
      refreshToken: fields.refreshToken,
    }
    const newMeta: McpOAuthMetadata = {
      ...meta,
      subject,
      scope: fields.scope ?? stateRow.scope ?? meta.scope,
      expiresAt: fields.expiresAt,
      // A sign-in answers any step-up that was pending.
      requiredScope: undefined,
    }
    await db
      .update(mcpConnections)
      .set({
        secretsEncrypted: encryptSecretsBlob(newSecrets),
        oauthMetadata: newMeta as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(mcpConnections.id, conn.id))
    // A new sign-in clears "Sign in again".
    await db
      .insert(mcpConnectionHealth)
      .values({ connectionId: conn.id, status: "idle", lastError: null, consecutiveFailures: 0 })
      .onConflictDoUpdate({
        target: mcpConnectionHealth.connectionId,
        set: { status: "idle", lastError: null, consecutiveFailures: 0, updatedAt: new Date() },
      })
    await db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id))
    await db.queueEvent({
      app: "mcp_manager",
      entity: "connection",
      action: "oauth_completed",
      entityId: conn.id,
      orgId: conn.orgId,
      // The browser callback carries no session: the person who started the
      // flow is the actor (an empty id made the audit insert fail, row lost).
      actorId: who,
      actorType: who ? "user" : "system",
      data: { slug: conn.slug, subject: subject ?? null },
    })
  })
  // The live transport and cached credentials hold the previous token.
  await invalidateMcpConnection(conn.id, { healthStatus: "idle" })

  return { ok: true, connectionId: conn.id, orgId: conn.orgId, displayName: conn.displayName }
}

export const mcpManagerOAuthRoutes = new Hono<AppEnv>()
  .post("/connections/:id/oauth/start", async (c) => {
    const id = c.req.param("id")
    const actor = actorFromCtx(c)
    // Org writers may authorize any connection; a member (personal scope) only
    // their own personal one, which RLS alone lets them load (P3-T1).
    if (!canWriteConnection("personal", actor.scopes) && !canWriteConnection("org", actor.scopes)) {
      throw new PermissionDeniedError({ missingScope: PERSONAL_CONNECTION_WRITE_SCOPE })
    }
    const [conn] = await withRlsContext(actor, (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    if (!conn) return c.json({ error: { message: "Connection not found", code: "not_found" } }, 404)
    if (!canWriteConnection(conn.ownershipScope, actor.scopes)) {
      throw new PermissionDeniedError({ missingScope: ORG_CONNECTION_WRITE_SCOPE })
    }
    if (conn.authFlavor !== "oauth_dcr" && conn.authFlavor !== "oauth_static") {
      return c.json(
        {
          error: {
            message: "OAuth flow only valid for oauth_dcr or oauth_static authFlavor",
            code: "invalid_auth_flavor",
          },
        },
        400,
      )
    }
    if (!conn.httpUrl) {
      return c.json({ error: { message: "Connection has no httpUrl", code: "missing_url" } }, 400)
    }

    // A desktop or mobile shell binds the flow to itself (shell-connect.ts):
    // the cookie below could never be stored on its cross-site fetch.
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const client = parseConnectClient(body, isAppOriginRequest(c))
    if (client.kind === "invalid") {
      return c.json({ error: { message: client.message, code: "invalid_client" } }, 400)
    }
    const shellFlow = client.kind === "shell" ? client.flow : null

    const existingMeta = metadataOf(conn.oauthMetadata)
    let existingSecrets: McpSecretsBlob
    try {
      existingSecrets = decryptSecretsBlobForWrite(conn.secretsEncrypted)
    } catch (err) {
      if (!(err instanceof SecretsUnreadableError)) throw err
      log.warn({ connectionId: id }, "MCP OAuth start refused: secrets blob cannot be decrypted")
      return c.json({ error: { message: err.message, code: err.code } }, 409)
    }
    let plan: AuthorizationPlan
    try {
      plan = await planAuthorization(
        { authFlavor: conn.authFlavor, httpUrl: conn.httpUrl },
        existingMeta,
        existingSecrets,
        mcpOAuthBaseUrl(c),
      )
    } catch (err) {
      const refusal = startRefusal(err)
      if (!refusal) throw err
      log.warn(
        { connectionId: id, refusal: refusal.code },
        `MCP OAuth start refused: ${refusal.message}`,
      )
      return c.json({ error: { message: refusal.message, code: refusal.code } }, refusal.status)
    }

    const state = crypto.randomBytes(24).toString("base64url")
    let started: { authorizationUrl: URL; codeVerifier: string }
    try {
      started = await startAuthorization(plan.authorizationServerUrl, {
        metadata: plan.metadata,
        clientInformation: { client_id: plan.client.clientId },
        redirectUrl: callbackUrl(mcpOAuthBaseUrl(c)),
        state,
        // Verbatim: a re-serialised URL would gain a trailing slash.
        resource: plan.resource,
        ...(plan.scope ? { scope: plan.scope } : {}),
      })
    } catch (err) {
      return c.json(
        {
          error: {
            message: `The authorization server cannot be used: ${(err as Error).message}`,
            code: "authorization_unsupported",
          },
        },
        502,
      )
    }
    const expiresAt = new Date(Date.now() + STATE_TTL_MS)

    // The plan rides with its state row and reaches the connection only when
    // this state's callback succeeds: an abandoned sign-in never changes where
    // the live tokens are refreshed, and a code is exchanged with the endpoint
    // and client its own authorization request used. oauth_metadata carries
    // only non-secret fields; a client secret (a DCR registration's) is kept
    // encrypted.
    const pendingMetadata: McpOAuthMetadata = {
      clientId: plan.client.clientId,
      clientIdSource: plan.client.source,
      ...(plan.client.source === "dcr" && plan.issuer ? { clientIssuer: plan.issuer } : {}),
      ...(plan.issuer ? { issuer: plan.issuer } : {}),
      authorizationServerUrl: plan.authorizationServerUrl,
      authorizationEndpoint: plan.metadata.authorization_endpoint,
      tokenEndpoint: plan.metadata.token_endpoint,
      ...(plan.metadata.registration_endpoint
        ? { registrationEndpoint: plan.metadata.registration_endpoint }
        : {}),
      tokenEndpointAuthMethod:
        plan.client.tokenEndpointAuthMethod ??
        selectClientAuthMethod(
          { client_id: plan.client.clientId, client_secret: plan.client.clientSecret },
          plan.metadata.token_endpoint_auth_methods_supported ?? [],
        ),
      resource: plan.resource,
    }

    // mcp_oauth_state is privileged-only (default-deny on liaison_rls), written
    // through the privileged path with org binding.
    await withPrivilegedDb(actor.orgId, "mcp-oauth-start", async (db) => {
      await db.insert(mcpOAuthState).values({
        connectionId: id,
        pkceVerifier: started.codeVerifier,
        state,
        // Bind to the initiating session so the callback can verify it's the
        // same actor completing the flow (review B5).
        initiatorUserId: actor.userId,
        initiatorOrgId: actor.orgId,
        expiresAt,
        // What the authorization request is bound to (RFC 9207 / RFC 8707).
        issuer: plan.issuer,
        resource: plan.resource,
        scope: plan.scope ?? null,
        issSupported: plan.issSupported,
        pendingMetadata: pendingMetadata as Record<string, unknown>,
        pendingSecretsEncrypted: encryptSecretsBlob({
          oauthClientSecret: plan.client.clientSecret,
        }),
      })
    })

    // The callback is an unauthenticated browser redirect, so the browser that
    // started the flow carries the proof (see lib/oauth-browser-binding.ts),
    // or, for a shell, the verifier only the shell holds.
    if (shellFlow) {
      await rememberShellFlow(state, shellFlow)
    } else if (connectBindingEnabled()) {
      setConnectBindingCookie(c, MCP_BINDING_COOKIE, MCP_OAUTH_CALLBACK_PATH, state)
    }
    return c.json({ authorizationUrl: started.authorizationUrl.toString() })
  })
  .get("/oauth/callback", async (c) => {
    // No requireScope: the issuer redirects the browser here. We bind the request
    // to the actor by looking up the state row; the connection's RLS guarantees
    // no cross-org capture.
    const code = c.req.query("code")
    const state = c.req.query("state")
    const iss = c.req.query("iss")
    const providerError = c.req.query("error")
    // A flow a desktop or mobile app started is told in that app, through its
    // handoff link, not on a page of a browser it may not use.
    if (providerError && state) {
      const shell = await takeShellFlow(state)
      if (shell) {
        await withSystemDb("mcp-oauth-callback-refused", (db) =>
          db.delete(mcpOAuthState).where(eq(mcpOAuthState.state, state)),
        )
        return desktopHandoffResponse(
          c,
          { error: providerError.slice(0, 200) },
          shell.returnState,
          "connect",
        )
      }
    }
    if (providerError) {
      const description = c.req.query("error_description")
      return callbackError(c, 400, {
        code: "provider_error",
        message: `The server refused the sign-in: ${providerError.slice(0, 100)}${description ? ` (${description.slice(0, 200)})` : ""}.`,
      })
    }
    if (!code || !state) {
      return callbackError(c, 400, { message: "Missing code or state", code: "bad_callback" })
    }

    // The state value is the security check — unguessable random +
    // connection-bound. Read privileged (default-deny RLS on the state table).
    const actor = maybeActorFromCtx(c)
    const [stateRow] = await withSystemDb("mcp-oauth-callback-state", (db) =>
      db.select().from(mcpOAuthState).where(eq(mcpOAuthState.state, state)),
    )
    if (!stateRow) {
      log.warn({ state }, "oauth callback rejected — state not found / mismatch")
      return callbackError(c, 400, { message: "Invalid or expired state", code: "state_mismatch" })
    }
    // Host binding: the callback lands on the org host the flow started on (its
    // redirect_uri); another org's host leaves the state for its own browser.
    if (stateRow.initiatorOrgId && !(await hostAllowsOrg(c, stateRow.initiatorOrgId))) {
      log.warn({ stateId: stateRow.id }, "oauth callback rejected — another org's host")
      return callbackError(c, 400, { message: "Invalid or expired state", code: "state_mismatch" })
    }
    if (stateRow.expiresAt < new Date()) {
      await withSystemDb("mcp-oauth-callback-stale", (db) =>
        db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id)),
      )
      return callbackError(c, 400, { message: "State expired", code: "state_expired" })
    }
    // RFC 9207, before anything is completed or parked for a shell.
    const issRefusal = issProblem(stateRow, iss)
    if (issRefusal) {
      await withSystemDb("mcp-oauth-callback-iss", (db) =>
        db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id)),
      )
      await takeShellFlow(state)
      log.warn(
        { stateId: stateRow.id, refusal: issRefusal.code },
        "oauth callback rejected — authorization response issuer",
      )
      return callbackError(c, 400, issRefusal)
    }
    // A shell's flow is parked, not completed: the handoff page sends the
    // browser back to the app, which redeems the code with its verifier and its
    // own session (POST /oauth/handoff). The state row stays until then.
    const shell = await takeShellFlow(state)
    if (shell) {
      if (!stateRow.initiatorUserId || !stateRow.initiatorOrgId) {
        return callbackError(c, 400, {
          message: "Invalid or expired state",
          code: "state_mismatch",
        })
      }
      const handoffCode = await parkConnectHandoff<McpHandoffRecord>(
        {
          record: {
            orgId: stateRow.initiatorOrgId,
            userId: stateRow.initiatorUserId,
            stateId: stateRow.id,
          },
          providerCode: code,
          callbackParams: iss ? { iss } : {},
          codeChallenge: shell.codeChallenge,
        },
        "mcp",
      )
      return desktopHandoffResponse(c, { code: handoffCode }, shell.returnState, "connect")
    }
    // Browser binding: the state is also bound to the browser that started the
    // flow, so a forwarded authorize link cannot be completed by someone else.
    if (
      connectBindingEnabled() &&
      !connectBindingMatches(c.req.header("cookie"), MCP_BINDING_COOKIE, state)
    ) {
      await withSystemDb("mcp-oauth-callback-unbound", (db) =>
        db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id)),
      )
      log.warn({ stateId: stateRow.id }, "oauth callback rejected — not the initiating browser")
      return callbackError(c, 403, {
        message:
          "This authorization was not started in this browser. Start the connection again from your own session.",
        code: "browser_mismatch",
      })
    }
    // Initiator binding (review B5): reject the callback when the current
    // session is present AND doesn't match the actor who started the flow. An
    // absent session is the expected browser-redirect case.
    if (stateRow.initiatorUserId && actor.userId && actor.userId !== stateRow.initiatorUserId) {
      log.warn(
        {
          stateId: stateRow.id,
          initiatorUserId: stateRow.initiatorUserId,
          currentUserId: actor.userId,
        },
        "oauth callback rejected — session actor does not match initiator",
      )
      return callbackError(c, 403, {
        message:
          "OAuth callback session does not match the user who initiated the flow. Re-run OAuth from your own session.",
        code: "actor_mismatch",
      })
    }

    const done = await finalizeOAuth(stateRow, code, actor.userId, mcpOAuthBaseUrl(c))
    if (!done.ok) return callbackError(c, done.status, done.error)
    const nameKey = await rememberDonePageName(done.displayName)
    const returnUrl = `${(await orgPublicBaseUrl(done.orgId)).replace(/\/$/, "")}/api/apps/mcp-manager/oauth/done?connection=${done.connectionId}${nameKey ? `&done=${nameKey}` : ""}&oauth=ok`
    return c.redirect(returnUrl, 302)
  })
  // The add flow's first step: what signing in to this server will take,
  // before anything is created or registered.
  .post("/probe", async (c) => {
    const actor = actorFromCtx(c)
    if (!canWriteConnection("personal", actor.scopes) && !canWriteConnection("org", actor.scopes)) {
      throw new PermissionDeniedError({ missingScope: PERSONAL_CONNECTION_WRITE_SCOPE })
    }
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const url = typeof body.url === "string" ? body.url.trim() : ""
    try {
      validateOutboundUrlNoDns(url, {
        requireHttps: true,
        allowPrivateHostsInTest: mcpAllowsPrivateTargets(),
      })
    } catch (err) {
      const message = err instanceof UnsafeOutboundUrlError ? err.message : "not a valid URL"
      return c.json(
        { error: { message: `Invalid server URL: ${message}`, code: "invalid_url" } },
        400,
      )
    }
    const result = await probeServer(url, mcpOAuthBaseUrl(c))
    if ("error" in result) return c.json({ error: result.error }, 422)
    return c.json({ data: result })
  })
  // A shell redeeming the sign-in it started: the one-time code from its
  // `liaison://oauth-complete` link, with the PKCE verifier only it holds. The
  // session must be the one that started the flow (claimConnectHandoff).
  .post("/oauth/handoff", async (c) => {
    const actor = actorFromCtx(c)
    if (!canWriteConnection("personal", actor.scopes) && !canWriteConnection("org", actor.scopes)) {
      throw new PermissionDeniedError({ missingScope: PERSONAL_CONNECTION_WRITE_SCOPE })
    }
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    let handoff: Awaited<ReturnType<typeof claimConnectHandoff<McpHandoffRecord>>>
    try {
      handoff = await claimConnectHandoff<McpHandoffRecord>(
        {
          code: body.code,
          codeVerifier: body.code_verifier,
          orgId: actor.orgId,
          userId: actor.userId,
        },
        "mcp",
      )
    } catch (err) {
      if (err instanceof ConnectHandoffRefusedError) {
        log.warn(
          "MCP sign-in handoff refused: unknown, replayed or foreign code, or a wrong verifier",
        )
        return c.json({ error: { message: err.message, code: err.code } }, 400)
      }
      throw err
    }
    const [stateRow] = await withSystemDb("mcp-oauth-handoff-state", (db) =>
      db.select().from(mcpOAuthState).where(eq(mcpOAuthState.id, handoff.record.stateId)),
    )
    if (!stateRow || stateRow.expiresAt < new Date()) {
      if (stateRow) {
        await withSystemDb("mcp-oauth-handoff-stale", (db) =>
          db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id)),
        )
      }
      return c.json({ error: { message: "State expired", code: "state_expired" } }, 400)
    }
    // The callback checked `iss` before parking; the parked value is checked
    // again so the redemption stands on its own.
    const issRefusal = issProblem(stateRow, handoff.callbackParams.iss)
    if (issRefusal) return c.json({ error: issRefusal }, 400)
    const done = await finalizeOAuth(
      stateRow,
      handoff.providerCode,
      actor.userId,
      mcpOAuthBaseUrl(c),
    )
    if (!done.ok) return c.json({ error: done.error }, done.status)
    return c.json({ data: { connectionId: done.connectionId } })
  })

// `/oauth/done` is the same-host HTML success page the callback 302s to.
// Wrapping it on the Hono chain so the URL is API-served and Playwright sees
// the `oauth=ok` query string land in the address bar. The route is reachable
// from anywhere on the open web (no auth, no state binding), so it reads no
// database row: the server's name comes from the key the callback stored it
// under (`done`, rememberDonePageName), a random value only the redirected
// browser holds. Anything else in the query string is ignored and never echoed
// into the page (review B4); without a valid key the page says "Server connected".
mcpManagerOAuthRoutes.get("/oauth/done", async (c) => {
  // The title names the server ("Notion connected"). The name was read from the
  // connection row by the callback, never taken from the query string, so a
  // crafted link cannot put its own words on this page; it is escaped like
  // every other value.
  const serverName = await readDonePageName(c.req.query("done") ?? "")
  const html = renderCallbackPage({
    kind: "ok",
    locale: localeFromAcceptLanguage(c.req.header("accept-language")),
    serverName,
  })
  return c.html(html, 200, { ...CALLBACK_PAGE_HEADERS })
})

// The Client ID Metadata Document: with CIMD the client ID IS this URL, and the
// MCP server's authorization server fetches it (no session, so app.ts lets it
// past the bearer chain). Served only when BASE_URL is public HTTPS: a
// localhost instance could not be fetched, and advertises nothing.
mcpManagerOAuthRoutes.get("/oauth/client-metadata.json", (c) => {
  const base = mcpOAuthBaseUrl(c)
  if (!cimdDocumentUrl(base)) {
    return c.json({ error: { message: "Not found", code: "not_found" } }, 404)
  }
  return c.json(clientMetadataDocument(base), 200, { "Cache-Control": "public, max-age=300" })
})

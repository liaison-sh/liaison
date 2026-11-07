// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash as nodeCreateHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createProviderSchema } from "@liaison/shared"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { JSONWebKeySet } from "jose"
import { decodeJwt } from "jose"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { oauthAccounts, oauthProviders, organizations, roles, users } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret, encryptSecret, generateToken } from "~/lib/crypto"
import { encryptionKey, env } from "~/lib/env"
import { isPrivateIp } from "~/lib/ip-classify"
import { authLogger as log } from "~/lib/logger"
import {
  oauthStateFor,
  oauthStatePrefixed,
  oauthStateSlug,
  stateSlugFitsHost,
} from "~/lib/oauth-state"
import {
  assertHostAllowsOrg,
  hostBindingEnabled,
  requestHostBinding,
  signInOrgSlug,
} from "~/lib/org-host"
import { oauthRedirectBaseUrl } from "~/lib/org-public-url"
import {
  fetchWithRedirectValidation,
  UnsafeOutboundUrlError,
  validateOutboundUrl,
} from "~/lib/outbound-fetch"
import { redis } from "~/lib/redis"
import {
  hostOnlyCookies,
  readCookie,
  requestRefreshTokenDelivery,
  setRefreshTokenCookie,
  success,
} from "~/lib/response"
import { issueToken as issueRedisToken } from "~/lib/token-store"
import { zValidator } from "~/lib/validate"
import { createSession } from "~/modules/auth/auth"
import {
  DESKTOP_EXCHANGE_CODE_TTL_SECONDS,
  type DesktopFlow,
  desktopFlowOf,
  desktopHandoffResponse,
  mintExchangeCode,
  parseAuthorizeClient,
  verifyS256,
  WEB_EXCHANGE_CODE_TTL_SECONDS,
} from "~/modules/auth/desktop-oauth"
import { isFirstPartyGoogleProvider, jwksUriForIssuer } from "~/modules/auth/google-login-provider"
import { autoProvisionUser, OAuthEmailTakenError } from "~/modules/auth/oauth"
import { orgAccess } from "~/modules/cloud/suspension"
import { isDemoOrgId } from "~/modules/demo/demo-org"
import { CapLimitError } from "~/modules/org/caps"
import { actorCoversRole } from "~/modules/permissions/roles"
import { noteSignIn } from "~/modules/security/admin-signin"

/**
 * The browser-binding cookie of a login OAuth flow. `__Host-` in production
 * (https only, this exact host, no Domain, Path=/), so a sibling subdomain
 * cannot plant it; the plain name, scoped to the callback, over dev http.
 */
export function oauthStateCookieSpec(isProd: boolean): { name: string; path: string } {
  return isProd
    ? { name: "__Host-oauth_state", path: "/" }
    : { name: "__oauth_state", path: "/api/auth/oauth/callback" }
}

/**
 * Where a LOGIN flow's state waits for its callback. Its own namespace: the
 * connection flows (`/api/connections/callback`) keep theirs under
 * `oauth:state:`, and a state minted by one flow must never be readable, or
 * consumable, by the other's callback.
 */
export const LOGIN_OAUTH_STATE_PREFIX = "oauth:login-state"
export function loginStateKey(state: string): string {
  return `${LOGIN_OAUTH_STATE_PREFIX}:${state}`
}

/**
 * Login error for a verified provider email that already belongs to an account
 * this identity is not linked to. The web login page allowlists this exact text.
 */
export const OAUTH_EXISTING_ACCOUNT_ERROR =
  "An account with this email exists. Sign in with your existing method"

/**
 * What a one-time code stands for while it waits to be exchanged: a session, or,
 * for an account with two-factor sign-in on, the TOTP challenge that has to be
 * answered before any session exists (the same challenge password and magic
 * link sign-in hand over).
 */
export type ExchangePayload = (
  | { accessToken: string; refreshToken?: string }
  | { challengeToken: string }
) & {
  /**
   * The desktop app's PKCE challenge, when the code was minted for it: the
   * code is then released only against the matching `code_verifier`. A web
   * code has none and is redeemed as it always was.
   */
  codeChallenge?: string
}

/** The value stored under the code. Both sides of the hand-off use these two. */
export function serializeExchangePayload(payload: ExchangePayload): string {
  return JSON.stringify(payload)
}

/**
 * Reads it back. A bare string is a code minted by an earlier build (or by a
 * caller that only ever had an access token), so it is an access token and
 * nothing else rather than an error: codes live 30 seconds, and a deploy must
 * not sign out whoever is mid-login.
 */
export function parseExchangePayload(stored: string): ExchangePayload {
  try {
    const parsed = JSON.parse(stored) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = parsed as Record<string, unknown>
      const codeChallenge =
        typeof candidate.codeChallenge === "string"
          ? { codeChallenge: candidate.codeChallenge }
          : {}
      if (typeof candidate.challengeToken === "string") {
        return { challengeToken: candidate.challengeToken, ...codeChallenge }
      }
      if (typeof candidate.accessToken === "string") {
        return {
          accessToken: candidate.accessToken,
          refreshToken:
            typeof candidate.refreshToken === "string" ? candidate.refreshToken : undefined,
          ...codeChallenge,
        }
      }
    }
  } catch {
    // Not JSON: the legacy shape below.
  }
  return { accessToken: stored }
}

/** How long the TOTP challenge an OAuth sign-in ends in stays answerable. */
const OAUTH_TOTP_CHALLENGE_TTL_SECONDS = 300

/**
 * The end of every successful OAuth sign-in. An account with two-factor
 * sign-in on gets NO session here: the code stands for a TOTP challenge, and
 * the session is minted only once `/totp/verify` accepts the second factor,
 * exactly as after a password or a magic link. Everyone else gets the session.
 */
async function signInWithOAuth(
  c: Context<AppEnv>,
  userId: string,
  orgId: string,
  returnState: string | undefined,
  desktop: DesktopFlow | null,
): Promise<Response> {
  // Host binding (lib/org-host.ts): a sign-in into org A completes only on A's host.
  await assertHostAllowsOrg(c, orgId)
  const [user] = await withSystemDb("oauth-callback-totp-check", (db) =>
    db.select({ totpEnabled: users.totpEnabled }).from(users).where(eq(users.id, userId)).limit(1),
  )
  if (user?.totpEnabled) {
    const challengeToken = await issueRedisToken(
      redis,
      "challenge",
      { userId },
      OAUTH_TOTP_CHALLENGE_TTL_SECONDS,
    )
    return redirectWithOneTimeCode(c, { challengeToken }, returnState, desktop)
  }
  const tokens = await createSession(userId, orgId)
  await noteSignIn(c, tokens, "oauth")
  return redirectWithOneTimeCode(c, tokens, returnState, desktop)
}

async function redirectWithOneTimeCode(
  c: Context<AppEnv>,
  outcome: { accessToken: string; refreshToken: string } | { challengeToken: string },
  returnState?: string,
  desktop?: DesktopFlow | null,
): Promise<Response> {
  const payload: ExchangePayload =
    "challengeToken" in outcome
      ? { challengeToken: outcome.challengeToken }
      : { accessToken: outcome.accessToken, refreshToken: outcome.refreshToken }
  if (desktop) {
    // THE DESKTOP APP'S CODE. This response is shown in the user's own
    // browser, not in the app, so it sets NO refresh cookie: the app gets its
    // refresh token in the body of the exchange it makes with its own origin,
    // and a cookie here would only leave a second, unasked-for web session in
    // a browser the user may share. The code is bound to the app's PKCE
    // challenge, so the link that carries it is worthless to anyone else, and
    // it lives long enough for the browser's "Open Liaison?" prompt
    // (desktop-oauth.ts, DESKTOP_EXCHANGE_CODE_TTL_SECONDS).
    const code = mintExchangeCode()
    await redis.set(
      `oauth:exchange:${code}`,
      serializeExchangePayload({ ...payload, codeChallenge: desktop.codeChallenge }),
      "EX",
      DESKTOP_EXCHANGE_CODE_TTL_SECONDS,
    )
    return desktopHandoffResponse(c, { code }, returnState)
  }
  // THE COOKIE STAYS ON THIS RESPONSE, on every origin. This is a redirect at
  // the end of a TOP LEVEL navigation: the user agent sends no Origin a wrapped
  // shell could be recognised by, so there is nothing here to decide on. The
  // shells get their copy one step later, from /oauth/exchange, which the page
  // calls with its own Origin (lib/response.ts holds the rule). A pending TOTP
  // challenge has no session yet, so it sets no cookie.
  if (!("challengeToken" in outcome)) setRefreshTokenCookie(c, outcome.refreshToken)
  // Store the session behind a one-time code (30s TTL) — never exposed in URL.
  // The refresh token rides with it because a shell has no other way to reach
  // one: same random 32 byte code, same single `getdel`, same 30 seconds.
  const code = mintExchangeCode()
  await redis.set(
    `oauth:exchange:${code}`,
    serializeExchangePayload(payload),
    "EX",
    WEB_EXCHANGE_CODE_TTL_SECONDS,
  )
  // Echo the caller's opaque `state` back to the SPA so OAuthComplete can match it
  // against the value it stashed in sessionStorage (login-CSRF / fixation guard).
  const stateParam = returnState ? `&state=${encodeURIComponent(returnState)}` : ""
  return c.redirect(`/login/oauth-complete?code=${code}${stateParam}`)
}

/**
 * A sign-in that ended without a session. The web flow goes back to its login
 * page with the reason, as it always has. A desktop flow is in the user's
 * browser, where that page would be a second Liaison the user never asked
 * for: it goes back to the APP instead, with the same reason and the app's own
 * `state`, and the app's login card says it.
 */
function failSignIn(
  c: Context<AppEnv>,
  error: string,
  returnState: string | undefined,
  desktop: DesktopFlow | null,
): Response {
  if (desktop) return desktopHandoffResponse(c, { error }, returnState)
  return c.redirect(`/login?error=${encodeURIComponent(error)}`)
}

/** What a desktop flow reads when the failure is not one it can name. */
const OAUTH_FAILED_ERROR = "OAuth authentication failed"

export { isPrivateIp }

async function validateOidcUrl(url: string): Promise<void> {
  try {
    await validateOutboundUrl(url, { requireHttps: true, allowPrivateHostsInTest: true })
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new HTTPException(502, { message: err.message })
    }
    throw err
  }
}

async function safeOauthFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchWithRedirectValidation(url, init, {
      requireHttps: true,
      allowPrivateHostsInTest: true,
    })
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new HTTPException(502, { message: err.message })
    }
    throw err
  }
}

async function fetchValidatedJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await safeOauthFetch(url, init)
  if (!response.ok) {
    throw new HTTPException(502, { message: `Upstream request failed (${response.status})` })
  }
  return (await response.json()) as T
}

/**
 * Verify an OIDC id_token JWT using the provider's JWKS.
 * Falls back to decode-only in test environment (mock OIDC servers may not have JWKS).
 */
async function verifyIdToken(
  idToken: string,
  jwksUri: string | undefined,
  expectedIssuer: string,
  expectedAudience: string,
): Promise<Record<string, any>> {
  const parts = idToken.split(".")
  if (parts.length !== 3) throw new HTTPException(502, { message: "Malformed id_token" })

  // In test env, decode without verification (mock OIDC servers may not have JWKS)
  if (env.NODE_ENV === "test") {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  }

  // In non-test mode, JWKS URI is required for signature verification
  if (!jwksUri) {
    throw new HTTPException(502, { message: "Provider missing jwks_uri — cannot verify id_token" })
  }

  try {
    const { createLocalJWKSet, jwtVerify } = await import("jose")
    const jwks = await fetchValidatedJson(jwksUri)
    const JWKS = createLocalJWKSet(jwks as JSONWebKeySet)
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: expectedIssuer,
      audience: expectedAudience,
    })
    return payload as Record<string, any>
  } catch (err) {
    log.warn({ err }, "id_token signature verification failed")
    throw new HTTPException(502, { message: "Identity token verification failed" })
  }
}

/** Minimal typed interfaces for OIDC responses — replaces `as any` casts */
interface OIDCDiscoveryDocument {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri?: string
}

interface TokenResponse {
  access_token: string
  id_token?: string
  token_type: string
  expires_in?: number
  refresh_token?: string
}

interface UserInfo {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  [key: string]: unknown
}

export const oauth = new Hono<AppEnv>()

// Public endpoint: list available OAuth providers (for login page).
// Requires orgSlug query param to scope to a single org — prevents cross-org enumeration.
oauth.get("/providers", async (c) => {
  // With org hosts the host names the org; a query slug that disagrees is a 400.
  const orgSlug = signInOrgSlug(c, c.req.query("orgSlug"))
  let org: { id: string } | undefined
  if (orgSlug) {
    ;[org] = await withSystemDb("oauth-providers-org-lookup", (db) =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, orgSlug))
        .limit(1),
    )
  } else {
    const orgs = await withSystemDb("oauth-providers-single-tenant", (db) =>
      db.select({ id: organizations.id }).from(organizations).limit(2),
    )
    if (orgs.length === 1) org = orgs[0]
  }
  if (!org) return success(c, [])
  // Nobody signs in to a closed org, so its login page offers no provider. Self-hosted: no query.
  if ((await orgAccess(org.id)) === "refused") return success(c, [])

  const providers = await withSystemDb("oauth-providers-list", (db) =>
    db
      .select({ id: oauthProviders.id, name: oauthProviders.name })
      .from(oauthProviders)
      .where(
        and(
          eq(oauthProviders.orgId, org!.id),
          // Exclude per-connection app OAuth clients (shopify:shop, social:meta, ...)
          // -- they live in this table for the flow lookup but are NOT SSO login providers.
          drizzleSql`${oauthProviders.issuerUrl} NOT LIKE 'https://app-connection.invalid/%'`,
        ),
      ),
  )
  return success(c, providers)
})

// Admin routes for managing OAuth providers
export const oauthAdmin = new Hono<AppEnv>()

const RESERVED_INTEGRATION_PROVIDER_NAMES = new Set(["gmail", "mail:gmail", "google"])

oauthAdmin.get("/", async (c) => {
  const orgId = c.get("orgId")

  const providers = await withPrivilegedDb(orgId, "oauth-admin-list-providers", async (db) => {
    const base = await db
      .select({
        id: oauthProviders.id,
        name: oauthProviders.name,
        issuerUrl: oauthProviders.issuerUrl,
        scopes: oauthProviders.scopes,
        autoProvision: oauthProviders.autoProvision,
        createdAt: oauthProviders.createdAt,
        updatedAt: oauthProviders.updatedAt,
      })
      .from(oauthProviders)
      .where(
        and(
          eq(oauthProviders.orgId, orgId),
          // Exclude per-connection app OAuth clients -- not SSO login providers.
          drizzleSql`${oauthProviders.issuerUrl} NOT LIKE 'https://app-connection.invalid/%'`,
        ),
      )
      .orderBy(oauthProviders.name)

    if (base.length === 0) return []

    const accountCounts = await db
      .select({
        providerId: oauthAccounts.providerId,
        count: drizzleSql<number>`COUNT(*)::int`,
      })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.orgId, orgId))
      .groupBy(oauthAccounts.providerId)

    const countByProvider = new Map(accountCounts.map((row) => [row.providerId, row.count]))
    return base.map((provider) => ({
      ...provider,
      configured: true,
      connectedAccountCount: countByProvider.get(provider.id) ?? 0,
    }))
  })

  return success(c, providers)
})

oauthAdmin.post("/", zValidator("json", createProviderSchema), async (c) => {
  const body = c.req.valid("json")
  const orgId = c.get("orgId")

  if (RESERVED_INTEGRATION_PROVIDER_NAMES.has(body.name.trim().toLowerCase())) {
    throw new HTTPException(400, {
      message:
        "Google app integrations are configured from Settings > Administration > Integrations, not OAuth Providers",
    })
  }

  // Auto-provisioning creates an account in the "member" role for every new
  // sign-in the provider vouches for: as good as inviting with that role, so the
  // registering admin must already be able to grant what it carries.
  if (body.autoProvision) {
    const covered = await withPrivilegedDb(orgId, "oauth-register-provider-role", async (db) => {
      const [member] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.name, "member")))
        .limit(1)
      if (!member) return "ok" as const
      return actorCoversRole(db, member.id, c.get("scopes"), c.get("dimensionGrants"))
    })
    if (covered !== "ok") {
      throw new HTTPException(403, {
        message:
          "Auto-provisioning gives new accounts the member role, which grants more than you hold",
      })
    }
  }

  // Validate issuer URL before fetching (SSRF protection — also checks HTTPS)
  await validateOidcUrl(body.issuerUrl)

  // Fetch and validate OIDC discovery once at registration time.
  // Store endpoints so callbacks use pre-validated URLs — never re-discover at callback time.
  let discovery: OIDCDiscoveryDocument
  try {
    discovery = await fetchValidatedJson<OIDCDiscoveryDocument>(
      `${body.issuerUrl}/.well-known/openid-configuration`,
    )
  } catch (err) {
    if (err instanceof HTTPException) throw err
    throw new HTTPException(502, { message: "Failed to fetch OIDC discovery document" })
  }

  // Validate all endpoint URLs at registration time
  await validateOidcUrl(discovery.authorization_endpoint)
  await validateOidcUrl(discovery.token_endpoint)
  if (discovery.userinfo_endpoint) await validateOidcUrl(discovery.userinfo_endpoint)

  const [provider] = await withPrivilegedDb(orgId, "oauth-register-provider", (db) =>
    db
      .insert(oauthProviders)
      .values({
        orgId,
        name: body.name,
        issuerUrl: body.issuerUrl,
        authorizationEndpoint: discovery.authorization_endpoint,
        tokenEndpoint: discovery.token_endpoint,
        userinfoEndpoint: discovery.userinfo_endpoint ?? null,
        clientId: body.clientId,
        clientSecretEncrypted: encryptSecret(
          body.clientSecret,
          encryptionKey,
          CryptoContext.oauthProviderClientSecret,
        ),
        scopes: body.scopes ?? "openid email profile",
        autoProvision: body.autoProvision ?? false,
      })
      .returning(),
  )

  log.info({ providerId: provider.id, name: body.name }, "OAuth provider registered")

  return success(c, { id: provider.id, name: provider.name })
})

oauthAdmin.delete(
  "/:providerId",
  zValidator("param", z.object({ providerId: z.string().uuid() })),
  async (c) => {
    const orgId = c.get("orgId")
    const { providerId } = c.req.valid("param")

    const deleted = await withPrivilegedDb(orgId, "oauth-admin-delete-provider", async (db) =>
      db
        .delete(oauthProviders)
        .where(and(eq(oauthProviders.id, providerId), eq(oauthProviders.orgId, orgId)))
        .returning({ id: oauthProviders.id }),
    )

    if (deleted.length === 0) throw new HTTPException(404, { message: "Provider not found" })
    return success(c, { deleted: true })
  },
)

/** The redirect_uri of every sign-in flow: the authorize URL and the code exchange send the same. */
function signInRedirectUri(): string {
  return `${oauthRedirectBaseUrl()}/api/auth/oauth/callback`
}

/** The slug of the org a sign-in provider belongs to. */
async function orgSlugOf(orgId: string): Promise<string | undefined> {
  const [org] = await withSystemDb("oauth-authorize-org-slug", (db) =>
    db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return org?.slug
}

// GET /api/auth/oauth/:providerId/authorize
oauth.get("/:providerId/authorize", async (c) => {
  const providerId = c.req.param("providerId")
  const orgSlug = signInOrgSlug(c, c.req.query("orgSlug"))
  // The desktop app's system-browser flow (desktop-oauth.ts). Checked before
  // anything is looked up or stored: a malformed desktop request is refused
  // outright rather than run as a web flow without the PKCE binding.
  const client = parseAuthorizeClient({
    client: c.req.query("client"),
    codeChallenge: c.req.query("code_challenge"),
    codeChallengeMethod: c.req.query("code_challenge_method"),
    state: c.req.query("state"),
  })
  if (client.kind === "invalid") throw new HTTPException(400, { message: client.message })
  const desktop = client.kind === "desktop" ? client.flow : undefined

  // Build query — scope by org when provided to prevent cross-org provider use
  const conditions = [eq(oauthProviders.id, providerId)]
  if (orgSlug) {
    const [org] = await withSystemDb("oauth-authorize-org", (db) =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, orgSlug))
        .limit(1),
    )
    if (!org) throw new HTTPException(404, { message: "Provider not found" })
    conditions.push(eq(oauthProviders.orgId, org.id))
  }

  const [provider] = await withSystemDb("oauth-authorize-provider", (db) =>
    db
      .select()
      .from(oauthProviders)
      .where(and(...conditions))
      .limit(1),
  )

  if (!provider) throw new HTTPException(404, { message: "Provider not found" })

  // Use stored authorization endpoint (validated at provider registration — DNS rebinding protection)
  const authorizationEndpoint = provider.authorizationEndpoint ?? `${provider.issuerUrl}/authorize`

  // With a central redirect host the state names the org, so that host can
  // send the browser back to the org's own host (lib/oauth-state.ts); the
  // record keeps the slug for the callback to check the prefix against.
  const stateSlug = oauthStatePrefixed() ? (orgSlug ?? (await orgSlugOf(provider.orgId))) : orgSlug
  const state = oauthStateFor(stateSlug, generateToken(16))
  const codeVerifier = randomBytes(32).toString("base64url")
  const codeChallenge = nodeCreateHash("sha256").update(codeVerifier).digest("base64url")
  const nonce = randomBytes(16).toString("base64url")
  // The SPA passes its own opaque `state` (stashed in sessionStorage) so it can
  // verify the round-trip on /login/oauth-complete. Thread it through to the
  // callback (kept distinct from the OAuth-protocol `state` above, which is
  // cookie-bound). Bounded to avoid unbounded storage.
  const returnState = (c.req.query("state") ?? "").slice(0, 128) || undefined
  await redis.set(
    loginStateKey(state),
    JSON.stringify({ providerId, codeVerifier, nonce, returnState, desktop, orgSlug: stateSlug }),
    "EX",
    600,
  )

  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: signInRedirectUri(),
    response_type: "code",
    scope: provider.scopes ?? "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    nonce,
  })

  // Bind state to browser session via cookie to prevent login CSRF.
  // An attacker cannot trick a victim into completing a flow they didn't initiate.
  const stateHash = nodeCreateHash("sha256").update(state).digest("hex")
  // In production a __Host- cookie: a sibling subdomain cannot plant one, so it
  // cannot bind this browser to a flow the sibling started (oauthStateCookieSpec).
  const stateCookie = oauthStateCookieSpec(hostOnlyCookies())
  c.header(
    "Set-Cookie",
    `${stateCookie.name}=${stateHash}; HttpOnly; SameSite=Lax; Path=${stateCookie.path}; Max-Age=600${hostOnlyCookies() ? "; Secure" : ""}`,
  )

  return c.redirect(`${authorizationEndpoint}?${params}`)
})

// GET /api/auth/oauth/callback
oauth.get("/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state")
  if (!code || !state) {
    // THE USER SAID NO AT THE PROVIDER (or it failed): it comes back with an
    // `error` and our state instead of a code. The web flow answers that as it
    // always has. A desktop flow is waiting in the app, so it is told, rather
    // than left on a "continue in your browser" card with nothing coming. The
    // state is PEEKED first so a web flow's record is left exactly as it was.
    const desktopCancel = state ? await desktopFlowFor(state) : null
    if (
      state &&
      desktopCancel &&
      c.req.query("error") &&
      stateSlugFitsHost(state, requestHostBinding(c))
    ) {
      await redis.del(loginStateKey(state))
      return desktopHandoffResponse(c, { error: OAUTH_FAILED_ERROR }, desktopCancel.returnState)
    }
    throw new HTTPException(400, { message: "Missing code or state" })
  }

  // A state of another org's flow (or one missing its org prefix) is refused
  // before it is spent: its own browser can still finish on its own host.
  if (!stateSlugFitsHost(state, requestHostBinding(c))) {
    throw new HTTPException(400, { message: "Invalid state" })
  }

  // Atomic claim: getdel retrieves and deletes in one operation to prevent TOCTOU races
  const stateData = await redis.getdel(loginStateKey(state))
  if (!stateData) throw new HTTPException(400, { message: "Invalid state" })
  const claimed = JSON.parse(stateData) as {
    desktop?: unknown
    returnState?: string
    orgSlug?: string
  }
  if (oauthStatePrefixed() && claimed.orgSlug !== oauthStateSlug(state)) {
    throw new HTTPException(400, { message: "Invalid state" })
  }
  const desktop = desktopFlowOf(claimed.desktop)
  if (!desktop) return completeCallback(c, code, state, stateData, null)
  // A DESKTOP FLOW ALWAYS ENDS IN THE APP. Past this point every failure the
  // web flow answers with a JSON error in the browser (an upstream token or
  // userinfo failure, a mismatched nonce) would leave the app waiting on a
  // sign-in that is never coming, so it is handed back as a failure instead.
  try {
    return await completeCallback(c, code, state, stateData, desktop)
  } catch (err) {
    log.warn({ err }, "Desktop OAuth callback failed; handing the failure back to the app")
    return desktopHandoffResponse(c, { error: OAUTH_FAILED_ERROR }, claimed.returnState)
  }
})

/** The desktop flow a state record belongs to, read WITHOUT claiming it. */
async function desktopFlowFor(
  state: string,
): Promise<{ flow: DesktopFlow; returnState: string | undefined } | null> {
  const raw = await redis.get(loginStateKey(state))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { desktop?: unknown; returnState?: unknown }
    const flow = desktopFlowOf(parsed.desktop)
    if (!flow) return null
    return {
      flow,
      returnState: typeof parsed.returnState === "string" ? parsed.returnState : undefined,
    }
  } catch {
    return null
  }
}

async function completeCallback(
  c: Context<AppEnv>,
  code: string,
  state: string,
  stateData: string,
  desktop: DesktopFlow | null,
): Promise<Response> {
  // Verify state is bound to this browser session (login CSRF prevention).
  // Checked after state validation so invalid/replayed states fail fast with the
  // original error. Cookie binding prevents a login CSRF where an attacker tricks
  // a victim's browser into completing an OAuth flow they didn't initiate.
  const cookieHeader = c.req.header("cookie") ?? ""
  const oauthStateCookie = readCookie(cookieHeader, oauthStateCookieSpec(hostOnlyCookies()).name)
  const expectedStateHash = nodeCreateHash("sha256").update(state).digest("hex")
  if (
    !oauthStateCookie ||
    !/^[a-f0-9]{64}$/.test(oauthStateCookie) ||
    !timingSafeEqual(Buffer.from(oauthStateCookie, "hex"), Buffer.from(expectedStateHash, "hex"))
  ) {
    throw new HTTPException(400, { message: "Invalid OAuth state — session mismatch" })
  }
  const { providerId, codeVerifier, nonce, returnState } = JSON.parse(stateData) as {
    providerId: string
    codeVerifier: string
    nonce?: string
    returnState?: string
  }

  const [provider] = await withSystemDb("oauth-callback-provider", (db) =>
    db.select().from(oauthProviders).where(eq(oauthProviders.id, providerId)).limit(1),
  )
  if (!provider) throw new HTTPException(400, { message: "Provider not found" })

  // Use stored endpoints (set at registration time for DNS rebinding protection).
  // No fallback to re-discovery — all providers have stored endpoints.
  const tokenEndpoint = provider.tokenEndpoint
  const userinfoEndpoint = provider.userinfoEndpoint
  if (!tokenEndpoint) {
    throw new HTTPException(502, {
      message: "Provider missing stored endpoints — please re-register the OAuth provider",
    })
  }

  const clientSecret = decryptSecret(
    provider.clientSecretEncrypted,
    encryptionKey,
    CryptoContext.oauthProviderClientSecret,
  )

  // Exchange code for tokens
  const tokenRes = await safeOauthFetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: provider.clientId,
      client_secret: clientSecret,
      redirect_uri: signInRedirectUri(),
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenRes.ok) throw new HTTPException(502, { message: "Token exchange failed" })
  const idpTokens = (await tokenRes.json()) as TokenResponse

  // Validate id_token if present (OIDC-compliant providers always include it)
  let idTokenPayload: Record<string, any> | null = null
  if (idpTokens.id_token) {
    // Verify signature via JWKS, then validate claims (issuer, audience, expiry).
    // Resolve the JWKS URI from the stored issuer (Google uses a non-conventional path).
    const jwksUri = jwksUriForIssuer(provider.issuerUrl)
    idTokenPayload = await verifyIdToken(
      idpTokens.id_token,
      jwksUri,
      provider.issuerUrl,
      provider.clientId,
    )

    // Validate nonce to prevent replay attacks
    if (nonce && idTokenPayload.nonce !== nonce) {
      throw new HTTPException(502, { message: "Identity token nonce mismatch" })
    }

    // jose.jwtVerify checks iss/aud/exp in production; in test mode, check manually
    if (env.NODE_ENV === "test") {
      if (idTokenPayload.iss !== provider.issuerUrl) {
        log.warn(
          { expected: provider.issuerUrl, got: idTokenPayload.iss },
          "id_token issuer mismatch",
        )
        throw new HTTPException(502, { message: "Identity token issuer mismatch" })
      }
      const aud = Array.isArray(idTokenPayload.aud) ? idTokenPayload.aud : [idTokenPayload.aud]
      if (!aud.includes(provider.clientId)) {
        log.warn(
          { expected: provider.clientId, got: idTokenPayload.aud },
          "id_token audience mismatch",
        )
        throw new HTTPException(502, { message: "Identity token audience mismatch" })
      }
      if (idTokenPayload.exp && idTokenPayload.exp < Math.floor(Date.now() / 1000)) {
        throw new HTTPException(502, { message: "Identity token expired" })
      }
    }
  }

  // Fetch userinfo using stored endpoint
  if (!userinfoEndpoint) {
    throw new HTTPException(502, {
      message: "Provider missing stored userinfo endpoint — please re-register the OAuth provider",
    })
  }
  const userinfoRes = await safeOauthFetch(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${idpTokens.access_token}` },
  })
  if (!userinfoRes.ok) throw new HTTPException(502, { message: "Userinfo fetch failed" })
  const userinfo = (await userinfoRes.json()) as UserInfo

  // Use id_token claims as authoritative (they're signed, unlike userinfo).
  // Override userinfo with id_token claims where available.
  // When id_token is absent the identity is unverified — reject provisioning paths
  // to prevent a compromised access token from creating or linking accounts.
  if (idTokenPayload) {
    if (idTokenPayload.sub) userinfo.sub = idTokenPayload.sub
    if (idTokenPayload.email) userinfo.email = idTokenPayload.email
    if (idTokenPayload.email_verified !== undefined)
      userinfo.email_verified = idTokenPayload.email_verified
  } else {
    // No signed id_token — clear email_verified so auto-provision and email-collision
    // paths cannot proceed on unverified identity claims.
    userinfo.email_verified = false
    log.warn(
      { providerId: provider.id },
      "OAuth callback received no id_token — treating identity as unverified",
    )
  }

  // Look up or create user
  const [existingLink] = await withSystemDb("oauth-callback-link-check", (db) =>
    db
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.providerId, provider.id),
          eq(oauthAccounts.externalSubject, userinfo.sub),
        ),
      )
      .limit(1),
  )

  if (existingLink) {
    const [linkedUser] = await withSystemDb("oauth-callback-linked-user", (db) =>
      db.select().from(users).where(eq(users.id, existingLink.userId)).limit(1),
    )
    // Only an active account signs in (a suspended one included).
    if (linkedUser?.status !== "active") {
      return desktop
        ? failSignIn(c, "Account deactivated", returnState, desktop)
        : c.redirect("/login?error=Account+deactivated")
    }
    return signInWithOAuth(c, existingLink.userId, provider.orgId, returnState, desktop)
  }

  // First-party env-configured Google: link a verified email DIRECTLY to the
  // matching existing active (invited) user and sign them in. Only the
  // operator-configured Google provider is trusted this way. Invited-users-only:
  // an unknown email is rejected (no auto-provision).
  // NOT in a demo org. Demo signup takes an email address with no round trip
  // (see modules/demo/routes.ts), so a demo account's address is unverified: a
  // stranger could pre-create "victim@example.com" there and have the victim's
  // verified Google sign-in linked into it. Real deployments only create
  // accounts for addresses the owner proved (an emailed invite token) or an
  // operator named, so the link-by-email rule stands there.
  if (
    isFirstPartyGoogleProvider(provider) &&
    userinfo.email &&
    userinfo.email_verified === true &&
    !(await isDemoOrgId(provider.orgId))
  ) {
    const linkedUserId = await withPrivilegedDb(
      provider.orgId,
      "oauth-callback-trusted-google-link",
      async (tx) => {
        const [u] = await tx
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(
            and(eq(users.orgId, provider.orgId), eq(users.email, userinfo.email!.toLowerCase())),
          )
          .for("update")
          .limit(1)
        if (!u || u.status !== "active") return null
        // Idempotent against a concurrent callback (unique on providerId+subject).
        await tx
          .insert(oauthAccounts)
          .values({
            orgId: provider.orgId,
            userId: u.id,
            providerId: provider.id,
            externalSubject: userinfo.sub,
            externalEmail: userinfo.email,
            externalProfile: userinfo,
          })
          .onConflictDoNothing()
        return u.id
      },
    )
    if (linkedUserId) {
      return signInWithOAuth(c, linkedUserId, provider.orgId, returnState, desktop)
    }
    // No matching active user: fall through to the existing-account check below.
  }

  // Never link a provider identity to an existing account on email alone. Apart
  // from the trusted first-party Google case above, a verified email that
  // matches an existing user fails closed: the user signs in with the method
  // the account already has. Checked before auto-provisioning so an existing
  // email is never re-provisioned.
  if (userinfo.email && userinfo.email_verified === true) {
    const [existingUser] = await withSystemDb("oauth-callback-email-check", (db) =>
      db
        .select({ status: users.status })
        .from(users)
        .where(and(eq(users.orgId, provider.orgId), eq(users.email, userinfo.email!.toLowerCase())))
        .limit(1),
    )
    if (existingUser) {
      if (existingUser.status === "deactivated") {
        return desktop
          ? failSignIn(c, "Account deactivated", returnState, desktop)
          : c.redirect("/login?error=Account+deactivated")
      }
      log.info(
        { providerId: provider.id, userStatus: existingUser.status },
        "OAuth login refused: email belongs to an existing account without this identity linked",
      )
      return failSignIn(c, OAUTH_EXISTING_ACCOUNT_ERROR, returnState, desktop)
    }
  }

  if (provider.autoProvision && userinfo.email && userinfo.email_verified === true) {
    // Rate limit auto-provisioning: max 10 per provider per hour
    const autoProvRateKey = `oauth:autoprov:${provider.id}`
    const autoProvCount = await redis.incr(autoProvRateKey)
    if (autoProvCount === 1) await redis.expire(autoProvRateKey, 3600)
    if (autoProvCount > 10) {
      log.warn(
        { providerId: provider.id, count: autoProvCount },
        "Auto-provision rate limit exceeded",
      )
      return desktop
        ? failSignIn(c, "Auto provision rate limit", returnState, desktop)
        : c.redirect("/login?error=Auto+provision+rate+limit")
    }

    let newUser: { id: string }
    try {
      newUser = await withRlsContext(
        { actorType: "system", orgId: provider.orgId, purpose: "webhook", scopes: ["kernel"] },
        async (tx) => {
          const user = await autoProvisionUser(tx, {
            orgId: provider.orgId,
            email: userinfo.email!,
            name: userinfo.name ?? userinfo.email!,
            providerId: provider.id,
            externalSubject: userinfo.sub,
            externalEmail: userinfo.email!,
            externalProfile: userinfo,
          })
          await tx.queueEvent({
            app: "kernel",
            entity: "user",
            action: "registered",
            orgId: provider.orgId,
            actorType: "system",
            entityId: user.id,
            data: {
              method: "oauth_auto_provision",
              email: userinfo.email,
              provider: provider.name,
            },
          })
          return user
        },
      )
    } catch (err) {
      // Created between the check above and this insert: refused the same way.
      if (err instanceof OAuthEmailTakenError) {
        return failSignIn(c, OAUTH_EXISTING_ACCOUNT_ERROR, returnState, desktop)
      }
      // Every seat of the org is taken (modules/org/caps.ts).
      if (err instanceof CapLimitError) {
        log.info(
          { providerId: provider.id, ...err.details },
          "OAuth auto-provision refused: seat limit",
        )
        return failSignIn(c, err.message, returnState, desktop)
      }
      throw err
    }

    return signInWithOAuth(c, newUser.id, provider.orgId, returnState, desktop)
  }

  return desktop
    ? failSignIn(c, "No matching account", returnState, desktop)
    : c.redirect("/login?error=No+matching+account")
}

// ── One-time code exchange — frontend calls this to retrieve the access token ──

const exchangeBody = z.object({
  code: z.string(),
  // The desktop app's PKCE verifier. Bounded here; its shape and its match
  // are checked against the code's own challenge below.
  code_verifier: z.string().max(128).optional(),
})

oauth.post("/exchange", zValidator("json", exchangeBody), async (c) => {
  const { code, code_verifier: codeVerifier } = c.req.valid("json")
  const stored = await redis.getdel(`oauth:exchange:${code}`)
  if (!stored) {
    throw new HTTPException(400, { message: "Invalid or expired code" })
  }
  const session = parseExchangePayload(stored)
  // A CODE MINTED FOR THE DESKTOP APP IS RELEASED ONLY TO THE DESKTOP APP.
  // It was claimed by the getdel above whatever happens next, so a wrong or
  // missing verifier fails closed: the code is gone and nothing was released.
  if (session.codeChallenge !== undefined && !verifyS256(codeVerifier, session.codeChallenge)) {
    log.warn("OAuth exchange refused: the code verifier does not match its challenge")
    throw new HTTPException(400, { message: "Invalid or expired code" })
  }
  // THE STEP THAT HAS AN ORIGIN. This one is a fetch from the page, so the
  // shells are recognisable here exactly as they are on login and refresh, and
  // they are answered the same way: the token in the body, no cookie of their
  // own. A browser keeps the cookie the redirect already set.
  // Two-factor sign-in is on: the code was the first factor only. The caller
  // answers the challenge at /totp/verify, as after a password or a magic link.
  if ("challengeToken" in session) {
    return success(c, { totpRequired: true, challengeToken: session.challengeToken })
  }
  // Host binding: the session is redeemed on its own org's host only.
  if (hostBindingEnabled()) {
    let orgId: unknown
    try {
      orgId = decodeJwt(session.accessToken).orgId
    } catch {
      orgId = undefined
    }
    if (typeof orgId !== "string") throw new HTTPException(401, { message: "Unauthorized" })
    await assertHostAllowsOrg(c, orgId)
  }
  const delivery = requestRefreshTokenDelivery(c)
  if (delivery.body && session.refreshToken !== undefined) {
    return success(c, { accessToken: session.accessToken, refreshToken: session.refreshToken })
  }
  return success(c, { accessToken: session.accessToken })
})

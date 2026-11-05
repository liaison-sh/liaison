// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { encryptionKey, env } from "~/lib/env"
import { authLogger as log } from "~/lib/logger"

// Google's OIDC endpoints. `issuerUrl` is the canonical `iss` claim value; the
// other endpoints are fixed and pre-validated (no discovery fetch at callback).
export const GOOGLE_ISSUER = "https://accounts.google.com"
export const GOOGLE_AUTHZ_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"
// Google serves its JWKS at a non-conventional path (NOT issuer/.well-known/jwks.json).
export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs"
export const GOOGLE_LOGIN_PROVIDER_NAME = "Google"

/** Deployment-scoped Google login credentials — overridable for tests. */
export interface GoogleLoginCreds {
  clientId?: string
  clientSecret?: string
}

function resolveCreds(
  override?: GoogleLoginCreds,
): { clientId: string; clientSecret: string } | null {
  const clientId = override?.clientId ?? env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = override?.clientSecret ?? env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

/**
 * Ensure `orgId` has a first-party Google login provider row matching the
 * deployment-scoped `GOOGLE_OAUTH_*` credentials. Idempotent: inserts on first
 * run, refreshes client id/secret/endpoints on later runs (e.g. after a
 * credential rotation, or an admin's edit). Writes nothing when the stored row
 * already matches. No-op when Google login isn't configured.
 *
 * `autoProvision` is false — Google signs in existing (invited) users only; the
 * OAuth callback links a verified Google email to the matching account and
 * rejects unknown addresses.
 */
export async function ensureGoogleLoginProvider(
  orgId: string,
  override?: GoogleLoginCreds,
): Promise<void> {
  const creds = resolveCreds(override)
  if (!creds) return
  const { clientId } = creds
  const desired: ProviderFields = {
    name: GOOGLE_LOGIN_PROVIDER_NAME,
    clientId,
    authorizationEndpoint: GOOGLE_AUTHZ_ENDPOINT,
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
    userinfoEndpoint: GOOGLE_USERINFO_ENDPOINT,
    scopes: "openid email profile",
    autoProvision: false,
  }

  const wrote = await withPrivilegedDb(orgId, "ensure-google-login-provider", async (tx) => {
    // An org's create and its first sign-in can land here together; no unique key says one row.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`liaison:google-login:${orgId}`}))`)
    const [existing] = await tx
      .select({
        id: oauthProviders.id,
        name: oauthProviders.name,
        clientId: oauthProviders.clientId,
        clientSecretEncrypted: oauthProviders.clientSecretEncrypted,
        authorizationEndpoint: oauthProviders.authorizationEndpoint,
        tokenEndpoint: oauthProviders.tokenEndpoint,
        userinfoEndpoint: oauthProviders.userinfoEndpoint,
        scopes: oauthProviders.scopes,
        autoProvision: oauthProviders.autoProvision,
      })
      .from(oauthProviders)
      .where(and(eq(oauthProviders.orgId, orgId), eq(oauthProviders.issuerUrl, GOOGLE_ISSUER)))
      .limit(1)

    if (existing && isCurrent(existing, desired, creds.clientSecret)) return false
    const clientSecretEncrypted = encryptSecret(
      creds.clientSecret,
      encryptionKey,
      CryptoContext.oauthProviderClientSecret,
    )
    if (existing) {
      await tx
        .update(oauthProviders)
        .set({ ...desired, clientSecretEncrypted, updatedAt: new Date() })
        .where(eq(oauthProviders.id, existing.id))
    } else {
      await tx
        .insert(oauthProviders)
        .values({ orgId, issuerUrl: GOOGLE_ISSUER, ...desired, clientSecretEncrypted })
    }
    return true
  })
  if (!wrote) return
  log.info({ orgId }, "Google login provider ensured")
}

type ProviderFields = {
  name: string
  clientId: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  scopes: string
  autoProvision: boolean
}

/** The stored row already carries the desired fields and secret (an undecryptable secret is not current). */
function isCurrent(
  row: { [K in keyof ProviderFields]: ProviderFields[K] | null } & {
    clientSecretEncrypted: string
  },
  desired: ProviderFields,
  clientSecret: string,
): boolean {
  const fields = Object.keys(desired) as (keyof ProviderFields)[]
  if (fields.some((k) => row[k] !== desired[k])) return false
  try {
    return (
      decryptSecret(
        row.clientSecretEncrypted,
        encryptionKey,
        CryptoContext.oauthProviderClientSecret,
      ) === clientSecret
    )
  } catch {
    return false
  }
}

/**
 * True when `provider` is the deployment-configured first-party Google provider
 * (Google issuer AND its client id matches the current `GOOGLE_OAUTH_CLIENT_ID`).
 * Only this provider is trusted to link a verified Google email directly to an
 * existing active user. Admin-registered third-party OIDC providers never link
 * by email: a login whose email matches an existing account is refused.
 */
export function isFirstPartyGoogleProvider(
  provider: { issuerUrl: string; clientId: string },
  override?: GoogleLoginCreds,
): boolean {
  const creds = resolveCreds(override)
  return !!creds && provider.issuerUrl === GOOGLE_ISSUER && provider.clientId === creds.clientId
}

/** Resolve the JWKS URI for an OIDC issuer, special-casing Google's non-conventional path. */
export function jwksUriForIssuer(issuerUrl: string): string {
  if (issuerUrl === GOOGLE_ISSUER) return GOOGLE_JWKS_URI
  return `${issuerUrl}/.well-known/jwks.json`
}

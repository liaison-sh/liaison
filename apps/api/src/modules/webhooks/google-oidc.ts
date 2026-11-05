// SPDX-License-Identifier: FSL-1.1-ALv2
import * as jose from "jose"

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
const GOOGLE_ISSUER = "https://accounts.google.com"

let cachedJwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null
let cachedJwksUrl: string | null = null

function getJwks(jwksUrl: string) {
  if (cachedJwks && cachedJwksUrl === jwksUrl) return cachedJwks
  cachedJwks = jose.createRemoteJWKSet(new URL(jwksUrl), {
    cooldownDuration: 30_000,
    cacheMaxAge: 24 * 60 * 60 * 1000,
  })
  cachedJwksUrl = jwksUrl
  return cachedJwks
}

export type VerifyGoogleOidcOptions = {
  expectedAudience: string
  expectedServiceAccount: string
  issuer?: string
  jwksUrl?: string
  clockToleranceSeconds?: number
}

export type VerifyGoogleOidcResult = {
  valid: boolean
  sub?: string
  aud?: string
  iss?: string
  reason?: string
}

export async function verifyGoogleOidcJwt(
  token: string,
  opts: VerifyGoogleOidcOptions,
): Promise<VerifyGoogleOidcResult> {
  if (!token) return { valid: false, reason: "no_token" }
  const jwks = getJwks(opts.jwksUrl ?? GOOGLE_JWKS_URL)
  try {
    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer: opts.issuer ?? GOOGLE_ISSUER,
      audience: opts.expectedAudience,
      clockTolerance: `${opts.clockToleranceSeconds ?? 60}s`,
    })
    const sub = String(payload.sub ?? "")
    const email = typeof payload.email === "string" ? payload.email : undefined
    const matchedSub = sub === opts.expectedServiceAccount || email === opts.expectedServiceAccount
    if (!matchedSub)
      return {
        valid: false,
        sub,
        aud: String(payload.aud),
        iss: String(payload.iss),
        reason: "subject_mismatch",
      }
    return {
      valid: true,
      sub,
      aud:
        typeof payload.aud === "string"
          ? payload.aud
          : Array.isArray(payload.aud)
            ? payload.aud[0]
            : undefined,
      iss: typeof payload.iss === "string" ? payload.iss : undefined,
    }
  } catch (err) {
    return { valid: false, reason: (err as Error).message }
  }
}

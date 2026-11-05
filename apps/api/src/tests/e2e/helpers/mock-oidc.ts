// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import * as jose from "jose"

let privateKey: CryptoKey
let publicJwk: jose.JWK

let ISSUER = "http://localhost:4580"
const mockApp = new Hono()

// State storage for authorization flow
interface CodeData {
  state: string
  email: string
  sub: string
  nonce?: string
}
const codes = new Map<string, CodeData>()
const tokenUserMap = new Map<string, { email: string; sub: string }>()

async function ensureKeys() {
  if (privateKey) return
  const { privateKey: priv, publicKey: pub } = await jose.generateKeyPair("RS256")
  privateKey = priv as CryptoKey
  publicJwk = await jose.exportJWK(pub)
  publicJwk.kid = "test-key-1"
  publicJwk.alg = "RS256"
  publicJwk.use = "sig"
}

mockApp.get("/.well-known/openid-configuration", (c) => {
  return c.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    jwks_uri: `${ISSUER}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  })
})

mockApp.get("/jwks", async (c) => {
  await ensureKeys()
  return c.json({ keys: [publicJwk] })
})

mockApp.get("/authorize", (c) => {
  const state = c.req.query("state") ?? ""
  const redirectUri = c.req.query("redirect_uri") ?? ""
  const email = c.req.query("login_hint") ?? "oauth-user@e2e.test"
  const sub = c.req.query("sub_hint") ?? "mock-user-001"
  const nonce = c.req.query("nonce")
  const code = `mock-auth-code-${Date.now()}`
  codes.set(code, { state, email, sub, nonce })

  const redirectUrl = new URL(redirectUri)
  redirectUrl.searchParams.set("code", code)
  redirectUrl.searchParams.set("state", state)
  return c.redirect(redirectUrl.toString())
})

mockApp.post("/token", async (c) => {
  await ensureKeys()
  const body = await c.req.parseBody()
  const code = body.code as string

  if (!code || !codes.has(code)) {
    return c.json({ error: "invalid_grant" }, 400)
  }
  const codeData = codes.get(code)!
  codes.delete(code)

  const accessToken = `mock-access-token-${codeData.sub}`
  tokenUserMap.set(accessToken, { email: codeData.email, sub: codeData.sub })

  // Sign a real id_token JWT (include nonce if provided for replay protection)
  const idToken = await new jose.SignJWT({
    sub: codeData.sub,
    email: codeData.email,
    email_verified: true,
    name: `User ${codeData.sub}`,
    ...(codeData.nonce ? { nonce: codeData.nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(ISSUER)
    .setAudience("test-client")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey)

  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    id_token: idToken,
    expires_in: 3600,
  })
})

mockApp.get("/userinfo", (c) => {
  const auth = c.req.header("Authorization") ?? ""
  const token = auth.replace("Bearer ", "")
  const userData = tokenUserMap.get(token)

  return c.json({
    sub: userData?.sub ?? "mock-user-001",
    email: userData?.email ?? "oauth-user@e2e.test",
    email_verified: true,
    name: userData ? `User ${userData.sub}` : "OAuth User",
  })
})

export async function startMockOidc(port: number): Promise<{ url: string; stop: () => void }> {
  ISSUER = `http://localhost:${port}`
  await ensureKeys()
  const server = Bun.serve({
    fetch: mockApp.fetch,
    port,
  })

  return {
    url: ISSUER,
    stop: () => server.stop(true),
  }
}

/**
 * Signs an arbitrary OIDC-style JWT against the mock issuer's keys. Used by
 * E2E tests that need to drive the real Gmail Push verifier with valid Google
 * Pub/Sub envelopes — the verifier's JWKS URL is overridden to point at this
 * mock server, and the signed token here verifies against the same key set.
 */
export async function signMockOidcToken(payload: {
  audience: string
  subject: string
  email?: string
  expiresIn?: string
  issuer?: string
}): Promise<string> {
  await ensureKeys()
  return new jose.SignJWT(payload.email ? { email: payload.email } : {})
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(payload.issuer ?? ISSUER)
    .setAudience(payload.audience)
    .setSubject(payload.subject)
    .setIssuedAt()
    .setExpirationTime(payload.expiresIn ?? "5m")
    .sign(privateKey)
}

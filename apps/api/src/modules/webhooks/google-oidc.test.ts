// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import * as jose from "jose"
import { verifyGoogleOidcJwt } from "./google-oidc"

let server: ReturnType<typeof Bun.serve> | null = null
let issuer: string
let privateKey: CryptoKey
const SERVICE_ACCOUNT = "test-svc@test.iam.gserviceaccount.com"

beforeAll(async () => {
  const { privateKey: priv, publicKey } = await jose.generateKeyPair("RS256")
  privateKey = priv as CryptoKey
  const pubJwk = await jose.exportJWK(publicKey)
  pubJwk.kid = "test-1"
  pubJwk.alg = "RS256"
  pubJwk.use = "sig"

  const app = new Hono()
  app.get("/jwks", (c) => c.json({ keys: [pubJwk] }))

  server = Bun.serve({ fetch: app.fetch, port: 0 })
  const port = server.port
  issuer = `http://localhost:${port}`
})

afterAll(() => {
  server?.stop(true)
})

async function signToken(opts: {
  aud?: string
  iss?: string
  sub?: string
  email?: string
  expDelta?: string
}): Promise<string> {
  const builder = new jose.SignJWT({ email: opts.email })
    .setProtectedHeader({ alg: "RS256", kid: "test-1" })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? "https://test.aud")
    .setSubject(opts.sub ?? SERVICE_ACCOUNT)
    .setIssuedAt()
    .setExpirationTime(opts.expDelta ?? "5m")
  return builder.sign(privateKey)
}

describe("verifyGoogleOidcJwt", () => {
  it("accepts valid signature/aud/sub", async () => {
    const token = await signToken({})
    const r = await verifyGoogleOidcJwt(token, {
      expectedAudience: "https://test.aud",
      expectedServiceAccount: SERVICE_ACCOUNT,
      issuer,
      jwksUrl: `${issuer}/jwks`,
    })
    expect(r.valid).toBe(true)
    expect(r.sub).toBe(SERVICE_ACCOUNT)
  })

  it("rejects wrong audience", async () => {
    const token = await signToken({})
    const r = await verifyGoogleOidcJwt(token, {
      expectedAudience: "https://wrong.aud",
      expectedServiceAccount: SERVICE_ACCOUNT,
      issuer,
      jwksUrl: `${issuer}/jwks`,
    })
    expect(r.valid).toBe(false)
  })

  it("rejects subject mismatch", async () => {
    const token = await signToken({ sub: "other-sub" })
    const r = await verifyGoogleOidcJwt(token, {
      expectedAudience: "https://test.aud",
      expectedServiceAccount: SERVICE_ACCOUNT,
      issuer,
      jwksUrl: `${issuer}/jwks`,
    })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe("subject_mismatch")
  })

  it("accepts when email claim matches expected service account", async () => {
    const token = await signToken({ sub: "other", email: SERVICE_ACCOUNT })
    const r = await verifyGoogleOidcJwt(token, {
      expectedAudience: "https://test.aud",
      expectedServiceAccount: SERVICE_ACCOUNT,
      issuer,
      jwksUrl: `${issuer}/jwks`,
    })
    expect(r.valid).toBe(true)
  })

  it("rejects empty token", async () => {
    const r = await verifyGoogleOidcJwt("", {
      expectedAudience: "x",
      expectedServiceAccount: "y",
    })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe("no_token")
  })
})

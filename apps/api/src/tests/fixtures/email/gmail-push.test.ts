// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import * as jose from "jose"
import { buildGmailPushPayload, getGmailPushPublicJwk } from "./gmail-push"

describe("gmail push payload builder", () => {
  it("builds Pub/Sub push payload with valid OIDC bearer", async () => {
    const r = await buildGmailPushPayload({
      accountEmail: "support@x.test",
      historyId: "42",
      pubsubMessageId: "pm1",
    })
    expect(JSON.parse(Buffer.from(r.body.message.data, "base64").toString())).toEqual({
      emailAddress: "support@x.test",
      historyId: "42",
    })
    expect(r.headers.Authorization).toMatch(/^Bearer /)
    expect(r.body.message.messageId).toBe("pm1")
  })

  it("signs JWT against the exported JWKS", async () => {
    const r = await buildGmailPushPayload({
      accountEmail: "a@x.test",
      historyId: "1",
    })
    const token = r.headers.Authorization.replace("Bearer ", "")
    const jwk = await getGmailPushPublicJwk()
    const key = await jose.importJWK(jwk, "RS256")
    const { payload } = await jose.jwtVerify(token, key, {
      audience: "https://liaison.test/webhooks/gmail-push",
      issuer: "https://accounts.google.com",
    })
    expect(payload.sub).toBe("gmail-api-push@system.gserviceaccount.com")
  })

  it("honors custom audience/issuer/subject", async () => {
    const r = await buildGmailPushPayload({
      accountEmail: "a@x.test",
      historyId: "1",
      audience: "https://custom.test",
      issuer: "https://issuer.test",
      subject: "custom-sub",
    })
    const token = r.headers.Authorization.replace("Bearer ", "")
    const decoded = jose.decodeJwt(token)
    expect(decoded.aud).toBe("https://custom.test")
    expect(decoded.iss).toBe("https://issuer.test")
    expect(decoded.sub).toBe("custom-sub")
  })
})

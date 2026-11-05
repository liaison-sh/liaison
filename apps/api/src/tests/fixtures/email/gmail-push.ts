// SPDX-License-Identifier: FSL-1.1-ALv2
import * as jose from "jose"

const TEST_ISSUER = "https://accounts.google.com"
const TEST_AUDIENCE = "https://liaison.test/webhooks/gmail-push"
const TEST_SUBJECT = "gmail-api-push@system.gserviceaccount.com"

let cachedKeys: { privateKey: CryptoKey; publicJwk: jose.JWK } | null = null

async function getKeys() {
  if (cachedKeys) return cachedKeys
  const { privateKey, publicKey } = await jose.generateKeyPair("RS256")
  const publicJwk = await jose.exportJWK(publicKey)
  publicJwk.kid = "gmail-push-test"
  publicJwk.alg = "RS256"
  publicJwk.use = "sig"
  cachedKeys = { privateKey: privateKey as CryptoKey, publicJwk }
  return cachedKeys
}

export type BuildGmailPushPayloadOptions = {
  accountEmail: string
  historyId: string
  pubsubMessageId?: string
  oidcJwt?: string
  audience?: string
  issuer?: string
  subject?: string
  expiresIn?: string
}

export type GmailPushPayload = {
  headers: Record<string, string>
  body: {
    message: {
      data: string
      messageId: string
      publishTime: string
      attributes?: Record<string, string>
    }
    subscription: string
  }
}

export async function buildGmailPushPayload(
  options: BuildGmailPushPayloadOptions,
): Promise<GmailPushPayload> {
  const data = Buffer.from(
    JSON.stringify({
      emailAddress: options.accountEmail,
      historyId: options.historyId,
    }),
  ).toString("base64")

  let token = options.oidcJwt
  if (!token) {
    const { privateKey } = await getKeys()
    token = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "gmail-push-test" })
      .setIssuer(options.issuer ?? TEST_ISSUER)
      .setAudience(options.audience ?? TEST_AUDIENCE)
      .setSubject(options.subject ?? TEST_SUBJECT)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(privateKey)
  }

  return {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: {
      message: {
        data,
        messageId: options.pubsubMessageId ?? `pm-${Date.now()}`,
        publishTime: new Date().toISOString(),
      },
      subscription: "projects/liaison-test/subscriptions/gmail-push",
    },
  }
}

export async function getGmailPushPublicJwk(): Promise<jose.JWK> {
  const { publicJwk } = await getKeys()
  return publicJwk
}

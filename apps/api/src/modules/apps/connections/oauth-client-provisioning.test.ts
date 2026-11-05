// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Headless per-connection OAuth client provisioning (shopify/social). Proves the
// core round-trip the CLI + UI both depend on: upsert writes an encrypted client
// to kernel.oauth_providers keyed by <app>:<connection>, the status getter reports
// it, re-upsert updates in place, the secret decrypts back, and the sentinel
// issuer marks it so the SSO provider lists exclude it.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { oauthClientResolverRegistry } from "~/modules/apps/app-registries"
import {
  connectionProviderName,
  getConnectionOAuthClient,
  upsertConnectionOAuthClient,
} from "~/modules/apps/connections/oauth-client-provisioning"
import {
  resolveGoogleOAuthClientConfig,
  saveGoogleIntegrationConfig,
} from "~/modules/settings/google-integration"

const TEST_ORG = "00000000-0000-0000-0000-00000000ac01"
const APP = "shopify"
const CONN = "shop"
const NAME = `${APP}:${CONN}`
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? ""

beforeEach(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG}, 'OAuthClient Test Org', 'oauthclient-test-org')
    ON CONFLICT (id) DO NOTHING`
})

afterEach(async () => {
  oauthClientResolverRegistry.delete([TEST_ORG, "tickets", "gmail"])
  await withSystemDb("oauthclient-test-cleanup", (db) =>
    db
      .delete(oauthProviders)
      .where(and(eq(oauthProviders.orgId, TEST_ORG), eq(oauthProviders.name, NAME))),
  )
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("connection OAuth client provisioning", () => {
  it("provider name is <app>:<connection>", () => {
    expect(connectionProviderName("social", "meta")).toBe("social:meta")
  })

  it("upserts (create -> update), reports status, and stores an encrypted secret", async () => {
    // Not configured yet.
    expect(await getConnectionOAuthClient(TEST_ORG, APP, CONN)).toEqual({
      configured: false,
      appManaged: false,
    })

    const first = await upsertConnectionOAuthClient({
      orgId: TEST_ORG,
      appName: APP,
      connectionName: CONN,
      clientId: "client-A",
      clientSecret: "secret-A",
    })
    expect(first.created).toBe(true)

    // Status reports configured + the (non-secret) client id.
    expect(await getConnectionOAuthClient(TEST_ORG, APP, CONN)).toEqual({
      configured: true,
      source: "org",
      clientId: "client-A",
      appManaged: false,
    })

    // The row: encrypted secret decrypts back; sentinel issuer marks it as an
    // app-connection client (so SSO provider lists exclude it); exactly one row.
    const rows = await withSystemDb("oauthclient-test-read", (db) =>
      db
        .select({
          clientId: oauthProviders.clientId,
          clientSecretEncrypted: oauthProviders.clientSecretEncrypted,
          issuerUrl: oauthProviders.issuerUrl,
        })
        .from(oauthProviders)
        .where(and(eq(oauthProviders.orgId, TEST_ORG), eq(oauthProviders.name, NAME))),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].clientId).toBe("client-A")
    expect(rows[0].clientSecretEncrypted).not.toContain("secret-A") // encrypted at rest
    expect(
      decryptSecret(
        rows[0].clientSecretEncrypted,
        ENCRYPTION_KEY,
        CryptoContext.oauthProviderClientSecret,
      ),
    ).toBe("secret-A")
    expect(rows[0].issuerUrl.startsWith("https://app-connection.invalid/")).toBe(true)

    // Re-upsert updates in place (no second row), new id + secret.
    const second = await upsertConnectionOAuthClient({
      orgId: TEST_ORG,
      appName: APP,
      connectionName: CONN,
      clientId: "client-B",
      clientSecret: "secret-B",
    })
    expect(second.created).toBe(false)
    expect(await getConnectionOAuthClient(TEST_ORG, APP, CONN)).toEqual({
      configured: true,
      source: "org",
      clientId: "client-B",
      appManaged: false,
    })
    const after = await withSystemDb("oauthclient-test-read-2", (db) =>
      db
        .select({ clientSecretEncrypted: oauthProviders.clientSecretEncrypted })
        .from(oauthProviders)
        .where(and(eq(oauthProviders.orgId, TEST_ORG), eq(oauthProviders.name, NAME))),
    )
    expect(after).toHaveLength(1)
    expect(
      decryptSecret(
        after[0].clientSecretEncrypted,
        ENCRYPTION_KEY,
        CryptoContext.oauthProviderClientSecret,
      ),
    ).toBe("secret-B")
  })
})

// An app that resolves its own client (`_oauthClientResolvers`: tickets, calendar
// and mail use the org's shared Google client, else the deployment's) used to
// read as "not configured" here because only oauth_providers rows were looked at.
describe("connection OAuth client status with an app resolver", () => {
  const deploymentEnv = {
    GMAIL_OAUTH_CLIENT_ID: "123456789-deploy.apps.googleusercontent.com",
    GMAIL_OAUTH_CLIENT_SECRET: "deployment-secret",
  }
  const registerGoogleResolver = () =>
    oauthClientResolverRegistry.set([TEST_ORG, "tickets", "gmail"], ({ orgId }) =>
      resolveGoogleOAuthClientConfig(orgId, deploymentEnv),
    )

  it("a deployment client with no org row counts as configured, from the deployment", async () => {
    registerGoogleResolver()
    expect(await getConnectionOAuthClient(TEST_ORG, "tickets", "gmail")).toEqual({
      configured: true,
      source: "deployment",
      clientIdHint: "...-deploy",
      appManaged: true,
    })
  })

  it("the org's own shared client reads as the org's", async () => {
    registerGoogleResolver()
    await saveGoogleIntegrationConfig(TEST_ORG, {
      clientId: "987654321-orgown.apps.googleusercontent.com",
      clientSecret: "org-secret",
    })
    expect(await getConnectionOAuthClient(TEST_ORG, "tickets", "gmail")).toEqual({
      configured: true,
      source: "org",
      clientIdHint: "...-orgown",
      appManaged: true,
    })
  })

  it("a resolver that refuses is not configured, with its reason, and never throws", async () => {
    oauthClientResolverRegistry.set([TEST_ORG, "tickets", "gmail"], async () => {
      throw new HTTPException(403, { message: "Gmail is not enabled for this org" })
    })
    expect(await getConnectionOAuthClient(TEST_ORG, "tickets", "gmail")).toEqual({
      configured: false,
      reason: "Gmail is not enabled for this org",
      appManaged: true,
    })
  })

  it("a resolver with nothing on its side leaves the org row in charge", async () => {
    oauthClientResolverRegistry.set([TEST_ORG, "tickets", "gmail"], async () => null)
    // No org row and no deployment client: the test env's own Gmail client must not answer.
    const instanceEnv = env as { GMAIL_OAUTH_CLIENT_ID?: string }
    const saved = instanceEnv.GMAIL_OAUTH_CLIENT_ID
    instanceEnv.GMAIL_OAUTH_CLIENT_ID = undefined
    try {
      expect(await getConnectionOAuthClient(TEST_ORG, "tickets", "gmail")).toEqual({
        configured: false,
        appManaged: false,
      })
    } finally {
      instanceEnv.GMAIL_OAUTH_CLIENT_ID = saved
    }
  })
})

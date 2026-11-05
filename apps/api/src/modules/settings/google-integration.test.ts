// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  getGoogleIntegrationSummary,
  resolveGoogleOAuthClientConfig,
  saveGoogleIntegrationConfig,
} from "~/modules/settings/google-integration"

const configuredEnv = {
  GMAIL_OAUTH_CLIENT_ID: "deployment-client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "deployment-client-secret",
}

const unconfiguredEnv = {
  GMAIL_OAUTH_CLIENT_ID: undefined,
  GMAIL_OAUTH_CLIENT_SECRET: undefined,
}

let orgCounter = 0

function nextOrgId(): string {
  orgCounter += 1
  return `00000000-0000-0000-0000-${String(910000 + orgCounter).padStart(12, "0")}`
}

async function createOrg(orgId: string) {
  await sql`
    INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${orgId}, ${`Google Integration ${orgId}`}, ${`google-integration-${orgId}`})
  `
}

async function cleanupOrg(orgId: string) {
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
}

describe("google integration service", () => {
  it("stores encrypted org-level Google OAuth config and preserves deployment fallback semantics", async () => {
    const orgId = nextOrgId()
    await createOrg(orgId)

    try {
      await expect(getGoogleIntegrationSummary(orgId, unconfiguredEnv)).resolves.toEqual({
        provider: "google",
        configured: false,
        configurationSource: null,
      })

      await saveGoogleIntegrationConfig(orgId, {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      })

      const [row] = (await sql`
        SELECT settings
        FROM kernel.organizations
        WHERE id = ${orgId}
      `) as Array<{ settings: Record<string, any> }>

      expect(row.settings.integrations.google.oauthClient.clientId).toBe("google-client-id")
      expect(row.settings.integrations.google.oauthClient.clientSecretEncrypted).not.toBe(
        "google-client-secret",
      )

      await expect(getGoogleIntegrationSummary(orgId, configuredEnv)).resolves.toEqual({
        provider: "google",
        configured: true,
        configurationSource: "org",
        clientIdHint: "...ient-id",
      })

      await expect(resolveGoogleOAuthClientConfig(orgId, configuredEnv)).resolves.toEqual({
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        source: "org",
      })
    } finally {
      await cleanupOrg(orgId)
    }
  })

  it("uses deployment fallback only when org config is absent", async () => {
    const orgId = nextOrgId()
    await createOrg(orgId)

    try {
      await expect(getGoogleIntegrationSummary(orgId, configuredEnv)).resolves.toEqual({
        provider: "google",
        configured: true,
        configurationSource: "deployment",
        clientIdHint: "...ient-id",
      })

      await expect(resolveGoogleOAuthClientConfig(orgId, configuredEnv)).resolves.toEqual({
        clientId: "deployment-client-id",
        clientSecret: "deployment-client-secret",
        source: "deployment",
      })
    } finally {
      await cleanupOrg(orgId)
    }
  })
})

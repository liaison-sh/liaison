// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey, env } from "~/lib/env"
import {
  type InstanceClientEnv,
  instanceOAuthClient,
  loadOrgGoogleOAuthClient,
  resolveOAuthClientCredentials,
} from "~/modules/apps/connections/oauth-client"
import { oauthClientIdHint } from "~/modules/apps/connections/oauth-client-provisioning"

/** The instance's Google client, read from the server's environment (tests pass their own). */
type GoogleIntegrationEnv = Pick<
  InstanceClientEnv,
  "GMAIL_OAUTH_CLIENT_ID" | "GMAIL_OAUTH_CLIENT_SECRET"
>

/** The connection whose client the workspace's Google client is (all three share it). */
const GOOGLE_WORKSPACE_KEY = "mail:gmail"

export interface GoogleIntegrationSummary {
  provider: "google"
  configured: boolean
  configurationSource: "org" | "deployment" | null
  clientIdHint?: string
}

export async function getGoogleIntegrationSummary(
  orgId: string,
  currentEnv: GoogleIntegrationEnv = env,
): Promise<GoogleIntegrationSummary> {
  const orgClient = await loadOrgGoogleOAuthClient(orgId)

  if (orgClient) {
    return {
      provider: "google",
      configured: true,
      configurationSource: "org",
      clientIdHint: oauthClientIdHint(orgClient.clientId),
    }
  }

  const instance = instanceOAuthClient(GOOGLE_WORKSPACE_KEY, currentEnv)
  if (instance) {
    return {
      provider: "google",
      configured: true,
      configurationSource: "deployment",
      clientIdHint: oauthClientIdHint(instance.clientId),
    }
  }

  return { provider: "google", configured: false, configurationSource: null }
}

/** The workspace's Google client for Gmail and Calendar: the org's own, else the
 *  instance's (oauth-client.ts). */
export async function resolveGoogleOAuthClientConfig(
  orgId: string,
  currentEnv: GoogleIntegrationEnv = env,
): Promise<{ clientId: string; clientSecret: string; source: "org" | "deployment" } | null> {
  const resolved = await resolveOAuthClientCredentials(orgId, GOOGLE_WORKSPACE_KEY, {
    auditAction: "google-integration-load",
    instanceEnv: currentEnv,
  })
  if (!resolved) return null
  return {
    clientId: resolved.clientId,
    clientSecret: resolved.clientSecret,
    source: resolved.source === "org" ? "org" : "deployment",
  }
}

export async function saveGoogleIntegrationConfig(
  orgId: string,
  config: { clientId: string; clientSecret: string },
): Promise<void> {
  const clientSecretEncrypted = encryptSecret(
    config.clientSecret,
    encryptionKey,
    CryptoContext.googleClientSecret,
  )

  const k = drizzleSql.raw(schemaRef("kernel"))
  await withPrivilegedDb(orgId, "google-integration-save", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${k}.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) ||
        jsonb_build_object('integrations',
          COALESCE(settings->'integrations', '{}'::jsonb) ||
          jsonb_build_object('google',
            jsonb_build_object('oauthClient',
              jsonb_build_object(
                'clientId', ${config.clientId}::text,
                'clientSecretEncrypted', ${clientSecretEncrypted}::text
              )
            )
          )
        ),
        updated_at = now()
      WHERE id = ${orgId}::uuid
    `)
  })
}

// Removes the org-level override so resolution falls back to the deployment
// env vars — the recovery path when a bad client id was saved for the org.
export async function clearGoogleIntegrationConfig(orgId: string): Promise<void> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  await withPrivilegedDb(orgId, "google-integration-clear", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${k}.organizations
      SET settings = settings #- '{integrations,google,oauthClient}',
        updated_at = now()
      WHERE id = ${orgId}::uuid
    `)
  })
}

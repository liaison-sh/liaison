// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { withPrivilegedDb } from "~/db/privileged"
import { apps } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { isRecord } from "~/lib/guards"
import { rootLogger } from "~/lib/logger"
import { ConnectionTurnedOffError } from "~/modules/apps/connections/oauth-client-config"
import type { MailProviderId } from "~/modules/mail/provider-ids"
import type { GoogleIntegrationSummary } from "~/modules/settings/google-integration"
import {
  getGoogleIntegrationSummary,
  resolveGoogleOAuthClientConfig,
} from "~/modules/settings/google-integration"

const log = rootLogger.child({ module: "mail-provider-settings" })

type MailProviderDefinition = {
  id: MailProviderId
  label: string
  kind: "oauth2"
  supportedOwnerTypes: Array<"user" | "org">
}

export type MailAppConfig = {
  providers?: Partial<Record<MailProviderId, { enabled?: boolean }>>
  gmailPushSecret?: string
  [key: string]: unknown
}

type MailProviderEnv = Pick<typeof env, "GMAIL_OAUTH_CLIENT_ID" | "GMAIL_OAUTH_CLIENT_SECRET">

export type MailProviderSummary = {
  id: MailProviderId
  label: string
  kind: "oauth2"
  enabled: boolean
  integrationConfigured: boolean
  configurationSource: "org" | "deployment" | null
  supportedOwnerTypes: Array<"user" | "org">
}

const MAIL_PROVIDER_DEFINITIONS: Record<MailProviderId, MailProviderDefinition> = {
  gmail: {
    id: "gmail",
    label: "Gmail",
    kind: "oauth2",
    supportedOwnerTypes: ["user", "org"],
  },
}

function assertKnownProvider(providerId: string): asserts providerId is MailProviderId {
  if (!(providerId in MAIL_PROVIDER_DEFINITIONS)) {
    throw new HTTPException(404, { message: `Mail provider "${providerId}" not found` })
  }
}

function getMailProviderSummary(
  providerId: MailProviderId,
  config: MailAppConfig,
  integrationSummary: GoogleIntegrationSummary,
): MailProviderSummary {
  const definition = MAIL_PROVIDER_DEFINITIONS[providerId]

  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    enabled: config.providers?.[providerId]?.enabled === true,
    integrationConfigured: integrationSummary.configured,
    configurationSource: integrationSummary.configurationSource,
    supportedOwnerTypes: [...definition.supportedOwnerTypes],
  }
}

export async function loadMailAppConfig(orgId: string): Promise<MailAppConfig> {
  const row = await withPrivilegedDb(orgId, "mail-provider-config-load", async (tx) => {
    const rows = await tx
      .select({ config: apps.config })
      .from(apps)
      .where(and(eq(apps.orgId, orgId), eq(apps.name, "mail")))
      .limit(1)

    return rows[0] ?? null
  })

  return (row?.config as MailAppConfig | null) ?? {}
}

export async function listMailProviders(
  orgId: string,
  currentEnv: MailProviderEnv = env,
): Promise<MailProviderSummary[]> {
  const config = await loadMailAppConfig(orgId)
  const integrationSummary = await getGoogleIntegrationSummary(orgId, currentEnv)

  return (Object.keys(MAIL_PROVIDER_DEFINITIONS) as MailProviderId[]).map((providerId) =>
    getMailProviderSummary(providerId, config, integrationSummary),
  )
}

export async function getMailProvider(
  orgId: string,
  providerId: string,
  currentEnv: MailProviderEnv = env,
): Promise<MailProviderSummary> {
  assertKnownProvider(providerId)

  const config = await loadMailAppConfig(orgId)
  const integrationSummary = await getGoogleIntegrationSummary(orgId, currentEnv)
  return getMailProviderSummary(providerId, config, integrationSummary)
}

export async function setMailProviderEnabled(
  orgId: string,
  providerId: string,
  enabled: boolean,
  _currentEnv: MailProviderEnv = env,
): Promise<MailAppConfig> {
  assertKnownProvider(providerId)

  const currentConfig = await loadMailAppConfig(orgId)
  const currentProviders = isRecord(currentConfig.providers) ? currentConfig.providers : {}
  const currentProviderConfig = isRecord(currentProviders[providerId])
    ? currentProviders[providerId]
    : {}

  const nextConfig: MailAppConfig = {
    ...currentConfig,
    providers: {
      ...currentProviders,
      [providerId]: {
        ...currentProviderConfig,
        enabled,
      },
    },
  }

  await withPrivilegedDb(orgId, "mail-provider-config-update", async (tx) => {
    await tx
      .update(apps)
      .set({ config: nextConfig, updatedAt: new Date() })
      .where(and(eq(apps.orgId, orgId), eq(apps.name, "mail")))
  })

  // Open Settings > Mail pages show the switch and whether Gmail can connect:
  // they refetch on this frame instead of waiting for a reload.
  void broadcastEphemeral({
    app: "mail",
    entity: "provider",
    action: "update",
    orgId,
    data: { id: providerId, enabled },
  }).catch((err) =>
    log.warn(
      { err, orgId, providerId },
      "mail provider broadcast failed; pages converge on reload",
    ),
  )

  return nextConfig
}

export async function resolveEnabledMailProviderOAuthClient(
  orgId: string,
  providerId: string,
  currentEnv: MailProviderEnv = env,
): Promise<{ clientId: string; clientSecret: string; source: "org" | "deployment" }> {
  const provider = await getMailProvider(orgId, providerId, currentEnv)

  if (!provider.enabled) {
    throw new ConnectionTurnedOffError(
      `${provider.label} is not enabled for this org`,
      `${provider.label} mailboxes are switched off for this workspace (Settings > Mail). Turn them on first: kernel__config_apps with { apps: [{ name: "mail", enable: true, providers: { ${providerId}: { enabled: true } } }] }, which an admin approves (a member who is not one asks an admin); then post the Connect card.`,
    )
  }

  const resolved = await resolveGoogleOAuthClientConfig(orgId, currentEnv)
  if (!resolved) {
    throw new HTTPException(503, {
      message: `${provider.label} is not configured for this deployment`,
    })
  }

  return {
    clientId: resolved.clientId,
    clientSecret: resolved.clientSecret,
    source: resolved.source,
  }
}

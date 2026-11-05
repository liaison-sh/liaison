// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Mail provider switches for `config apply` (`apps[]` entry `name: mail`,
 * `providers: { gmail: { enabled } }`). The same per-org switch the admin UI
 * flips in Settings > Mail > Providers, written ONLY through
 * `setMailProviderEnabled` (which merges into the mail app row's
 * `config.providers.<id>.enabled` and leaves every other config key alone).
 *
 * Called by the apps provisioner right after the mail app is enabled, so one
 * apply can enable the app and switch its providers. A provider left out of
 * `providers` (or the whole field left out) is never touched.
 *
 * Enabling a provider whose Google credentials are not set up still records the
 * switch (as the admin UI does) and reports the provider as unavailable plus a
 * `pending` item, instead of failing the apply.
 */

import type { ProvisioningConfig } from "~/cli/config/schema"
import { type PendingItem, type ProvisionContext, resolvePlanOrgId } from "~/cli/provisioners/types"
import { instanceOAuthClient } from "~/modules/apps/connections/oauth-client"
import { ensureAppsForOrg } from "~/modules/apps/init"
import type { MailProviderId } from "~/modules/mail/provider-ids"
import {
  listMailProviders,
  loadMailAppConfig,
  setMailProviderEnabled,
} from "~/modules/mail/provider-settings"
import { getGoogleIntegrationSummary } from "~/modules/settings/google-integration"

export type MailProvidersSpec = Partial<Record<MailProviderId, { enabled: boolean }>>

/** Per-provider report entry on the mail app's `apps[]` result. */
export interface MailProviderResult {
  enabled: boolean
  /** False when enabled but no Google credentials exist (org or deployment). */
  available: boolean
}

export interface MailProvidersApplyResult {
  providers: Partial<Record<MailProviderId, MailProviderResult>>
  changed: string[]
  unchanged: string[]
  pending: PendingItem[]
}

/** Mirrors the admin UI's "Google credentials are not set up yet" notice. */
function unavailableNotice(label: string): string {
  return `Google credentials are not set up yet: ${label} stays unavailable until they are`
}

const SET_UP_GOOGLE_ACTION =
  "run `liaison guide google --email <addr>` for the address's path and steps, then " +
  "set up Google credentials: Mail Setup in Settings > Mail, a `google` client on a gmail " +
  "mailbox or ticket inbox in this config, or the deployment's GMAIL_OAUTH_CLIENT_ID and " +
  "GMAIL_OAUTH_CLIENT_SECRET"

function entries(spec: MailProvidersSpec): Array<[MailProviderId, boolean]> {
  return (Object.entries(spec) as Array<[MailProviderId, { enabled: boolean } | undefined]>)
    .filter((e): e is [MailProviderId, { enabled: boolean }] => e[1] !== undefined)
    .map(([id, v]) => [id, v.enabled])
}

/** True when this config itself supplies a Google client (saved by the mail /
 *  tickets provisioners, which run before `apps`). */
function configSuppliesGoogleClient(config: ProvisioningConfig): boolean {
  const mailboxes = config.mail?.mailboxes ?? []
  const inboxes = config.tickets?.inboxes ?? []
  return [...mailboxes, ...inboxes].some((m) => m.provider === "gmail" && m.google !== undefined)
}

/**
 * Read-only plan lines. The driver plans before the org provisioner applies, so
 * `ctx.orgId` is usually empty: the org is then resolved read-only by slug, and
 * a not-yet-existing org has every provider off (nothing stored yet).
 */
export async function planMailProviders(
  ctx: ProvisionContext,
  config: ProvisioningConfig,
  spec: MailProvidersSpec,
): Promise<string[]> {
  const orgId = await resolvePlanOrgId(ctx, config.org.slug, "cli-plan-mail-providers-org")

  const stored = orgId === "" ? {} : await loadMailAppConfig(orgId)
  // Without an org only the deployment-level client can exist yet.
  const integrationConfigured =
    configSuppliesGoogleClient(config) ||
    (orgId === ""
      ? instanceOAuthClient("mail:gmail") !== null
      : (await getGoogleIntegrationSummary(orgId)).configured)

  return entries(spec).map(([id, enabled]) => {
    const current = stored.providers?.[id]?.enabled === true
    if (current === enabled) {
      return `mail provider '${id}' unchanged (${enabled ? "enabled" : "disabled"})`
    }
    const line = `${enabled ? "enable" : "disable"} mail provider '${id}'`
    return enabled && !integrationConfigured ? `${line} (${unavailableNotice(id)})` : line
  })
}

/**
 * Converge the org's mail provider switches to `spec`. Idempotent: a provider
 * already in the desired state is reported unchanged and not written.
 */
export async function applyMailProviders(
  ctx: ProvisionContext,
  spec: MailProvidersSpec,
): Promise<MailProvidersApplyResult> {
  // The switch lives on the org's `kernel.apps` mail row, which app
  // registration creates. The org provisioner already ran it; this is a no-op
  // then, and guarantees the row for an org created outside this run.
  await ensureAppsForOrg(ctx.orgId)

  const result: MailProvidersApplyResult = {
    providers: {},
    changed: [],
    unchanged: [],
    pending: [],
  }
  const stored = await loadMailAppConfig(ctx.orgId)

  for (const [id, enabled] of entries(spec)) {
    const key = `apps.mail.providers.${id}.enabled`
    if ((stored.providers?.[id]?.enabled === true) === enabled) {
      ctx.log(`mail provider '${id}': already ${enabled ? "enabled" : "disabled"}`)
      result.unchanged.push(key)
    } else {
      await setMailProviderEnabled(ctx.orgId, id, enabled)
      ctx.log(`mail provider '${id}': ${enabled ? "enabled" : "disabled"}`)
      result.changed.push(key)
    }
  }

  // Read back through the same summary the admin UI shows: proves the switch
  // landed (an org without a mail app row would silently drop the write) and
  // gives availability.
  const summaries = new Map((await listMailProviders(ctx.orgId)).map((p) => [p.id, p] as const))
  for (const [id, enabled] of entries(spec)) {
    const summary = summaries.get(id)
    if (!summary || summary.enabled !== enabled) {
      throw new Error(
        `mail provider '${id}': the switch did not persist (no mail app row for org ${ctx.orgId}?)`,
      )
    }
    const available = summary.enabled && summary.integrationConfigured
    result.providers[id] = { enabled: summary.enabled, available }
    if (summary.enabled && !summary.integrationConfigured) {
      const notice = unavailableNotice(summary.label)
      ctx.log(`mail provider '${id}': enabled, but ${notice}`)
      result.pending.push({
        kind: "credentials",
        app: "mail",
        connection: id,
        action: SET_UP_GOOGLE_ACTION,
        message: `${summary.label} is enabled. ${notice}.`,
      })
    }
  }

  return result
}

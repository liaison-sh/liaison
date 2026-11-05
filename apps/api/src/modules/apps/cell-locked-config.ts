// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * App config keys a managed cell owns (managed edition). The server-level
 * callbacks route every workspace's Gmail push and Meta deliveries
 * (modules/cloud/cell-webhooks.ts), verified once with the cell's own values;
 * each app then re-verifies with `config_get`. A workspace's own copy of one
 * of those values must not change what the cell decided, so on a managed cell:
 *
 * - social `cellMetaCallbackUrl` / `cellMetaVerifyToken`: always the cell's;
 * - mail / tickets `gmailPushTopic`, `gmailPushAudience`,
 *   `gmailPushServiceAccount`: the cell's while the workspace uses the cell's
 *   Google client (a workspace on its own client runs its own Pub/Sub and keeps
 *   its own values);
 * - social `socialMetaAppSecret`: the cell's Meta app secret while the
 *   workspace uses the cell's Meta app (META_APP_ID / META_APP_SECRET).
 *
 * `config_get` (sandbox bridge and webhook verifiers) answers the cell's value
 * for such a key whatever the workspace stored, with a log line when they
 * differ, and an admin write of one is refused (`cell_config_locked`).
 * Self-hosted: nothing is locked.
 */
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { resolveOAuthClient } from "~/modules/apps/connections/oauth-client"
import { instanceConfigDefault } from "~/modules/apps/instance-config-defaults"

export const CELL_CONFIG_LOCKED_CODE = "cell_config_locked"

const ALWAYS: Readonly<Record<string, readonly string[]>> = {
  social: ["cellMetaCallbackUrl", "cellMetaVerifyToken"],
}

const GMAIL_PUSH_KEYS = ["gmailPushTopic", "gmailPushAudience", "gmailPushServiceAccount"]

/** Keys locked while the workspace uses the cell's client for `connection`. */
const WITH_CELL_CLIENT: Readonly<Record<string, { connection: string; keys: readonly string[] }>> =
  {
    mail: { connection: "mail:gmail", keys: GMAIL_PUSH_KEYS },
    tickets: { connection: "tickets:gmail", keys: GMAIL_PUSH_KEYS },
    social: { connection: "social:facebook", keys: ["socialMetaAppSecret"] },
  }

/** Whether a managed cell owns this app config key (for some workspace). */
export function isCellLockedConfigKey(appName: string, key: string): boolean {
  if (!isManagedEdition()) return false
  return (
    (ALWAYS[appName]?.includes(key) ?? false) ||
    (WITH_CELL_CLIENT[appName]?.keys.includes(key) ?? false)
  )
}

/**
 * The cell's value of a key it owns for this workspace, or null when the
 * workspace's own value applies (not managed, not a cell key, the workspace
 * on its own client, or the cell provides no value).
 */
export async function cellLockedConfigValue(
  orgId: string,
  appName: string,
  key: string,
): Promise<string | null> {
  if (!isManagedEdition()) return null
  if (ALWAYS[appName]?.includes(key)) return instanceConfigDefault(appName, key)
  const rule = WITH_CELL_CLIENT[appName]
  if (!rule?.keys.includes(key)) return null
  const client = await resolveOAuthClient(orgId, rule.connection)
  if (client.source !== "instance") return null
  if (key === "socialMetaAppSecret") return env.META_APP_SECRET ?? null
  return instanceConfigDefault(appName, key)
}

/**
 * `config_get`'s answer for a key the cell may own: the cell's value when it
 * owns it (logged once per call when the workspace stored another), else
 * undefined so the caller reads the workspace's value as usual.
 */
export async function cellConfigOverride(
  orgId: string,
  appName: string,
  key: string,
  stored: unknown,
): Promise<string | undefined> {
  if (!isCellLockedConfigKey(appName, key)) return undefined
  const cell = await cellLockedConfigValue(orgId, appName, key)
  if (cell === null) return undefined
  // (A secret is stored encrypted: not compared.)
  if (key !== "socialMetaAppSecret" && stored !== undefined && stored !== null && stored !== cell) {
    log.warn({ orgId, app: appName, key }, "workspace config value ignored: the cell's value wins")
  }
  return cell
}

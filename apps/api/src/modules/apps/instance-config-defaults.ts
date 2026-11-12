// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * App config keys the instance can answer for every workspace when the
 * workspace set none: `config_get(key)` (and a webhook verifier's
 * `config_get`) returns the workspace's own value first, then this default.
 *
 * - mail `gmailPushTopic`: a Cloud Pub/Sub topic Gmail push publishes to,
 *   shared by every workspace (`GMAIL_PUBSUB_TOPIC`, the topic Tickets uses).
 * - mail and tickets `gmailPushAudience` / `gmailPushServiceAccount`: the OIDC
 *   audience and signing service account of that topic's push subscription
 *   (`GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT`), so each app verifies
 *   the push token it receives.
 * - google-drive `pickerApiKey` / `pickerAppId`: the Google Picker's API key and
 *   its Cloud project number (`GOOGLE_PICKER_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER`).
 * - social `cellMetaCallbackUrl` / `cellMetaVerifyToken` (managed edition with
 *   `META_APP_SECRET`): the server's own Meta callback and its handshake token,
 *   which `webhooks_setup` subscribes the shared Meta app to.
 */
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { CELL_META_PATH, cellMetaVerifyToken } from "~/modules/cloud/cell-meta-token"

const gmailPush = {
  gmailPushAudience: () => env.GMAIL_PUSH_AUDIENCE,
  gmailPushServiceAccount: () => env.GMAIL_PUSH_SERVICE_ACCOUNT,
}

/** The server-level Meta callback exists only in the managed edition with an instance Meta app. */
function cellMeta<T>(fn: (secret: string) => T): () => T | undefined {
  return () => (isManagedEdition() && env.META_APP_SECRET ? fn(env.META_APP_SECRET) : undefined)
}

const DEFAULTS: Readonly<Record<string, Readonly<Record<string, () => string | undefined>>>> = {
  mail: { gmailPushTopic: () => env.GMAIL_PUBSUB_TOPIC, ...gmailPush },
  tickets: { ...gmailPush },
  "google-drive": {
    pickerApiKey: () => env.GOOGLE_PICKER_API_KEY,
    pickerAppId: () => env.GOOGLE_CLOUD_PROJECT_NUMBER,
  },
  social: {
    cellMetaCallbackUrl: cellMeta(() => `${env.BASE_URL.replace(/\/+$/, "")}${CELL_META_PATH}`),
    cellMetaVerifyToken: cellMeta(cellMetaVerifyToken),
  },
}

/** The instance's value for an app's config key, or null when it provides none. */
export function instanceConfigDefault(appName: string, key: string): string | null {
  const value = DEFAULTS[appName]?.[key]?.()
  return value ? value : null
}

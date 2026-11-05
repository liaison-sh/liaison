// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * App config keys the instance can answer for every workspace when the
 * workspace set none: `config_get(key)` returns the workspace's own value
 * first, then this default.
 *
 * - mail `gmailPushTopic`: a Cloud Pub/Sub topic Gmail push publishes to,
 *   shared by every workspace (`GMAIL_PUBSUB_TOPIC`, the topic Tickets uses).
 */
import { env } from "~/lib/env"

const DEFAULTS: Readonly<Record<string, Readonly<Record<string, () => string | undefined>>>> = {
  mail: { gmailPushTopic: () => env.GMAIL_PUBSUB_TOPIC },
}

/** The instance's value for an app's config key, or null when it provides none. */
export function instanceConfigDefault(appName: string, key: string): string | null {
  const value = DEFAULTS[appName]?.[key]?.()
  return value ? value : null
}

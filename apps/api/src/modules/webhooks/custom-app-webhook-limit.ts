// SPDX-License-Identifier: FSL-1.1-ALv2
// The inbound webhook budget of an org's custom app (every edition). A
// custom app's webhook URL is public and its `verify` runs in the shared
// sandbox before any authentication result, so anyone on the internet could
// drive the tenant's code as fast as they like. Each (org, custom app) pair
// gets CUSTOM_APP_WEBHOOK_PER_MINUTE deliveries a minute across the cell;
// past it the route answers 429 with Retry-After before any sandbox work.
// Catalog, in-tree and instance apps keep their path (provider-driven volume).
import { HTTPException } from "hono/http-exception"
import { webhooksLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { sandboxTenantKey } from "~/modules/apps/custom-app-name"

/** Deliveries one custom app accepts per minute, per org, across the cell. */
export const CUSTOM_APP_WEBHOOK_PER_MINUTE = 120

let limitPerMinute = CUSTOM_APP_WEBHOOK_PER_MINUTE

/** Test seams on the per-minute budget. */
export const CustomAppWebhookLimitTestAccess = {
  /** A smaller budget. `null` restores the default. */
  setLimit(limit: number | null): void {
    limitPerMinute = limit ?? CUSTOM_APP_WEBHOOK_PER_MINUTE
  },
}

/** 429 `custom_app_rate_limited`, with the seconds until the window has room. */
export class CustomAppWebhookRateError extends HTTPException {
  readonly code = "custom_app_rate_limited"
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super(429, { message: "Too many deliveries to this app's webhooks. Retry later." })
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Count one delivery to `appName`'s webhook under `orgId`; throws a 429 when
 * the minute's budget is spent. Not a custom app: nothing counted. Redis
 * unreachable: the delivery goes through (logged), as the other rate limits.
 */
export async function assertCustomAppWebhookRate(orgId: string, appName: string): Promise<void> {
  if (!sandboxTenantKey(appName)) return
  let result: Awaited<ReturnType<typeof checkRateLimit>>
  try {
    result = await checkRateLimit(redis, [
      {
        identifier: `webhook:custom:${orgId}:${appName}`,
        limit: limitPerMinute,
        windowSeconds: 60,
      },
    ])
  } catch (err) {
    log.warn({ err, orgId, app: appName }, "custom app webhook rate limit unreadable: let through")
    return
  }
  if (!result.allowed) {
    log.warn({ orgId, app: appName }, "custom app webhook refused: rate limit")
    throw new CustomAppWebhookRateError(result.failed.retryAfterSeconds)
  }
}

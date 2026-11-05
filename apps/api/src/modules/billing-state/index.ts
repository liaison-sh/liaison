// SPDX-License-Identifier: FSL-1.1-ALv2
import { billingStateReplySchema } from "@liaison/control-plane-contract"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"

export interface BillingStateConfig {
  controlPlaneUrl?: string
  controlPlaneApiKey?: string
}

const CACHE_TTL_SECONDS = 60
// Stale-fallback TTL: how long the last-known-good payload is kept even after
// a fetch failure. Long enough to survive a transient control-plane outage
// without leaving stale Redis keys indefinitely.
const LAST_KNOWN_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

// The control plane is a third-party API and its payload is forwarded verbatim
// to browser clients, where billingPortalUrl/checkoutUrl are rendered as anchor
// `href`s. Only allow https:// URLs so a compromised or misconfigured control
// plane cannot inject a `javascript:` URI or other dangerous scheme (mirrors
// the open-redirect guard on the GitHub html_url in admin/version-check.ts).
function safeHttpsUrl(rawUrl: string): string | undefined {
  return /^https:\/\//.test(rawUrl) ? rawUrl : undefined
}

export function createBillingStateRoutes(config: BillingStateConfig = {}) {
  const url = config.controlPlaneUrl?.trim().replace(/\/+$/, "")
  const key = config.controlPlaneApiKey?.trim()
  const managed = !!(url && key)

  const app = new Hono<AppEnv>()

  app.get("/", async (c) => {
    if (!managed) {
      return success(c, {
        mode: "self_hosted",
        byokEnabled: true,
      })
    }

    const orgId = c.get("orgId") as string
    const cacheKey = `billingState:${orgId}`
    const lastKey = `billingState:last:${orgId}`

    const cached = await redis.get(cacheKey)
    if (cached) {
      try {
        return success(c, { ...JSON.parse(cached), stale: false })
      } catch {
        // fall through to refetch
      }
    }

    try {
      const r = await fetch(`${url}/v1/orgs/${orgId}/billing-state`, {
        headers: { authorization: `Bearer ${key}` },
        // Bound the control-plane round-trip so an unresponsive endpoint cannot
        // stall every billing-state request (matches admin/version-check.ts).
        signal: AbortSignal.timeout(5_000),
      })
      if (!r.ok) throw new Error(`control plane responded ${r.status}`)
      const reply = billingStateReplySchema.safeParse(await r.json())
      if (!reply.success) {
        throw new Error("control plane payload malformed")
      }
      const parsed = reply.data
      const fresh = {
        mode: "managed" as const,
        tier: parsed.tier,
        status: parsed.status,
        billingPortalUrl: safeHttpsUrl(parsed.billingPortalUrl),
        checkoutUrl: safeHttpsUrl(parsed.checkoutUrl),
        includedCredits: parsed.includedCredits,
        periodEnd: parsed.periodEnd,
        fetchedAt: new Date().toISOString(),
      }
      await redis.set(cacheKey, JSON.stringify(fresh), "EX", CACHE_TTL_SECONDS)
      await redis.set(lastKey, JSON.stringify(fresh), "EX", LAST_KNOWN_TTL_SECONDS)
      return success(c, { ...fresh, stale: false })
    } catch {
      const last = await redis.get(lastKey)
      if (last) {
        try {
          return success(c, { ...JSON.parse(last), stale: true })
        } catch {
          // fall through to billingUnavailable
        }
      }
      return success(c, { mode: "managed", billingUnavailable: true, stale: true })
    }
  })

  return app
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// Before a serving process turns ready (/readyz 200), it registers the apps of
// the orgs that have a live socket in the cell. Those are the orgs its first
// requests come from: a deploy closes the old processes' sockets (1012) and
// they reconnect here at once, and the same people's next requests follow.
// Registered lazily instead, each of those orgs waited its turn in the one
// registration lane (init.ts, awaitOrgApps) on the request path: with ten
// active orgs, the last reconnect and its first request waited for ten
// registrations, seconds each. Before ready, the old processes still serve
// them. Bounded: past the budget the process turns ready anyway, and the
// remaining orgs register on demand as before.
import { appsLogger } from "~/lib/logger"

const log = appsLogger.child({ module: "ready-warm" })

/** At most this many orgs warm before ready; the rest register on demand. */
export const READY_WARM_MAX_ORGS = 200

export interface ReadyWarmResult {
  total: number
  warmed: number
  failed: number
  timedOut: boolean
  ms: number
}

export async function warmLiveOrgsBeforeReady(deps: {
  /** The orgs with a live socket anywhere in the cell. */
  liveOrgIds: () => Promise<string[]>
  /** Register one org's apps now (awaitOrgApps). */
  awaitOrg: (orgId: string) => Promise<void>
  /** 0 skips the warm-up. */
  budgetMs: number
  /** Test seam for the budget's timer. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<ReadyWarmResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const done = (r: Omit<ReadyWarmResult, "ms">): ReadyWarmResult => ({ ...r, ms: now() - started })
  if (deps.budgetMs <= 0) return done({ total: 0, warmed: 0, failed: 0, timedOut: false })
  let orgIds: string[]
  try {
    orgIds = await deps.liveOrgIds()
  } catch (err) {
    log.warn({ err }, "Reading the orgs with live sockets failed: none is warmed before ready")
    return done({ total: 0, warmed: 0, failed: 0, timedOut: false })
  }
  let warmed = 0
  let failed = 0
  let cut = false
  const all = (async () => {
    for (const orgId of orgIds) {
      if (cut) return
      try {
        await deps.awaitOrg(orgId)
        warmed++
      } catch (err) {
        failed++
        log.warn({ err, orgId }, "Warming an org before ready failed: it registers on demand")
      }
    }
  })()
  let handle: ReturnType<typeof setTimeout> | undefined
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        handle = setTimeout(resolve, ms)
      }))
  const outcome = await Promise.race([
    all.then(() => "all" as const),
    sleep(deps.budgetMs).then(() => "budget" as const),
  ])
  if (handle !== undefined) clearTimeout(handle)
  const timedOut = outcome === "budget" && warmed + failed < orgIds.length
  cut = true
  const result = done({ total: orgIds.length, warmed, failed, timedOut })
  if (result.total > 0) {
    const line = timedOut
      ? "Ready before every org with live sockets registered: the rest register on demand"
      : "Registered the orgs with live sockets before turning ready"
    if (timedOut) log.warn(result, line)
    else log.info(result, line)
  }
  return result
}

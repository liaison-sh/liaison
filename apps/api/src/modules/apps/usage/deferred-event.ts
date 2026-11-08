// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app's event subscription handler, held while its org is at an app day
// cap (app-day-cap.ts): instead of running, the event is enqueued as the
// kernel job `app-deferred-event` holding the event, delayed until the next
// UTC day, and the event is acknowledged. The job sets the org up, finds the
// same handler (registered here per process when runtime.ts subscribes it)
// and runs it; still at the cap, it waits again (AppDayCapHeldJobError).
// A handler that is gone when the job runs (the app was removed or turned
// Off) drops the event, as a delivery to a removed subscription would.

import { enqueueAppJob } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { appRunHoldMs, holdAppJobIfCapped } from "./app-day-cap"

const log = rootLogger.child({ module: "app-deferred-event" })

type EventHandler = (event: unknown) => Promise<void>

const handlers = new Map<string, EventHandler>()
/** Events the deferred job is running now: their handler runs them, never holds them again. */
const runningDeferred = new WeakSet<object>()

type OrgSetup = (orgId: string) => Promise<void>
const realOrgSetup: OrgSetup = async (orgId) => {
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(orgId)
}
let orgSetup: OrgSetup = realOrgSetup

const keyOf = (orgId: string, appName: string, eventType: string, exportName: string) =>
  `${orgId}|${appName}|${eventType}|${exportName}`

/** Record a subscription's handler, so a held event finds it again. Returns the unregister. */
export function registerDeferrableEventHandler(
  orgId: string,
  appName: string,
  eventType: string,
  exportName: string,
  handler: EventHandler,
): () => void {
  const key = keyOf(orgId, appName, eventType, exportName)
  handlers.set(key, handler)
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key)
  }
}

export interface DeferredEventJob {
  orgId: string
  appName: string
  eventType: string
  exportName: string
  event: unknown
}

/**
 * Hold the event when its org is at an app day cap: true when it was
 * enqueued for later (the caller then returns without running it). An event
 * the deferred job is running is never held again here.
 */
export async function deferEventIfCapped(job: DeferredEventJob): Promise<boolean> {
  if (job.event && typeof job.event === "object" && runningDeferred.has(job.event)) return false
  const holdMs = await appRunHoldMs({ orgId: job.orgId, trusted: false })
  if (holdMs === null) return false
  await enqueueAppJob("kernel", "app-deferred-event", job, { delay: holdMs })
  log.info(
    { orgId: job.orgId, app: job.appName, eventType: job.eventType },
    "app event held until the next UTC day: the org reached an app day cap",
  )
  return true
}

const SAFE = /^[A-Za-z0-9_:/.-]{1,200}$/

/** The `app-deferred-event` job. */
export async function runDeferredAppEvent(data: unknown): Promise<void> {
  const d = data as Partial<DeferredEventJob> | null
  if (
    !d ||
    typeof d.orgId !== "string" ||
    typeof d.appName !== "string" ||
    typeof d.eventType !== "string" ||
    typeof d.exportName !== "string" ||
    !SAFE.test(d.appName) ||
    !SAFE.test(d.eventType) ||
    !SAFE.test(d.exportName)
  ) {
    log.warn({ data }, "app-deferred-event: invalid job data; dropped")
    return
  }
  await holdAppJobIfCapped({ orgId: d.orgId, trusted: false })
  const key = keyOf(d.orgId, d.appName, d.eventType, d.exportName)
  // This process sets the org's apps up on first touch, which subscribes them.
  if (!handlers.has(key)) await orgSetup(d.orgId)
  const handler = handlers.get(key)
  if (!handler) {
    log.info(
      { orgId: d.orgId, app: d.appName, eventType: d.eventType },
      "app-deferred-event: the subscription is gone; the event is dropped",
    )
    return
  }
  const event = d.event && typeof d.event === "object" ? d.event : {}
  runningDeferred.add(event)
  await handler(event)
}

/** Test seams of the deferred events. */
export const DeferredEventTestAccess = {
  clear(): void {
    handlers.clear()
    orgSetup = realOrgSetup
  },
  /** Set the org's apps up with `fn` (null: the real setup). */
  setOrgSetup(fn: OrgSetup | null): void {
    orgSetup = fn ?? realOrgSetup
  },
  has(orgId: string, appName: string, eventType: string, exportName: string): boolean {
    return handlers.has(keyOf(orgId, appName, eventType, exportName))
  },
}

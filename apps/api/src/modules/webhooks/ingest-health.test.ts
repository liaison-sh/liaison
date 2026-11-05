// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Inbound-webhook ingest health: rejections for every app, missed deliveries and
// stale probes for apps that declare a webhook-health probe, and nothing at all
// for a quiet sender.
import { beforeEach, describe, expect, it } from "bun:test"
import {
  declareWebhookHealth,
  forgetWebhookHealth,
  recordWebhookAccepted,
  recordWebhookRejected,
  resetWebhookIngestHealth,
  type UpstreamActivity,
  webhookIngestDiag,
} from "~/modules/webhooks/ingest-health"
import { parseUpstreamProbeResult } from "~/modules/webhooks/upstream-activity"

const HOUR = 3600_000
const DAY = 24 * HOUR

beforeEach(() => resetWebhookIngestHealth())

describe("webhook ingest health", () => {
  it("reports nothing before any traffic", () => {
    const d = webhookIngestDiag()
    expect(d.perApp).toEqual([])
    expect(d.rejectingApps).toEqual([])
    expect(d.missedDeliveryApps).toEqual([])
    expect(d.staleProbeApps).toEqual([])
  })

  it("flags the exact prod signature: deliveries arriving, all refused, none ever accepted", () => {
    // Booted well past the rejection warm-up, so this exercises the real-outage
    // shape (the failure this signal exists for), not the redeploy-grace window.
    const bootedAt = Date.now() - 2 * HOUR
    resetWebhookIngestHealth(bootedAt)
    const t = bootedAt + HOUR
    // A live sender keeps being refused over time: five rejections across 12 minutes.
    for (let i = 0; i < 5; i++) {
      recordWebhookRejected("boxtal", "signature_mismatch", t + i * 3 * 60_000)
    }
    const end = t + 4 * 3 * 60_000
    const d = webhookIngestDiag(end + 1000)

    expect(d.rejectingApps.map((a) => a.app)).toEqual(["boxtal"])
    const boxtal = d.rejectingApps[0]!
    expect(boxtal.rejectedTotal).toBe(5)
    expect(boxtal.acceptedTotal).toBe(0)
    // The unambiguous bit: a live sender we are refusing outright. This is what
    // the watchdog pages on, and it can never be confused with a quiet period.
    expect(boxtal.rejectingWithoutSuccess).toBe(true)
    expect(boxtal.lastRejectedReason).toBe("signature_mismatch")
    expect(boxtal.lastRejectedAgeSec).toBe(1)
  })

  // Whoever knows a registered webhook URL can send bad requests. A burst of
  // them, however many, must not read as a live sender being refused.
  it("a burst of rejections inside a short span does not claim rejecting-without-success", () => {
    const bootedAt = Date.now() - 2 * HOUR
    resetWebhookIngestHealth(bootedAt)
    const t = bootedAt + HOUR
    for (let i = 0; i < 200; i++) recordWebhookRejected("boxtal", "signature_mismatch", t + i * 100)
    const d = webhookIngestDiag(t + 30_000)
    expect(d.perApp[0]!.rejectedTotal).toBe(200)
    expect(d.perApp[0]!.rejectingWithoutSuccess).toBe(false)
  })

  // REGRESSION: the counters are in-memory and reset on restart, so a SINGLE
  // rejected delivery arriving before the first accepted one used to flag the
  // app as refusing outright on every redeploy -- a 60-second fire/resolve
  // critical page for traffic that was never actually a total outage.
  it("a rejection in the first minutes after start does not claim rejecting-without-success", () => {
    const bootedAt = Date.now() - 60_000
    resetWebhookIngestHealth(bootedAt)
    recordWebhookRejected("boxtal", "signature_mismatch", bootedAt + 60_000)
    const d = webhookIngestDiag(bootedAt + 60_000)
    expect(d.rejectingApps.every((a) => !a.rejectingWithoutSuccess)).toBe(true)
  })

  it("a qualifying run of rejections inside the boot warm-up does not claim rejecting-without-success", () => {
    const bootedAt = Date.now() - 20 * 60_000
    resetWebhookIngestHealth(bootedAt)
    for (let i = 0; i < 5; i++) {
      recordWebhookRejected("boxtal", "signature_mismatch", bootedAt + i * 3 * 60_000)
    }
    expect(webhookIngestDiag(bootedAt + 13 * 60_000).perApp[0]!.rejectingWithoutSuccess).toBe(false)
    // The same run read once the warm-up has passed does qualify.
    expect(webhookIngestDiag(bootedAt + 16 * 60_000).perApp[0]!.rejectingWithoutSuccess).toBe(true)
  })

  it("does not claim rejecting-without-success once anything gets through", () => {
    // Past the warm-up, with enough rejections over a long enough span to qualify:
    // the one accepted delivery is the only thing keeping the flag down.
    const bootedAt = Date.now() - 2 * HOUR
    resetWebhookIngestHealth(bootedAt)
    const t = bootedAt + HOUR
    for (let i = 0; i < 5; i++) {
      recordWebhookRejected("boxtal", "signature_mismatch", t + i * 3 * 60_000)
    }
    recordWebhookAccepted("boxtal", t + 13 * 60_000)
    const boxtal = webhookIngestDiag(t + 14 * 60_000).perApp[0]!
    // Still worth surfacing (a partial failure), but not the total-outage shape.
    expect(boxtal.rejectedTotal).toBe(5)
    expect(boxtal.acceptedTotal).toBe(1)
    expect(boxtal.rejectingWithoutSuccess).toBe(false)
  })

  it("keeps apps independent", () => {
    const t = Date.now()
    recordWebhookRejected("boxtal", "signature_mismatch", t)
    recordWebhookAccepted("shopify", t)
    const d = webhookIngestDiag(t + 1000)
    expect(d.rejectingApps.map((a) => a.app)).toEqual(["boxtal"])
    expect(d.perApp.map((a) => a.app)).toEqual(["boxtal", "shopify"])
  })

  it("does not report quiet apps through any field: there is no silence window", () => {
    const d = webhookIngestDiag()
    expect("silentApps" in d).toBe(false)
  })
})

const MIN = 60_000
const ORG = "org-1"
const probe = (activityAtMs: number | null, probedAtMs: number, app = "shopify") =>
  new Map<string, UpstreamActivity>([[app, { activityAtMs, probedAtMs }]])

// An unprobed app (manifest `webhookHealth: { probe: null, reason }`) is judged by
// rejections only. A fixed window used to page a carrier every hour of a quiet
// weekend, and an e-invoicing feed hourly after a day without an invoice.
describe("webhook ingest health: unprobed apps", () => {
  it("an unprobed app silent for a week is not reported", () => {
    const bootedAt = Date.now() - 8 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("pennylane", ORG, null)
    recordWebhookAccepted("pennylane", bootedAt + HOUR)
    const now = bootedAt + 8 * DAY
    const d = webhookIngestDiag(now, new Map())
    expect(d.missedDeliveryApps).toEqual([])
    expect(d.staleProbeApps).toEqual([])
    expect(d.probedApps).toEqual([])
    expect(d.perApp[0]!.lastAcceptedAgeSec).toBe(Math.floor((now - bootedAt - HOUR) / 1000))
  })

  it("a probe report for an unprobed app is ignored", () => {
    const bootedAt = Date.now() - 5 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, null)
    recordWebhookAccepted("shopify", bootedAt + HOUR)
    const now = bootedAt + 5 * DAY
    expect(
      webhookIngestDiag(now, probe(bootedAt + 2 * HOUR, now - MIN)).missedDeliveryApps,
    ).toEqual([])
  })
})

// A probed app is judged by evidence: did the sender change something that never
// reached us?
describe("webhook ingest health: probed apps", () => {
  // One order on a Saturday, its webhook accepted a minute later, then nothing for
  // days. A silence window paged hourly for a shop that simply had no orders.
  it("a probed app quiet for days with a fresh probe reporting old activity is not reported", () => {
    const bootedAt = Date.now() - 5 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, "probe-webhook-upstream")
    const lastOrderChange = bootedAt + HOUR
    recordWebhookAccepted("shopify", lastOrderChange + MIN)
    const now = bootedAt + 5 * DAY
    const d = webhookIngestDiag(now, probe(lastOrderChange, now - 10 * MIN))
    expect(d.probedApps).toEqual(["shopify"])
    expect(d.missedDeliveryApps).toEqual([])
    expect(d.staleProbeApps).toEqual([])
  })

  it("upstream activity newer than the last accept beyond the grace is a missed delivery", () => {
    const bootedAt = Date.now() - 2 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, "probe-webhook-upstream")
    const lastDelivery = bootedAt + DAY
    recordWebhookAccepted("shopify", lastDelivery)
    const missedChange = lastDelivery + 2 * HOUR
    // Within the grace: a delivery may still be in flight.
    expect(
      webhookIngestDiag(missedChange + 10 * MIN, probe(missedChange, missedChange + 5 * MIN))
        .missedDeliveryApps,
    ).toEqual([])
    const now = missedChange + HOUR
    const d = webhookIngestDiag(now, probe(missedChange, now - 5 * MIN))
    expect(d.missedDeliveryApps.map((a) => [a.app, a.upstreamActivityAgeSec])).toEqual([
      ["shopify", 3600],
    ])
    expect(d.staleProbeApps).toEqual([])
  })

  // Production: a sender (an accounting platform) announces a received e-invoice
  // well after the invoice's own creation time, the time its probe reports. With
  // the fixed 30 min grace a working subscription paged as a missed delivery.
  it("an app's own delivery grace: a delivery 2 h after the change is not missed", () => {
    const bootedAt = Date.now() - 2 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("late-sender", ORG, "probe-webhook-upstream", 3 * 3600)
    const change = bootedAt + DAY
    // Two hours on, still undelivered: inside the app's 3 h grace.
    const twoHoursOn = change + 2 * HOUR
    expect(
      webhookIngestDiag(twoHoursOn, probe(change, twoHoursOn - 5 * MIN, "late-sender"))
        .missedDeliveryApps,
    ).toEqual([])
    // It arrives: nothing to report afterwards either.
    recordWebhookAccepted("late-sender", twoHoursOn + MIN)
    expect(
      webhookIngestDiag(twoHoursOn + 2 * HOUR, probe(change, twoHoursOn + HOUR, "late-sender"))
        .missedDeliveryApps,
    ).toEqual([])
  })

  it("an app's own delivery grace still catches a delivery that never came", () => {
    const bootedAt = Date.now() - 2 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("late-sender", ORG, "probe-webhook-upstream", 3 * 3600)
    const change = bootedAt + DAY
    const now = change + 4 * HOUR
    const d = webhookIngestDiag(now, probe(change, now - 5 * MIN, "late-sender"))
    expect(
      d.missedDeliveryApps.map((a) => [a.app, a.upstreamActivityAgeSec, a.deliveryGraceSec]),
    ).toEqual([["late-sender", 4 * 3600, 3 * 3600]])
  })

  it("an app that declares no grace keeps the 30 min default", () => {
    const bootedAt = Date.now() - 2 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, "probe-webhook-upstream")
    declareWebhookHealth("late-sender", ORG, "probe-webhook-upstream", 3 * 3600)
    const change = bootedAt + DAY
    const now = change + 31 * MIN
    const upstream = new Map<string, UpstreamActivity>([
      ["shopify", { activityAtMs: change, probedAtMs: now - MIN }],
      ["late-sender", { activityAtMs: change, probedAtMs: now - MIN }],
    ])
    const d = webhookIngestDiag(now, upstream)
    expect(d.missedDeliveryApps.map((a) => [a.app, a.deliveryGraceSec])).toEqual([
      ["shopify", 1800],
    ])
  })

  it("a pipe that died across a redeploy is caught before its first delivery", () => {
    const bootedAt = Date.now() - 3 * HOUR
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, "probe-webhook-upstream")
    const now = bootedAt + 3 * HOUR
    expect(
      webhookIngestDiag(now, probe(bootedAt + HOUR, now - MIN)).missedDeliveryApps.map(
        (a) => a.app,
      ),
    ).toEqual(["shopify"])
    // A change from before boot belongs to the previous process: not judged here.
    expect(webhookIngestDiag(now, probe(bootedAt - HOUR, now - MIN)).missedDeliveryApps).toEqual([])
  })

  it("no sender (null activity) is never a missed delivery", () => {
    const bootedAt = Date.now() - 5 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, "probe-webhook-upstream")
    const now = bootedAt + 5 * DAY
    const d = webhookIngestDiag(now, probe(null, now - MIN))
    expect(d.missedDeliveryApps).toEqual([])
    expect(d.staleProbeApps).toEqual([])
  })

  it("a probe with no report past the stale limit is listed as stale, never as a missed delivery", () => {
    const bootedAt = Date.now() - 5 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, "probe-webhook-upstream")
    const lastDelivery = bootedAt + 3 * DAY
    recordWebhookAccepted("shopify", lastDelivery)
    const now = lastDelivery + 41 * HOUR
    // Last report 3h ago (stale past 2h), and it even claimed a change we never got.
    const stale = webhookIngestDiag(now, probe(lastDelivery + HOUR, now - 3 * HOUR))
    expect(stale.staleProbeApps).toEqual([
      { app: "shopify", lastProbeAgeSec: 3 * 3600, staleAfterSec: 7200, lastFailure: null },
    ])
    expect(stale.missedDeliveryApps).toEqual([])
    // No report on record at all.
    expect(webhookIngestDiag(now, new Map()).staleProbeApps).toEqual([
      { app: "shopify", lastProbeAgeSec: null, staleAfterSec: 7200, lastFailure: null },
    ])
    // A probe the provider refuses says why, so the alert names the fix.
    const refused = new Map([
      ["shopify", { reason: "403 (#200) Requires a permission", failedAtMs: now - 600_000 }],
    ])
    expect(webhookIngestDiag(now, new Map(), refused).staleProbeApps).toEqual([
      {
        app: "shopify",
        lastProbeAgeSec: null,
        staleAfterSec: 7200,
        lastFailure: { reason: "403 (#200) Requires a permission", ageSec: 600 },
      },
    ])
    // A report within the limit is fresh.
    expect(webhookIngestDiag(now, probe(lastDelivery, now - HOUR)).staleProbeApps).toEqual([])
  })

  it("a fresh process does not report a stale probe before its first probe could run", () => {
    const bootedAt = Date.now()
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, "probe-webhook-upstream")
    expect(webhookIngestDiag(bootedAt + HOUR, new Map()).staleProbeApps).toEqual([])
    expect(webhookIngestDiag(bootedAt + 2 * HOUR, new Map()).staleProbeApps).toHaveLength(1)
  })

  it("unreadable probe reports (null) judge neither probe signal", () => {
    const bootedAt = Date.now() - 5 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", ORG, "probe-webhook-upstream")
    const d = webhookIngestDiag(bootedAt + 5 * DAY, null)
    expect(d.staleProbeApps).toEqual([])
    expect(d.missedDeliveryApps).toEqual([])
  })

  it("the contract follows the orgs still registered for the app", () => {
    const bootedAt = Date.now() - 5 * DAY
    resetWebhookIngestHealth(bootedAt)
    declareWebhookHealth("shopify", "org-a", "probe-webhook-upstream")
    declareWebhookHealth("shopify", "org-b", "probe-webhook-upstream")
    forgetWebhookHealth("shopify", "org-a")
    expect(webhookIngestDiag(bootedAt + 5 * DAY, new Map()).probedApps).toEqual(["shopify"])
    forgetWebhookHealth("shopify", "org-b")
    expect(webhookIngestDiag(bootedAt + 5 * DAY, new Map()).probedApps).toEqual([])
  })
})

describe("parseUpstreamProbeResult", () => {
  it("accepts an ISO timestamp or null, and nothing else", () => {
    expect(parseUpstreamProbeResult({ upstreamActivityAt: "2026-10-10T18:27:31Z" })).toEqual({
      activityAtMs: Date.parse("2026-10-10T18:27:31Z"),
    })
    expect(parseUpstreamProbeResult({ upstreamActivityAt: null })).toEqual({ activityAtMs: null })
    // An unreachable sender is no report: never read as a quiet one.
    expect(parseUpstreamProbeResult({ probed: false, reason: "503" })).toBeUndefined()
    expect(parseUpstreamProbeResult({ upstreamActivityAt: "garbage" })).toBeUndefined()
    expect(parseUpstreamProbeResult(undefined)).toBeUndefined()
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Inbound-webhook ingest health: the /diag signal that a provider's webhook
// stream has stopped landing while everything else stays green.
//
// Every app that declares webhooks also declares a webhook-health contract in
// its manifest (`webhookHealth`): either a scheduled probe job that reports the
// newest change its sender knows about, or `probe: null` with the reason no
// upstream can be queried. The kernel judges each app by evidence, never by how
// long it has been quiet, because silence alone cannot tell a quiet sender from
// a dead pipe. Three signals:
//
//   * rejectingWithoutSuccess (every app): deliveries keep arriving and the
//     verifier refuses all of them. A live sender we turn away, typically a
//     webhook secret that drifted from the one the provider was registered with.
//   * missed delivery (probed apps): the probe saw an upstream change newer than
//     anything this process accepted (or its boot), older than the delivery
//     grace. The sender had something to send and it never reached us. The grace
//     is the app's own (`webhookHealth.deliveryGraceSec`): a sender that delivers
//     well after the change it reports declares how long it takes.
//   * stale probe (probed apps): no successful probe report for longer than
//     WEBHOOK_PROBE_STALE_SEC. Not an ingest failure in itself, but the evidence
//     that would catch one is missing, so it is listed on its own.
//
// An unprobed app is judged by rejections only; however long it stays quiet,
// quiet is never an alert.
//
// The counters are in-process and unpersisted (a liveness signal, not an audit
// trail: the app's own ledger is that), so they reset on restart. `uptimeSec`
// ships with them and every signal is gated on a warm-up, so a redeploy never
// reads as an outage. Probe reports live in Redis (upstream-activity.ts) because
// jobs may run in another process.

/** Per-app inbound counters. Keyed by manifest app name. */
interface AppIngestState {
  acceptedTotal: number
  rejectedTotal: number
  lastAcceptedAt: number | null
  lastRejectedAt: number | null
  /** First rejection since the last accepted delivery (or boot). */
  firstRejectedAt: number | null
  /** Most recent verifier reason (signature_mismatch / missing_secret / …). */
  lastRejectedReason: string | null
}

const state = new Map<string, AppIngestState>()
// Mutable so the reset seam can re-anchor uptime; in production this is written
// exactly once, at module load.
let startedAt = Date.now()

function entry(appName: string): AppIngestState {
  let s = state.get(appName)
  if (!s) {
    s = {
      acceptedTotal: 0,
      rejectedTotal: 0,
      lastAcceptedAt: null,
      lastRejectedAt: null,
      firstRejectedAt: null,
      lastRejectedReason: null,
    }
    state.set(appName, s)
  }
  return s
}

/** A delivery passed verification and reached its app handler. */
export function recordWebhookAccepted(appName: string, now = Date.now()): void {
  const s = entry(appName)
  s.acceptedTotal++
  s.lastAcceptedAt = now
  s.firstRejectedAt = null
}

/** A delivery was refused at the verifier (401) and never reached the app. */
export function recordWebhookRejected(
  appName: string,
  reason: string | null,
  now = Date.now(),
): void {
  const s = entry(appName)
  s.rejectedTotal++
  s.lastRejectedAt = now
  s.firstRejectedAt ??= now
  s.lastRejectedReason = reason
}

export interface AppWebhookIngest {
  app: string
  acceptedTotal: number
  rejectedTotal: number
  lastAcceptedAgeSec: number | null
  lastRejectedAgeSec: number | null
  lastRejectedReason: string | null
  /** True when this app is rejecting deliveries and has accepted none since. */
  rejectingWithoutSuccess: boolean
}

/** A probed app whose sender changed something that never reached us. */
export interface MissedDeliveryApp extends AppWebhookIngest {
  /** Age of the newest upstream change the probe reported. */
  upstreamActivityAgeSec: number
  /** The delivery grace this app is judged by (its own, or the default). */
  deliveryGraceSec: number
}

/** A probed app whose probe has not reported successfully for too long. */
export interface StaleProbeApp {
  app: string
  /** Age of the last successful probe report; null when none is on record. */
  lastProbeAgeSec: number | null
  staleAfterSec: number
  /**
   * Why the probe last could not look (the app's own `{ probed: false, reason }`,
   * e.g. the provider refusing a token that lacks a permission), with its age;
   * null when no failure is on record, i.e. the probe job is not running at all.
   */
  lastFailure: { reason: string; ageSec: number } | null
}

export interface WebhookIngestDiag {
  /** Seconds this process has been up: every signal below is warm-up gated on it. */
  uptimeSec: number
  /** Apps that have rejected at least one delivery since boot. */
  rejectingApps: AppWebhookIngest[]
  /** Probed apps whose probe saw an upstream change that was never delivered. */
  missedDeliveryApps: MissedDeliveryApp[]
  /** Probed apps without a fresh probe report: missed deliveries cannot be judged. */
  staleProbeApps: StaleProbeApp[]
  /** Apps whose manifest declares a probe job. */
  probedApps: string[]
  perApp: AppWebhookIngest[]
}

/**
 * Counters reset on restart, so a single rejected delivery arriving before the first
 * accepted one (plausible in the seconds after a redeploy) would otherwise flag the
 * app as refusing outright with no history behind it. A real outage (continuous
 * 401s) clears this warm-up and the floor and span below within minutes.
 */
const WEBHOOK_REJECT_WARMUP_SEC = Number(process.env.WEBHOOK_REJECT_WARMUP_SEC ?? 900)

/**
 * The rejection signal must not be drivable by whoever knows a webhook URL (the org id
 * is in every URL handed to a provider). A live sender being refused keeps being
 * refused, so "rejecting" needs a floor of rejections AND that they span a stretch of
 * time; a burst of junk from one caller clears the floor but not the span.
 */
const WEBHOOK_REJECT_FLOOR = 5
const WEBHOOK_REJECT_SPAN_SEC = Number(process.env.WEBHOOK_REJECT_SPAN_SEC ?? 600)

/**
 * How old the last successful probe report may be before the app is listed as stale.
 * Also the boot warm-up for that list, so a fresh install whose first probe has not
 * run yet is not reported.
 */
const WEBHOOK_PROBE_STALE_SEC = Number(process.env.WEBHOOK_PROBE_STALE_SEC ?? 7200)

/**
 * How long a change upstream may go undelivered before it counts as missed, for an
 * app that declares no grace of its own: covers sender-side delivery delay, retries
 * and clock skew between the two.
 */
const WEBHOOK_DELIVERY_GRACE_SEC = Number(process.env.WEBHOOK_DELIVERY_GRACE_SEC ?? 1800)

/** One org's webhook-health contract for an app (manifest `webhookHealth`). */
interface WebhookHealthContract {
  /** The probe job, null when the app declares none. */
  probe: string | null
  /** `webhookHealth.deliveryGraceSec`, when the app declares one. */
  deliveryGraceSec?: number
}

/**
 * Declared contract per app and org. Keyed by org too, so uninstalling the app from
 * one org does not drop the contract another org still runs under.
 */
const healthByApp = new Map<string, Map<string, WebhookHealthContract>>()

/** Record the webhook-health contract an app registered with for one org. */
export function declareWebhookHealth(
  appName: string,
  orgId: string,
  probe: string | null,
  deliveryGraceSec?: number,
): void {
  let byOrg = healthByApp.get(appName)
  if (!byOrg) {
    byOrg = new Map()
    healthByApp.set(appName, byOrg)
  }
  byOrg.set(orgId, { probe, ...(deliveryGraceSec !== undefined ? { deliveryGraceSec } : {}) })
}

/** Drop an org's contract for an app (the app was unregistered for that org). */
export function forgetWebhookHealth(appName: string, orgId: string): void {
  const byOrg = healthByApp.get(appName)
  if (!byOrg) return
  byOrg.delete(orgId)
  if (byOrg.size === 0) healthByApp.delete(appName)
}

/** The probe job this app declared, or null when it declares none. */
export function webhookProbeJob(appName: string): string | null {
  for (const { probe } of healthByApp.get(appName)?.values() ?? []) {
    if (probe) return probe
  }
  return null
}

/**
 * The delivery grace an app is judged by: the longest any org's contract declares
 * (two orgs on different app versions during a rollout never page on the shorter),
 * else the default.
 */
export function webhookDeliveryGraceSec(appName: string): number {
  let grace: number | undefined
  for (const c of healthByApp.get(appName)?.values() ?? []) {
    if (c.deliveryGraceSec !== undefined) grace = Math.max(grace ?? 0, c.deliveryGraceSec)
  }
  return grace ?? WEBHOOK_DELIVERY_GRACE_SEC
}

function failureOf(f: UpstreamProbeFailure | undefined, now: number): StaleProbeApp["lastFailure"] {
  return f ? { reason: f.reason, ageSec: Math.floor((now - f.failedAtMs) / 1000) } : null
}

/** Apps judged by an upstream probe. */
export function webhookUpstreamProbeApps(): string[] {
  return [...healthByApp.keys()].filter((app) => webhookProbeJob(app) !== null).sort()
}

/** Newest reason a probe could not look, for one app (see upstream-activity.ts). */
export interface UpstreamProbeFailure {
  reason: string
  failedAtMs: number
}

/** Latest probe report for one app (see upstream-activity.ts). */
export interface UpstreamActivity {
  /** Newest upstream change the probe saw, epoch ms; null = sender has nothing. */
  activityAtMs: number | null
  /** When the probe last reported, epoch ms. */
  probedAtMs: number
}

/**
 * @param upstream probe reports per app, or null when they could not be read
 *   (Redis down or slow): then neither probe signal is judged this round, since an
 *   unreadable report is not evidence that the probe stopped.
 */
export function webhookIngestDiag(
  now = Date.now(),
  upstream: ReadonlyMap<string, UpstreamActivity> | null = new Map(),
  probeFailures: ReadonlyMap<string, UpstreamProbeFailure> = new Map(),
): WebhookIngestDiag {
  const uptimeSec = Math.floor((now - startedAt) / 1000)
  const probedApps = webhookUpstreamProbeApps()
  // A probed app is judged even before its first delivery since boot: a pipe that
  // died across a redeploy accepts nothing, so it would otherwise never be listed.
  for (const app of probedApps) entry(app)
  const perApp: AppWebhookIngest[] = []
  for (const [app, s] of state) {
    perApp.push({
      app,
      acceptedTotal: s.acceptedTotal,
      rejectedTotal: s.rejectedTotal,
      lastAcceptedAgeSec:
        s.lastAcceptedAt === null ? null : Math.floor((now - s.lastAcceptedAt) / 1000),
      lastRejectedAgeSec:
        s.lastRejectedAt === null ? null : Math.floor((now - s.lastRejectedAt) / 1000),
      lastRejectedReason: s.lastRejectedReason,
      rejectingWithoutSuccess:
        uptimeSec >= WEBHOOK_REJECT_WARMUP_SEC &&
        s.rejectedTotal >= WEBHOOK_REJECT_FLOOR &&
        s.acceptedTotal === 0 &&
        s.firstRejectedAt !== null &&
        s.lastRejectedAt !== null &&
        s.lastRejectedAt - s.firstRejectedAt >= WEBHOOK_REJECT_SPAN_SEC * 1000,
    })
  }
  perApp.sort((a, b) => (a.app < b.app ? -1 : 1))

  const rejectingApps = perApp.filter((a) => a.rejectedTotal > 0)
  const missedDeliveryApps: MissedDeliveryApp[] = []
  const staleProbeApps: StaleProbeApp[] = []
  if (upstream) {
    for (const a of perApp) {
      if (!probedApps.includes(a.app)) continue
      const probe = upstream.get(a.app)
      if (!probe || now - probe.probedAtMs > WEBHOOK_PROBE_STALE_SEC * 1000) {
        if (uptimeSec >= WEBHOOK_PROBE_STALE_SEC) {
          staleProbeApps.push({
            app: a.app,
            lastProbeAgeSec: probe ? Math.floor((now - probe.probedAtMs) / 1000) : null,
            staleAfterSec: WEBHOOK_PROBE_STALE_SEC,
            lastFailure: failureOf(probeFailures.get(a.app), now),
          })
        }
        continue
      }
      if (probe.activityAtMs === null) continue
      // Anything before boot was either delivered to the previous process or is
      // beyond what this one can know; judge only what happened while we listened.
      const heardUpTo = Math.max(state.get(a.app)?.lastAcceptedAt ?? 0, startedAt)
      const deliveryGraceSec = webhookDeliveryGraceSec(a.app)
      if (probe.activityAtMs > heardUpTo && now - probe.activityAtMs > deliveryGraceSec * 1000) {
        missedDeliveryApps.push({
          ...a,
          upstreamActivityAgeSec: Math.floor((now - probe.activityAtMs) / 1000),
          deliveryGraceSec,
        })
      }
    }
  }

  return { uptimeSec, rejectingApps, missedDeliveryApps, staleProbeApps, probedApps, perApp }
}

/** Test seam: drops all counters and declarations and re-anchors uptime. */
export function resetWebhookIngestHealth(startedAtMs = Date.now()): void {
  state.clear()
  healthByApp.clear()
  startedAt = startedAtMs
}

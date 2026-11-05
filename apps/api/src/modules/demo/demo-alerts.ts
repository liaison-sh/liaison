// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE OWNER ALERT, AND WHY VISITOR SPEND FAILS CLOSED WITHOUT IT.
//
// Visitor budgets bound what the box can spend, and the owner alert is what
// tells a person that the bound is being approached: box spend crossing
// LIAISON_DEMO_ALERT_RATIO of the day's budget, any rolling hour reaching the
// hourly cap, a pinned-price drift, and a run of code-send failures. Each is
// mailed to LIAISON_DEMO_ALERT_EMAIL at most once per threshold per UTC day
// (Redis SET NX), through the demo system mail channel only.
//
// A budget nobody is told about is not a control, so visitor spend on the
// box key is ON only when BOTH the alert address AND a demo mail channel are
// configured. Otherwise every visitor reservation is refused
// `demo_unavailable` and boot logs `alert: demo_spend_disabled` (new visitors
// can still sign up and browse; the reserved org is unaffected). A failed
// alert send is retried, and after three failures visitor spend is switched
// off too, until an alert lands: the alert cannot rest on a channel that is
// down.
//
// A pinned-price drift (the live OpenRouter catalogue lists the pinned model
// above the derivation block's prices) also switches visitor spend off.
import { registerSingleton } from "~/infra/leadership"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import {
  VISITOR_INPUT_USD_PER_M,
  VISITOR_OUTPUT_USD_PER_M,
  WEB_SEARCH_MODEL_INPUT_USD_PER_M,
  WEB_SEARCH_MODEL_OUTPUT_USD_PER_M,
} from "~/modules/demo/demo-spend-ceiling"

const log = rootLogger.child({ module: "demo-alerts" })

/** Sends one fixed-template owner alert. Supplied by the demo system mail channel. */
export type DemoAlertMailer = (msg: { to: string; subject: string; text: string }) => Promise<void>

let mailer: DemoAlertMailer | null = null

/**
 * Register the demo system mail channel's sender. Until one is registered the
 * demo has no way to alert its owner, and visitor spend stays off.
 */
export function registerDemoAlertMailer(m: DemoAlertMailer | null): void {
  mailer = m
}

/** Is a demo mail provider configured (env) AND its sender registered? */
export function demoMailConfigured(): boolean {
  if (!mailer) return false
  return Boolean(
    env.LIAISON_DEMO_MAIL_RESEND_API_KEY ||
      env.SYSTEM_RESEND_API_KEY ||
      env.SMTP_HOST ||
      env.LIAISON_DEMO_MAIL_CAPTURE,
  )
}

const ALERT_DOWN_KEY = "demo:b:alert:down"
const ALERT_RETRY_KEY = "demo:b:alert:retry"
const PRICE_DRIFT_KEY = "demo:b:alert:price-drift"
const SEND_ATTEMPTS = 3

export type DemoSpendState = "on" | "no_alert_email" | "no_mail" | "alert_down" | "price_drift"

let disabledLogged = false

/**
 * Whether visitor spend on the box key is on, and if not why. Every visitor
 * reservation asks this first. "on" without a query on a normal deployment.
 */
export async function demoVisitorSpendState(): Promise<DemoSpendState> {
  if (!isDemoModeEnabled()) return "on"
  let state: DemoSpendState = "on"
  if (!env.LIAISON_DEMO_ALERT_EMAIL) state = "no_alert_email"
  else if (!demoMailConfigured()) state = "no_mail"
  else if (await redis.exists(PRICE_DRIFT_KEY)) state = "price_drift"
  else if (await redis.exists(ALERT_DOWN_KEY)) {
    await retryPendingAlert()
    state = (await redis.exists(ALERT_DOWN_KEY)) ? "alert_down" : "on"
  }
  if (state !== "on" && !disabledLogged) {
    disabledLogged = true
    // A box configured without an alert address or a mail channel is a
    // deliberate fail-closed state, said once (at boot) as a warning; an alert
    // that stopped landing or a price that drifted is a fault.
    const configured = state === "no_alert_email" || state === "no_mail"
    log[configured ? "warn" : "error"](
      { alert: "demo_spend_disabled", reason: state },
      "visitor spend on this demo box's key is OFF until the owner alert can be delivered",
    )
  }
  if (state === "on") disabledLogged = false
  return state
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

async function sendWithRetry(msg: { subject: string; text: string }): Promise<boolean> {
  const to = env.LIAISON_DEMO_ALERT_EMAIL
  if (!to || !mailer) return false
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      await mailer({ to, ...msg })
      return true
    } catch (err) {
      log.warn({ err, attempt }, "demo owner alert send failed")
    }
  }
  return false
}

/**
 * Mail an alert once per `threshold` per UTC day. After SEND_ATTEMPTS failures
 * the alert is kept as pending and visitor spend goes off until it lands.
 */
export async function sendDemoAlertOnce(
  threshold: string,
  msg: { subject: string; text: string },
  nowMs: number = Date.now(),
): Promise<void> {
  const onceKey = `demo:b:alert:sent:${threshold}:${utcDay(nowMs)}`
  const fresh = await redis.set(onceKey, "1", "PX", 2 * 24 * 60 * 60 * 1000, "NX")
  if (fresh !== "OK") return
  log.warn({ alert: `demo_${threshold}` }, msg.subject)
  if (await sendWithRetry(msg)) return
  await redis.set(ALERT_DOWN_KEY, JSON.stringify(msg))
  log.error(
    { alert: "demo_alert_channel_down", threshold },
    "the demo owner alert could not be sent: visitor spend is off until one lands",
  )
}

/** While the channel is down, retry the pending alert at most once a minute. */
async function retryPendingAlert(): Promise<void> {
  const fresh = await redis.set(ALERT_RETRY_KEY, "1", "PX", 60_000, "NX")
  if (fresh !== "OK") return
  const raw = await redis.get(ALERT_DOWN_KEY)
  if (!raw) return
  const msg = JSON.parse(raw) as { subject: string; text: string }
  if (await sendWithRetry(msg)) {
    await redis.del(ALERT_DOWN_KEY)
    log.info("the pending demo owner alert was delivered: visitor spend is back on")
  }
}

const eur = (micro: number) => (micro / 1_000_000).toFixed(2)

/**
 * After a settle: alert at the day's ratio and when an hour reaches its cap.
 * Called by demo-budget.ts with the ledger's totals.
 */
export async function notifyDemoSpendSettled(s: {
  day: string
  boxDayMicroEur: number
  boxHourMicroEur: number
  caps: { box: number; hour: number }
}): Promise<void> {
  if (!isDemoModeEnabled()) return
  const ratio = env.LIAISON_DEMO_ALERT_RATIO
  if (s.boxDayMicroEur >= s.caps.box * ratio) {
    await sendDemoAlertOnce("box_day_ratio", {
      subject: `Demo spend at ${Math.round(ratio * 100)}% of the daily budget`,
      text: `Visitor spend on the demo box today (${s.day}, UTC) is EUR ${eur(s.boxDayMicroEur)} of EUR ${eur(s.caps.box)}.`,
    })
  }
  if (s.boxHourMicroEur >= s.caps.hour) {
    await sendDemoAlertOnce("box_hour_cap", {
      subject: "Demo spend reached the hourly cap",
      text: `Visitor spend on the demo box in the last hour is EUR ${eur(s.boxHourMicroEur)}, the hourly cap is EUR ${eur(s.caps.hour)}.`,
    })
  }
}

const CODE_SEND_FAILURES_PER_HOUR = 5

/**
 * Count one verification-code send that the mail provider refused (bounce,
 * complaint, error). Five in an hour alert the owner.
 */
export async function recordDemoCodeSendFailure(nowMs: number = Date.now()): Promise<void> {
  if (!isDemoModeEnabled()) return
  const hour = Math.floor(nowMs / 3_600_000)
  const key = `demo:b:alert:code-fail:${hour}`
  const n = await redis.incr(key)
  if (n === 1) await redis.pexpire(key, 2 * 3_600_000)
  if (n >= CODE_SEND_FAILURES_PER_HOUR) {
    await sendDemoAlertOnce(`code_send_failures_${hour}`, {
      subject: "Demo verification mail is failing",
      text: `${n} verification code sends failed in the last hour.`,
    })
  }
}

type CatalogueFetch = () => Promise<unknown>

let catalogueFetch: CatalogueFetch = async () => {
  const { openRouterFetch } = await import("~/modules/agent/providers/openrouter")
  const res = await openRouterFetch("/models", { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`OpenRouter /models answered ${res.status}`)
  return res.json()
}

/** Test seam: the catalogue the drift check reads. */
export const DemoAlertsTestAccess = {
  setCatalogueFetch(fn: CatalogueFetch | null): void {
    catalogueFetch = fn ?? catalogueFetch
  },
  resetLogged(): void {
    disabledLogged = false
  },
}

/**
 * The catalogue's per-search fee the web-search budget leaves room for (USD):
 * the derivation block's 0.025 USD per search less the cited excerpts' tokens
 * (about 0.0017 USD at the plugin model's prompt price). The row lists 0.014
 * today. The Exa plugin's per-result fee is not on the catalogue: it is
 * bounded by `max_results`, and the ledger records what each search reported.
 */
const WEB_SEARCH_ROW_MAX_USD = 0.023

/** One model the box key can reach, and the most its catalogue row may list. */
interface PriceWatch {
  id: string
  /** USD per 1M tokens, when the row is priced by tokens. */
  promptPerM?: number
  completionPerM?: number
  /** USD per request and per web search (an absent field is 0). */
  request: number
  webSearch: number
  /** A row missing from the catalogue is drift (else it is not checked). */
  required: boolean
}

/**
 * Every model the box key can reach for a visitor, with the prices its
 * budgets assume: the chat pin, the web-search plugin model, and the
 * transcription models (per-second rates are not on the catalogue, so only a
 * per-request fee is watched there, when the row is listed).
 */
async function priceWatches(pinId: string): Promise<PriceWatch[]> {
  const { OPENROUTER_WEB_SEARCH_MODEL } = await import(
    "~/modules/agent/tools/web-search-openrouter"
  )
  const { TRANSCRIPTION_MODELS } = await import("~/modules/assist/transcription-models")
  return [
    {
      id: pinId,
      promptPerM: VISITOR_INPUT_USD_PER_M,
      completionPerM: VISITOR_OUTPUT_USD_PER_M,
      request: 0,
      webSearch: 0,
      required: true,
    },
    {
      id: OPENROUTER_WEB_SEARCH_MODEL,
      promptPerM: WEB_SEARCH_MODEL_INPUT_USD_PER_M,
      completionPerM: WEB_SEARCH_MODEL_OUTPUT_USD_PER_M,
      request: 0,
      webSearch: WEB_SEARCH_ROW_MAX_USD,
      required: true,
    },
    ...TRANSCRIPTION_MODELS.filter((m) => m.provider === "openrouter").map((m) => ({
      id: m.upstreamId,
      request: 0,
      webSearch: 0,
      required: false,
    })),
  ]
}

type CatalogueRow = {
  id?: unknown
  pricing?: { prompt?: unknown; completion?: unknown; request?: unknown; web_search?: unknown }
}

/** Why `row` is priced above `watch`, or null when it is within it. */
function driftOf(watch: PriceWatch, row: CatalogueRow | undefined): string | null {
  if (!row) return watch.required ? `${watch.id}: not listed` : null
  const p = row.pricing ?? {}
  const perM = (v: unknown) => Number(v) * 1_000_000
  const fee = (v: unknown) => (v === undefined || v === null || v === "" ? 0 : Number(v))
  const reasons: string[] = []
  if (watch.promptPerM !== undefined) {
    const v = perM(p.prompt)
    if (!Number.isFinite(v) || v > watch.promptPerM + 1e-9) reasons.push(`prompt ${v}/M`)
  }
  if (watch.completionPerM !== undefined) {
    const v = perM(p.completion)
    if (!Number.isFinite(v) || v > watch.completionPerM + 1e-9) reasons.push(`completion ${v}/M`)
  }
  const request = fee(p.request)
  if (!Number.isFinite(request) || request > watch.request + 1e-12) {
    reasons.push(`request ${request}`)
  }
  const webSearch = fee(p.web_search)
  if (!Number.isFinite(webSearch) || webSearch > watch.webSearch + 1e-12) {
    reasons.push(`web_search ${webSearch}`)
  }
  return reasons.length > 0 ? `${watch.id}: ${reasons.join(", ")}` : null
}

/**
 * Compare the live catalogue price of every model the box key can reach for a
 * visitor (the pinned chat model, the web-search model, the transcription
 * models) with the prices its budgets assume: tokens, and the per-request and
 * per-search fees `max_price` does not bound. Dearer (or a required row
 * absent) → visitor spend off and the owner alerted. A catalogue that cannot
 * be read changes nothing (OpenRouter's `max_price` on every chat request
 * still caps what a call can cost).
 */
export async function checkDemoPriceDrift(upstreamId: string): Promise<"ok" | "drift" | "unknown"> {
  if (!isDemoModeEnabled()) return "ok"
  let body: unknown
  try {
    body = await catalogueFetch()
  } catch (err) {
    log.warn({ err }, "demo price drift check: catalogue unreadable")
    return "unknown"
  }
  const data = (body as { data?: unknown } | null)?.data
  const rows = Array.isArray(data) ? (data as CatalogueRow[]) : []
  const drifts: string[] = []
  for (const watch of await priceWatches(upstreamId)) {
    const drift = driftOf(
      watch,
      rows.find((r) => r?.id === watch.id),
    )
    if (drift) drifts.push(drift)
  }
  if (drifts.length === 0) {
    await redis.del(PRICE_DRIFT_KEY)
    return "ok"
  }
  await redis.set(PRICE_DRIFT_KEY, "1")
  log.error(
    { alert: "demo_price_drift", upstreamId, drifts },
    "a model the demo box key reaches is priced above its budget: visitor spend is off",
  )
  await sendDemoAlertOnce("price_drift", {
    subject: "Demo pinned model price drift",
    text: `A model the demo box key reaches is listed above the prices its budget assumes (chat ${VISITOR_INPUT_USD_PER_M} / ${VISITOR_OUTPUT_USD_PER_M} USD per 1M tokens, no per-request fee). Visitor spend is off. ${drifts.join("; ")}.`,
  })
  return "drift"
}

/**
 * The boot check, per process: logs why visitor spend is off. For the boot
 * sequence to call once, in demo mode. The pinned price check is the leader's
 * (`registerDemoPriceCheckSingleton`).
 */
export async function demoSpendBootCheck(): Promise<void> {
  if (!isDemoModeEnabled()) return
  disabledLogged = false
  await demoVisitorSpendState()
}

/** How often the leader re-checks the pinned price. */
export const DEMO_PRICE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000

let priceCheckTimer: ReturnType<typeof setInterval> | null = null

function stopPriceCheck(): void {
  if (priceCheckTimer) clearInterval(priceCheckTimer)
  priceCheckTimer = null
}

/**
 * Make the pinned price check the `demo-price-check` singleton: taking the
 * leader lease checks at once and then every `everyMs`; losing it stops the
 * interval. Does nothing outside demo mode.
 */
export function registerDemoPriceCheckSingleton(
  upstreamId: string,
  everyMs: number = DEMO_PRICE_CHECK_EVERY_MS,
): void {
  if (!isDemoModeEnabled()) return
  const check = () => {
    void checkDemoPriceDrift(upstreamId).catch((err) =>
      log.error({ err, alert: "demo_price_check_failed" }, "demo price drift check failed"),
    )
  }
  registerSingleton({
    name: "demo-price-check",
    onAcquired: () => {
      stopPriceCheck()
      check()
      priceCheckTimer = setInterval(check, everyMs)
      priceCheckTimer.unref?.()
    },
    onLost: stopPriceCheck,
  })
}

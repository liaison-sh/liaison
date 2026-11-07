// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The spend rules for demo orgs. Two kinds of org spend this box's money, and
// each is bounded.
//
// ── A VERIFIED VISITOR SPENDS INSIDE A BUDGET ──────────────────────────────
// A visitor registers, is handed their own ephemeral org and is the admin of
// it. Until they confirm an email address their agents run on THEIR key or not
// at all. Once confirmed, their agents may run on this box's OpenRouter key, on
// ONE pinned model, inside budgets in micro-EUR (demo-budget.ts): per email
// (lifetime), per client network and per box per UTC day, and per rolling box
// hour. Three rules carry it:
//
//   * The box key is a CAPABILITY. `resolveKey` (credit-meter.ts) hands it to a
//     visitor org only against a live reservation, only for OpenRouter, only
//     for the pinned model (or the web-search / transcription model). No other
//     provider's environment key is ever returned to a visitor org.
//   * The pin comes from code and env (`demoVisitorModelInfo`), never from org
//     settings, which the visitor administers.
//   * Every step reserves its worst cost on all four budgets in ONE atomic
//     Redis script before it runs and settles its actual cost after; the
//     durable copy is `kernel.demo_spend` (written here, first).
//
// With no owner alert address or no demo mail channel the visitor half is OFF
// (demo-alerts.ts): a budget nobody is told about is not a control.
//
// ── THE RESERVED ORG IS THE OTHER EXCEPTION, AND IT IS CAPPED ──────────────
// Apple's Beta App Review needs credentials without registering, so exactly one
// org carries `variant: "reserved"`. A reviewer will not paste a key, so that
// org DOES fall back to the deployment's own key, under a hard, low TOKEN
// ceiling over a ROLLING WINDOW (a lifetime total on an org that is never
// replaced would lock App Review out for good).
//
// It counts what is in flight: each admitted turn takes a reservation, an
// atomic Redis INCRBY of one turn's worth of tokens, released by
// `finalizeUsage` and expiring on its own if a turn dies without one.
// `used + reserved` is compared against the ceiling in that one atomic step,
// so concurrent turns see each other. The recorded half sums the `byok_usage`
// and `usage` rows of `credit_transactions`.
//
// Every entry point below returns on its FIRST line when demo mode is off, so a
// normal deployment does not reach a query, a branch or an allocation here.
import type { ShippedLocale } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { serverT } from "~/modules/i18n/server-i18n"

const log = rootLogger.child({ module: "demo-spend" })

/**
 * The window the reserved org's ceiling is denominated in. A day, in code
 * rather than in env: the number an operator retunes is the ceiling, and a
 * second knob is a second way for the two to disagree.
 */
const RESERVED_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * One turn's worth of tokens, held while the turn runs. Deliberately generous:
 * a turn that really spends this much is rare, and the cost of guessing high is
 * a review session that runs out slightly early, while the cost of guessing low
 * is the concurrency hole this exists to close.
 */
const TURN_RESERVATION_TOKENS = 25_000

/**
 * A reservation whose turn never reported back expires rather than leaking, so
 * a crashed process cannot permanently shrink the budget. Longer than any agent
 * turn, shorter than a review session.
 */
const RESERVATION_TTL_SECONDS = 15 * 60

const reservationKey = (orgId: string): string => `demo:spend-reserve:${orgId}`

/**
 * Thrown by `resolveKey` when a demo org reaches for the deployment's own model
 * key. A distinct type, not a bare Error, because `preCheck` has to tell it
 * apart from a genuinely misconfigured provider: that is a 500 an operator must
 * fix, and this is a 400 the visitor fixes themselves by pasting a key.
 */
export class DemoKeyRequiredError extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = "DemoKeyRequiredError"
  }
}

/** The refusal `preCheck` returns, in `preCheck`'s own vocabulary. */
export interface DemoSpendBlock {
  allowed: false
  status: 400 | 402
  persistSystemMessage: boolean
  reason: string
}

/**
 * Tokens this org has spent inside the window. One extra predicate on
 * `(org_id, created_at)`, which is an index the table already carries.
 */
export async function demoOrgTokensUsed(
  orgId: string,
  windowMs: number = RESERVED_WINDOW_MS,
): Promise<number> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withPrivilegedDb(orgId, "demo-spend-tokens", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total
      FROM ${k}.credit_transactions
      WHERE org_id = ${orgId}::uuid
        AND created_at > now() - make_interval(secs => ${windowMs / 1000}::double precision)
    `)
    return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  })
  return Number((rows[0] as { total: unknown } | undefined)?.total ?? 0)
}

/**
 * Take one turn's reservation and return the org's total reserved tokens,
 * INCLUDING this one. Atomic: two concurrent turns get 1x and 2x, never the
 * same number twice.
 */
async function reserveTurn(orgId: string): Promise<number> {
  const total = await redis.incrby(reservationKey(orgId), TURN_RESERVATION_TOKENS)
  await redis.expire(reservationKey(orgId), RESERVATION_TTL_SECONDS)
  return total
}

/** Give one turn's reservation back, never letting the counter go negative. */
async function unreserveTurn(orgId: string): Promise<void> {
  const total = await redis.decrby(reservationKey(orgId), TURN_RESERVATION_TOKENS)
  if (total <= 0) await redis.del(reservationKey(orgId))
}

/** Tokens currently held by in-flight turns for this org. Zero on a Redis miss. */
export async function demoOrgTokensReserved(orgId: string): Promise<number> {
  const raw = await redis.get(reservationKey(orgId))
  return Math.max(0, Number(raw ?? 0))
}

/**
 * Refuse unless this is the ONE demo org allowed to spend the deployment's own
 * model key.
 *
 * Read by `resolveKey` in the credit meter, which falls back to
 * `process.env[ENV_KEY_MAP[provider]]` when an org has no BYOK key of its own.
 * On a demo box that fallback would hand every visitor a key we pay for, so it
 * is off for a visitor org and on only for the reserved App Review org, whose
 * spend is then bounded by the ceiling below.
 *
 * Returns (fallback allowed, behaviour unchanged) on every normal deployment
 * and for every unmarked org, without a query on the first line.
 */
export async function assertDemoPlatformKeyAllowed(orgId: string): Promise<void> {
  if (!isDemoModeEnabled()) return
  const { marker, locale } = await loadDemoOrg(orgId)
  if (!marker) return
  if (marker.variant === "reserved") return
  throw new DemoKeyRequiredError(serverT(locale, "kernel.demo.byokRequired"))
}

/**
 * The same rule as a QUESTION rather than a refusal, for the surfaces that
 * advertise what an org can do before it tries.
 *
 * `isProviderConfigured` used to answer "is there a key in the environment?"
 * with no demo gate at all, while `resolveKey` refused that key on a visitor
 * org. Three surfaces then told a visitor something untrue: the model picker
 * listed every model the box holds a key for and each one 400ed at send,
 * `web_search` was advertised to the agent and always refused, and the message
 * indexer's embedder resolved as configured, threw at `resolveKey` and cached
 * the failure. This is the one predicate all three now ask.
 *
 * Returns true on its first line on every normal deployment and for every
 * unmarked org.
 */
export async function demoPlatformKeyAllowed(orgId: string, on?: PrivilegedDb): Promise<boolean> {
  if (!isDemoModeEnabled()) return true
  const { marker } = await loadDemoOrg(orgId, on)
  if (!marker) return true
  return marker.variant === "reserved"
}

/**
 * Is `orgId` the reserved App Review org on a demo box?
 *
 * The reserved org spends the deployment's own model key under a TOKEN ceiling,
 * which is its entire budget rule. On a managed edition `preCheck` would also
 * put it through the credit balance gate, and every demo org's balance is
 * forced to zero by design, so a reviewer's first turn came back 402 "Out of
 * agent usage" with the ceiling untouched. The ceiling governs this org; the
 * balance does not. Latent on a self hosted box, which is a deploy convention
 * and not something the reserved org's usability may rest on.
 *
 * Returns false without a query on every normal deployment.
 */
export async function isReservedDemoOrg(orgId: string): Promise<boolean> {
  if (!isDemoModeEnabled()) return false
  const { marker } = await loadDemoOrg(orgId)
  return marker?.variant === "reserved"
}

/**
 * The one model id the reserved org's paid model calls run on, or null to mean
 * "resolve the model exactly as before".
 *
 * Read by `resolveModelForPreCheck`, which every paid model call resolves its
 * model through (agent turns of every kind, routine ticks, compaction, memory,
 * proofreading, ticket summaries), so a thread, an agent's `modelPreference` or
 * a routine's own pin cannot put App Review on a dearer model than the one the
 * ceiling was priced for (demo-spend-ceiling.ts). Null without a query on every
 * normal deployment.
 */
export async function reservedDemoModelId(
  orgId: string,
  on?: PrivilegedDb,
): Promise<string | null> {
  if (!isDemoModeEnabled()) return null
  const { marker } = await loadDemoOrg(orgId, on)
  if (marker?.variant !== "reserved") return null
  return env.LIAISON_DEMO_RESERVED_MODEL
}

/**
 * Put a paid call that is not a model call into the ceiling's ledger, as
 * `tokens` tokens. For the reserved org only: every other org returns on the
 * first line or two with nothing written. The row is the same `byok_usage`
 * shape a turn lands, so `demoOrgTokensUsed` counts it with no second query.
 * Never throws: the call it records has already been made.
 */
export async function recordReservedDemoSideSpend(
  orgId: string,
  what: { label: string; tokens: number },
): Promise<void> {
  if (!isDemoModeEnabled()) return
  try {
    const { marker } = await loadDemoOrg(orgId)
    if (marker?.variant !== "reserved") return
    const k = drizzleSql.raw(schemaRef("kernel"))
    await withPrivilegedDb(orgId, "demo-side-spend", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO ${k}.credit_transactions
          (org_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost,
           description)
        VALUES (${orgId}::uuid, 'byok_usage', '0', '0', ${what.label}, 0, ${what.tokens}, '0',
                'reserved demo org: a paid call counted as tokens')
      `)
    })
  } catch (err) {
    log.warn({ err, orgId, label: what.label }, "failed to record a reserved demo side spend")
  }
}

/**
 * Release the reservation a finished turn was holding. Called by
 * `finalizeUsage`, which runs once per turn on every path that spends, and is
 * a no-op (no Redis round trip) unless this box is a demo instance and the org
 * is the reserved one. Never throws: a turn that has already produced output
 * must not fail on its accounting.
 */
export async function releaseDemoTurnReservation(orgId: string): Promise<void> {
  if (!isDemoModeEnabled()) return
  try {
    const { marker } = await loadDemoOrg(orgId)
    if (marker?.variant !== "reserved") return
    await unreserveTurn(orgId)
  } catch (err) {
    log.warn({ err, orgId }, "failed to release a demo spend reservation")
  }
}

/**
 * Is the reserved org out of budget RIGHT NOW, counting what is in flight? The
 * mid-turn counterpart of the ceiling: a long agentic turn asks again between
 * steps, so a turn that started inside the budget and was pushed past it by a
 * concurrent one is aborted rather than run to the end.
 */
export async function demoSpendExhausted(orgId: string): Promise<boolean> {
  if (!isDemoModeEnabled()) return false
  const { marker } = await loadDemoOrg(orgId)
  if (marker?.variant !== "reserved") return false
  const [used, reserved] = await Promise.all([
    demoOrgTokensUsed(orgId),
    demoOrgTokensReserved(orgId),
  ])
  return used + reserved >= env.LIAISON_DEMO_RESERVED_TOKEN_CEILING
}

/**
 * Take away whatever credits a demo org was granted. `ensureOrg` only
 * initialises credits when it CREATES an org, and the signup route creates the
 * org itself (at the default zero) before the seeder adopts it, so a seeder's
 * initial balance never lands today. This is the second line: a demo org is
 * zeroed after seeding whatever any provisioning path decided to hand it, so
 * real money is never reachable from a workspace anyone can mint. No-op for a
 * non-demo org, and never on a normal deployment.
 */
export async function zeroDemoOrgCredits(orgId: string): Promise<void> {
  if (!isDemoModeEnabled()) return
  const { marker } = await loadDemoOrg(orgId)
  if (!marker) return
  const k = drizzleSql.raw(schemaRef("kernel"))
  await withPrivilegedDb(orgId, "demo-zero-credits", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${k}.credit_balances
      SET included_balance = 0, purchased_balance = 0
      WHERE org_id = ${orgId}::uuid
        AND (included_balance <> 0 OR purchased_balance <> 0)
    `)
  })
  log.info({ orgId }, "demo org credits zeroed")
}

/**
 * The demo ceiling for one agent turn. Returns null to mean "not the reserved
 * org, or the reserved org still inside its window" — in both cases the caller
 * proceeds exactly as it does today. A visitor org never reaches the ceiling
 * because it spends only its own key.
 */
export async function checkDemoSpendCeiling(orgId: string): Promise<DemoSpendBlock | null> {
  // The whole mechanism is behind this one line on a normal deployment.
  if (!isDemoModeEnabled()) return null
  const { marker, locale } = await loadDemoOrg(orgId)
  if (marker?.variant !== "reserved") return null

  const ceiling = env.LIAISON_DEMO_RESERVED_TOKEN_CEILING
  const used = await demoOrgTokensUsed(orgId)
  // Reserve FIRST, then compare. Reading `used` and then reserving would let
  // two concurrent turns read the same total; the INCRBY is the serialisation
  // point, so the loser of the race sees the winner's reservation in its own
  // return value and refuses itself.
  const reserved = await reserveTurn(orgId)
  // `>=`, the same comparison `demoSpendExhausted` makes between steps. `>` here
  // admitted one more turn at the pre turn gate than the mid step gate allowed,
  // so a turn could be started and then killed on its first step.
  if (used + reserved >= ceiling) {
    await unreserveTurn(orgId)
    log.warn({ orgId, used, reserved, ceiling }, "the reserved demo org hit its token ceiling")
    return {
      allowed: false,
      status: 402,
      persistSystemMessage: true,
      reason: serverT(locale, "kernel.demo.spendCeilingReached"),
    }
  }

  return null
}

// ════════════════════════════════════════════════════════════════════════════
// VERIFIED VISITORS: refusal codes, the pin, the durable ledger.
// ════════════════════════════════════════════════════════════════════════════

/** Every refusal the visitor spend gate answers with (HTTP/WS `code`). */
export const DEMO_SPEND_CODES = [
  "demo_verification_required",
  "demo_budget_exhausted",
  "demo_network_exhausted",
  "demo_box_exhausted",
  "demo_rate_limited",
  "demo_busy",
  "demo_step_limit",
  "demo_unavailable",
  "demo_media_refused",
  "demo_models_locked",
] as const
export type DemoSpendCode = (typeof DEMO_SPEND_CODES)[number]

/**
 * The visitor-facing message of a refusal, in `locale`. The copy is the demo
 * door's (`kernel.demo.refusal.<code>` in the locale files); this module only
 * names the code.
 */
export function demoSpendMessage(code: DemoSpendCode, locale: ShippedLocale = "en"): string {
  return serverT(locale, `kernel.demo.refusal.${code}`)
}

/** HTTP status of each refusal: 402 for money, 429 for rate and load, 403 otherwise. */
export function demoSpendStatus(code: DemoSpendCode): 402 | 403 | 429 | 503 {
  switch (code) {
    case "demo_budget_exhausted":
    case "demo_network_exhausted":
    case "demo_box_exhausted":
      return 402
    case "demo_rate_limited":
    case "demo_busy":
      return 429
    case "demo_unavailable":
      return 503
    default:
      return 403
  }
}

/**
 * A visitor org was refused the box key (or a spend). Extends
 * `DemoKeyRequiredError` so every path that already tells "the visitor can fix
 * this" apart from a misconfiguration keeps doing so, and carries the code.
 */
export class DemoSpendRefusedError extends DemoKeyRequiredError {
  readonly code: DemoSpendCode
  readonly httpStatus: 402 | 403 | 429 | 503
  constructor(
    code: DemoSpendCode,
    locale: ShippedLocale = "en",
    /** What the visitor reads, when the state calls for other words than the code's. */
    message: string = demoSpendMessage(code, locale),
  ) {
    super(message)
    this.name = "DemoSpendRefusedError"
    this.code = code
    this.httpStatus = demoSpendStatus(code)
  }
}

/**
 * `resolveKey` was asked for a box key without a live reservation, for another
 * provider, or for another model. The code says what the visitor can do.
 */
export class DemoReservationRequiredError extends DemoSpendRefusedError {
  constructor(
    code: DemoSpendCode = "demo_verification_required",
    locale: ShippedLocale = "en",
    message?: string,
  ) {
    super(code, locale, message)
    this.name = "DemoReservationRequiredError"
  }
}

/** What kind of demo org `orgId` is. "none" without a query on a normal deployment. */
export async function demoOrgKind(
  orgId: string,
  on?: PrivilegedDb,
): Promise<"none" | "visitor" | "reserved"> {
  if (!isDemoModeEnabled()) return "none"
  const { marker } = await loadDemoOrg(orgId, on)
  if (!marker) return "none"
  return marker.variant === "reserved" ? "reserved" : "visitor"
}

/** Is `orgId` a visitor demo org on a demo box? False without a query elsewhere. */
export async function isVisitorDemoOrg(orgId: string, on?: PrivilegedDb): Promise<boolean> {
  return (await demoOrgKind(orgId, on)) === "visitor"
}

/** The visitor pin's model key (`openrouter/<id>`), from env, never from settings. */
export function demoVisitorModelKey(): string {
  return env.LIAISON_DEMO_VISITOR_MODEL
}

/** The visitor pin's OpenRouter id (what the request body carries). */
export function demoVisitorUpstreamId(): string {
  const key = env.LIAISON_DEMO_VISITOR_MODEL
  return key.startsWith("openrouter/") ? key.slice("openrouter/".length) : key
}

/**
 * The refusal of media analysis for any demo org (the reserved org and
 * visitors alike): one call can carry far more tokens than a step's budget,
 * and its size is not known until it is read. Null on a normal deployment.
 */
export async function demoMediaAnalysisRefusal(orgId: string): Promise<string | null> {
  if (!isDemoModeEnabled()) return null
  const { marker, locale } = await loadDemoOrg(orgId)
  if (!marker) return null
  if (marker.variant === "reserved") return serverT(locale, "kernel.demo.mediaAnalysisOff")
  return demoSpendMessage("demo_media_refused", locale)
}

// ── The durable ledger (kernel.demo_spend, migration 0180) ──────────────────

/** One counter of the ledger. */
export interface DemoLedgerCell {
  budget: "email" | "net" | "box" | "boxhour"
  key: string
  period: string
}

let failLedgerWrites = false

/** Test seam: make every ledger write throw (the "ledger down" case). */
export const DemoSpendLedgerTestAccess = {
  failWrites(on: boolean): void {
    failLedgerWrites = on
  },
}

function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
}

/** The ledger's value of each cell (0 for a cell never written), in order. */
export async function demoLedgerRead(cells: readonly DemoLedgerCell[]): Promise<number[]> {
  if (cells.length === 0) return []
  const k = drizzleSql.raw(schemaRef("kernel"))
  return withSystemDb("demo-ledger-read", async (tx) => {
    const out: number[] = []
    for (const c of cells) {
      const rows = rowsOf(
        await tx.execute(drizzleSql`
          SELECT spent_micro_eur AS v FROM ${k}.demo_spend
          WHERE budget = ${c.budget} AND key = ${c.key} AND period = ${c.period}
        `),
      )
      out.push(Number((rows[0] as { v: unknown } | undefined)?.v ?? 0))
    }
    return out
  })
}

/**
 * Add `amountMicroEur` to every cell in ONE transaction and return each new
 * total. A reservation adds its max before the call runs, and its settle adds
 * the (usually negative) difference to the actual cost, so a cell never goes
 * below zero: a negative amount is floored there (demo-budget.ts).
 */
export async function demoLedgerAdd(
  cells: readonly DemoLedgerCell[],
  amountMicroEur: number,
): Promise<number[]> {
  if (failLedgerWrites) throw new Error("demo ledger write refused (test)")
  const amount = Math.ceil(amountMicroEur)
  const initial = Math.max(0, amount)
  const k = drizzleSql.raw(schemaRef("kernel"))
  return withSystemDb("demo-ledger-add", async (tx) => {
    const out: number[] = []
    for (const c of cells) {
      const rows = rowsOf(
        await tx.execute(drizzleSql`
          INSERT INTO ${k}.demo_spend (budget, key, period, spent_micro_eur, updated_at)
          VALUES (${c.budget}, ${c.key}, ${c.period}, ${initial}, now())
          ON CONFLICT (budget, key, period) DO UPDATE
            SET spent_micro_eur = GREATEST(0, ${k}.demo_spend.spent_micro_eur + ${amount}),
                updated_at = now()
          RETURNING spent_micro_eur AS v
        `),
      )
      out.push(Number((rows[0] as { v: unknown } | undefined)?.v ?? 0))
    }
    return out
  })
}

/**
 * Move every email counter still under a plain address to `keyOf(address)`,
 * adding to what that key already holds. Returns how many moved.
 */
export async function demoLedgerRekeyPlainEmails(
  keyOf: (email: string) => string,
): Promise<number> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  return withSystemDb("demo-ledger-rekey", async (tx) => {
    const rows = rowsOf(
      await tx.execute(drizzleSql`
        DELETE FROM ${k}.demo_spend WHERE budget = 'email' AND key LIKE '%@%'
        RETURNING key, period, spent_micro_eur AS v
      `),
    ) as Array<{ key: string; period: string; v: unknown }>
    for (const r of rows) {
      await tx.execute(drizzleSql`
        INSERT INTO ${k}.demo_spend (budget, key, period, spent_micro_eur, updated_at)
        VALUES ('email', ${keyOf(r.key)}, ${r.period}, ${Number(r.v)}, now())
        ON CONFLICT (budget, key, period) DO UPDATE
          SET spent_micro_eur = ${k}.demo_spend.spent_micro_eur + ${Number(r.v)}, updated_at = now()
      `)
    }
    return rows.length
  })
}

/**
 * Delete the per-network counters of UTC days before `day`. Only the current
 * day's counter is ever read, and its key is the visitor's network range, which
 * is kept no longer than it serves. Returns how many went.
 */
export async function demoLedgerPruneNetworkDays(day: string): Promise<number> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  return withSystemDb("demo-ledger-prune-net", async (tx) => {
    const rows = rowsOf(
      await tx.execute(drizzleSql`
        DELETE FROM ${k}.demo_spend WHERE budget = 'net' AND period < ${day} RETURNING key
      `),
    )
    return rows.length
  })
}

/**
 * A visitor spend refusal as an HTTP error: its real status and its `code`
 * (`errorHandler` passes a typed `{ status, code }` error through as is).
 */
export class DemoSpendHttpError extends Error {
  readonly status: 402 | 403 | 429 | 503
  constructor(
    readonly code: DemoSpendCode,
    message: string,
  ) {
    super(message)
    this.name = "DemoSpendHttpError"
    this.status = demoSpendStatus(code)
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Outside effects that happen once, for app code (`ctx.effects`).
 *
 * A job can run twice: a deploy hands it back to the queue, a crash makes the
 * queue re-run it. `appEffectOnce(ctx.effects, key, fn)` claims `key` in the
 * kernel's effect ledger before `fn` makes its outside call (a transmission, a
 * booking, a mail), and stores what `fn` returned after it. A second run with
 * the same key gets the stored result back instead of calling out again.
 *
 * When an earlier run claimed the key and its process died before it stored
 * the result, nobody knows whether the call happened: the claim is `unknown`.
 * By default the effect is not run again (`{ status: "unknown" }`). An app
 * that can ask the remote side passes `onUnknown`, which answers `done` (it
 * happened: here is its result), `retry` (it did not: run `fn` now) or `skip`.
 *
 * A call that was made but whose outcome is in doubt (a timeout, a server
 * error from the remote side) must not release the claim, or the next run
 * would call again without asking: `fn` throws `EffectOutcomeUnknown`, the
 * claim turns `unknown` (`markUnknown`), and the next run goes through
 * `onUnknown`, which asks the remote side first. Any other error `fn` throws
 * means nothing happened: the claim is released.
 *
 * Keys are the app's own: the kernel prefixes them with the app's name and
 * scopes them to the organization, so two apps never share one.
 */

/** What a claim answers. */
export type EffectClaim =
  | { state: "claimed" }
  | { state: "done"; result: unknown }
  | { state: "in_flight" }
  | { state: "unknown" }

/**
 * The host side of `ctx.effects` (the sandbox bridge). Its answers are JSON,
 * as a string or already parsed depending on how the call was marshalled;
 * `appEffectOnce` reads both.
 */
export interface EffectsBridge {
  claim(key: string, optsJson?: string): Promise<EffectClaim | string>
  complete(key: string, resultJson: string): Promise<{ ok: boolean } | string>
  release(key: string): Promise<{ ok: boolean } | string>
  settleUnknown(key: string, decisionJson: string): Promise<{ ok: boolean } | string>
  /** Turn this run's own claim `unknown` (absent on an older kernel). */
  markUnknown?(key: string): Promise<{ ok: boolean } | string>
}

/**
 * Thrown by `fn` when its outside call was made and the outcome is in doubt.
 * The claim is kept as `unknown` instead of released; `appEffectOnce` rethrows
 * it so the caller can record the attempt.
 */
export class EffectOutcomeUnknown extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "EffectOutcomeUnknown"
  }
}

function parsed<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value
}

export type EffectOnceOutcome<T> =
  | { status: "ran"; result: T }
  | { status: "replayed"; result: T }
  | { status: "unknown" }
  /** Another run holds the key right now: try again later. */
  | { status: "in_flight" }

export type UnknownEffectDecision<T> =
  | { outcome: "done"; result: T }
  | { outcome: "retry" }
  | { outcome: "skip" }

export interface EffectOnceOptions<T> {
  /** A claim older than this is unknown even if its process looks alive (default 600). */
  pendingTtlS?: number
  onUnknown?: () => Promise<UnknownEffectDecision<T>>
}

/**
 * Run `fn` at most once for `key`. Its result is stored as JSON, so a replay
 * returns that JSON: `T` must survive a JSON round trip.
 */
export async function appEffectOnce<T>(
  effects: EffectsBridge,
  key: string,
  fn: () => Promise<T>,
  opts: EffectOnceOptions<T> = {},
): Promise<EffectOnceOutcome<T>> {
  const claim = parsed(
    await effects.claim(
      key,
      JSON.stringify(opts.pendingTtlS !== undefined ? { pendingTtlS: opts.pendingTtlS } : {}),
    ),
  )
  if (claim.state === "done") return { status: "replayed", result: claim.result as T }
  if (claim.state === "in_flight") return { status: "in_flight" }
  if (claim.state === "unknown") {
    const decision: UnknownEffectDecision<T> = opts.onUnknown
      ? await opts.onUnknown()
      : { outcome: "skip" }
    if (decision.outcome === "done") {
      await effects.settleUnknown(key, JSON.stringify({ outcome: "done", result: decision.result }))
      return { status: "replayed", result: decision.result }
    }
    if (decision.outcome === "skip") return { status: "unknown" }
    const reclaimed = parsed(await effects.settleUnknown(key, JSON.stringify({ outcome: "retry" })))
    if (!reclaimed.ok) return { status: "in_flight" }
  }
  let result: T
  try {
    result = await fn()
  } catch (err) {
    if (err instanceof EffectOutcomeUnknown) {
      // Kept unknown: the next run asks the remote side. An older kernel without
      // markUnknown leaves the claim pending, which its deadline turns unknown.
      if (effects.markUnknown) await effects.markUnknown(key)
      throw err
    }
    await effects.release(key)
    throw err
  }
  await storeResult(effects, key, JSON.stringify(result ?? null))
  return { status: "ran", result }
}

/**
 * The bridge's `complete`. Called through a computed member on purpose: the
 * kernel's static org-id tracer binds a plain `x.complete(...)` call by name
 * to an unrelated server function of that name.
 */
async function storeResult(effects: EffectsBridge, key: string, resultJson: string) {
  const method: keyof EffectsBridge = "complete"
  return effects[method](key, resultJson)
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A connection's declared limits (manifest `connections.<name>.limits`), as
// the shared per-connection limiter reads them (connection-limiter.ts). Pure:
// the manifest contract (contract.ts) loads it without Redis.

/** A connection's declared limits (manifest `connections.<name>.limits`). */
export interface ConnectionLimits {
  /** Calls in flight at once. */
  concurrency?: number
  /** Calls started per second, on average. */
  perSecond?: number
  /** Calls that may start at once when the bucket is full (default: `ceil(perSecond)`). */
  burst?: number
}

const MAX_CONCURRENCY = 1_000
const MAX_PER_SECOND = 10_000

/**
 * Problems with a declared `limits` object; empty when valid. The manifest
 * schema checks the shape, this the meaning (also used by the bridge).
 */
export function connectionLimitsErrors(limits: unknown): string[] {
  if (limits === undefined) return []
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    return ["limits must be an object"]
  }
  const l = limits as Record<string, unknown>
  const errors: string[] = []
  for (const k of Object.keys(l)) {
    if (k !== "concurrency" && k !== "perSecond" && k !== "burst") {
      errors.push(`limits.${k} is not a limit`)
    }
  }
  const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v)
  if (
    l.concurrency !== undefined &&
    (!isInt(l.concurrency) ||
      (l.concurrency as number) < 1 ||
      (l.concurrency as number) > MAX_CONCURRENCY)
  ) {
    errors.push(`limits.concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`)
  }
  if (
    l.perSecond !== undefined &&
    (typeof l.perSecond !== "number" ||
      !Number.isFinite(l.perSecond) ||
      l.perSecond <= 0 ||
      l.perSecond > MAX_PER_SECOND)
  ) {
    errors.push(`limits.perSecond must be a number above 0, at most ${MAX_PER_SECOND}`)
  }
  if (l.burst !== undefined) {
    if (l.perSecond === undefined) errors.push("limits.burst needs limits.perSecond")
    if (!isInt(l.burst) || (l.burst as number) < 1 || (l.burst as number) > MAX_CONCURRENCY) {
      errors.push(`limits.burst must be an integer from 1 to ${MAX_CONCURRENCY}`)
    }
  }
  if (l.concurrency === undefined && l.perSecond === undefined) {
    errors.push("limits must declare concurrency, perSecond or both")
  }
  return errors
}

/** The declared limits of `connection` in `manifest`, or null when it declares none. */
export function declaredConnectionLimits(
  manifest: { connections?: Record<string, unknown> } | null | undefined,
  connection: string,
): ConnectionLimits | null {
  const decl = manifest?.connections?.[connection] as { limits?: unknown } | undefined
  const limits = decl?.limits
  if (limits === undefined || connectionLimitsErrors(limits).length > 0) return null
  return limits as ConnectionLimits
}

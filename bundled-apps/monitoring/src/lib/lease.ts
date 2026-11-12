// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An expiring lease in the app's store: one holder at a time across runs, with no
// transaction held between the bridge calls. A run takes the lease with a compare-and-set
// (`ifVersion`) on one document; a run killed while holding it leaves the document behind,
// and the lease is free again once its `until` has passed.
import type { AppContext } from "@liaison/app-sdk"

const COLLECTION = "leases"

type LeaseCtx = Pick<AppContext, "store">

interface LeaseDoc {
  until: number
}

function isVersionConflict(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null
  return e?.code === "version_conflict" || e?.status === 409
}

/**
 * Run `fn` while holding the lease `name` for at most `ttlMs`. Answers `{ held: false }`
 * without running `fn` when another run holds an unexpired lease (or takes it first).
 */
export async function withLease<T>(
  ctx: LeaseCtx,
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ held: true; value: T } | { held: false }> {
  const now = Date.now()
  const current = await ctx.store.get<LeaseDoc>(COLLECTION, name)
  if (current && typeof current.data.until === "number" && current.data.until > now) {
    return { held: false }
  }
  let mine: { version: number }
  try {
    mine = await ctx.store.set<LeaseDoc>(
      COLLECTION,
      name,
      { until: now + ttlMs },
      { ifVersion: current?.version ?? 0 },
    )
  } catch (err) {
    if (isVersionConflict(err)) return { held: false }
    throw err
  }
  try {
    return { held: true, value: await fn() }
  } finally {
    // Only our own lease: a run that outlived it must not drop a newer holder's.
    await ctx.store.delete(COLLECTION, name, { ifVersion: mine.version }).catch(() => undefined)
  }
}

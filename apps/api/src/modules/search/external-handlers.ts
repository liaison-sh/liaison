// SPDX-License-Identifier: FSL-1.1-ALv2
import { searchLogger as log } from "~/lib/logger"
import { isAppUnavailableFor, primeOrgApps } from "~/modules/apps/org-apps"

export interface ExternalSearchHit {
  id: string
  app: string
  /**
   * Phase 16 Task A4 — canonical entity name (e.g. `order`, `product`). The
   * fanout shim populates this from `entity_type` when handlers still emit
   * the legacy field, and conversely populates `entity_type` from `entity`.
   * New handlers should set `entity`; old handlers may keep `entity_type`.
   */
  entity?: string
  /**
   * @deprecated Back-compat alias of `entity`. Populated by the shim from
   * `entity` when only `entity` is set. Will be removed once all in-tree
   * consumers migrate to read `.entity`.
   */
  entity_type?: string
  title: string
  source?: string
  market?: string
  currency?: string
  attributes?: Record<string, unknown>
  [k: string]: unknown
}

/**
 * Phase 16 §4.4 contract. The kernel invokes each external handler with the
 * full pagination context — `query`, `limit`, `cursor` (opaque, per-source),
 * and `marketContext` — and the handler returns the page of `hits` plus an
 * opaque `nextCursor` (or `null` when this source has no further pages). The
 * cursor is round-tripped verbatim: the kernel never interprets it.
 *
 * `orgId`/`userId` are still passed for tenant/identity context; they are NOT
 * the §4.4 dispatch payload (the sandbox bridge strips them — see
 * `makeSandboxSearchHandler`), but the host needs them to scope the call.
 */
export interface ExternalSearchParams {
  orgId: string
  userId: string
  query: string
  /** Per-section page size. Omitted ⇒ handler default. */
  limit?: number
  /** Opaque cursor from a prior page's `nextCursor`. */
  cursor?: string | null
  /** Market handle the caller is scoped to (spec §4.4). */
  marketContext?: string | null
}

export interface ExternalSearchResult {
  hits: ExternalSearchHit[]
  /** Opaque next-page cursor, or `null` when this source is exhausted. */
  nextCursor?: string | null
  /**
   * Set when the source refused to search (no hits then): the org reached an
   * app day cap (`APP_RUNS_LIMIT_REACHED`, ...), with the message to show.
   */
  refused?: { code: string; message: string }
}

export type ExternalSearchHandler = (params: ExternalSearchParams) => Promise<ExternalSearchResult>

interface RegisteredHandler {
  app: string
  orgId: string
  handler: ExternalSearchHandler
  timeoutMs: number
}

// Keyed by `${orgId}\0${app}` so the same app installed in two orgs registers
// two independent handlers. Previously keyed by `app` alone, which (a) made the
// second org's registration silently overwrite the first, and (b) made
// `fanoutExternal` run a handler registered for org A against org B's query.
const handlers = new Map<string, RegisteredHandler>()
const DEFAULT_TIMEOUT_MS = 5000

function key(orgId: string, app: string): string {
  return `${orgId}\0${app}`
}

export function registerExternalSearchHandler(
  orgId: string,
  app: string,
  h: ExternalSearchHandler,
  opts: { timeoutMs?: number } = {},
): void {
  handlers.set(key(orgId, app), {
    app,
    orgId,
    handler: h,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
}

/** The handler registered for (org, app), as stored: a version switch compares it before and after. */
export function externalSearchHandlerEntry(orgId: string, app: string): object | undefined {
  return handlers.get(key(orgId, app))
}

/** Put back an entry read with `externalSearchHandlerEntry` (a failed version switch). */
export function restoreExternalSearchHandlerEntry(
  orgId: string,
  app: string,
  entry: object | undefined,
): void {
  if (entry) handlers.set(key(orgId, app), entry as RegisteredHandler)
  else handlers.delete(key(orgId, app))
}

/**
 * Remove a previously-registered external search handler (e.g. on app
 * uninstall / registration rollback). No-ops if the handler was not registered.
 */
export function unregisterExternalSearchHandler(orgId: string, app: string): void {
  handlers.delete(key(orgId, app))
}

/**
 * Remove every external-search handler registered for `app` across all orgs —
 * used by the uninstall path, which is org-agnostic (an app is installed
 * platform-wide).
 */
export function unregisterExternalSearchHandlersForApp(app: string): void {
  for (const [k, entry] of handlers) {
    if (entry.app === app) handlers.delete(k)
  }
}

/** Normalize a hit so both `entity` and `entity_type` are populated. */
function normalizeHit(hit: ExternalSearchHit, app: string): ExternalSearchHit {
  const entity = hit.entity ?? hit.entity_type ?? "unknown"
  return {
    ...hit,
    entity,
    entity_type: hit.entity_type ?? entity,
    source: hit.source ?? `external:${app}`,
  }
}

export interface FanoutResult {
  hits: ExternalSearchHit[]
  timedOut: string[]
  /**
   * Per-source next-page cursor, keyed by app name (spec §3.7 — "each external
   * section has its own cursor"). A `null` value means the source has no
   * further pages; an absent key means the source returned no cursor at all
   * (or timed out / errored). The caller round-trips these back as
   * `args.cursors` on the next-page request.
   */
  cursors: Record<string, string | null>
  /** Sources that refused to search, keyed by app (an app day cap reached); absent when none. */
  refused?: Record<string, { code: string; message: string }>
}

export async function fanoutExternal(args: {
  orgId: string
  userId: string
  q: string
  filters: Record<string, unknown>
  /** Per-section page size forwarded into each handler (spec §4.4 `limit`). */
  limit?: number
  /**
   * Per-app opaque cursors from the previous page, keyed by app name. Each
   * handler receives only its own entry as `cursor` (spec §3.7 — sections
   * paginate independently).
   */
  cursors?: Record<string, string | null>
  /** Market handle the caller is scoped to (spec §4.4 `marketContext`). */
  marketContext?: string | null
}): Promise<FanoutResult> {
  // Only fan out to handlers registered for the requesting org — a handler
  // registered for another tenant must never run against this org's query.
  // An app turned Off for the org, or restricted away from the searcher
  // (S19, S20), contributes no results.
  await primeOrgApps(args.orgId)
  const entries = Array.from(handlers.values()).filter(
    (e) => e.orgId === args.orgId && !isAppUnavailableFor(args.orgId, e.app, args.userId),
  )
  if (entries.length === 0) return { hits: [], timedOut: [], cursors: {} }
  const timedOut: string[] = []
  const tagged: ExternalSearchHit[] = []
  const cursors: Record<string, string | null> = {}
  const refused: Record<string, { code: string; message: string }> = {}
  const settled = await Promise.allSettled(
    entries.map(async ({ app, handler, timeoutMs }): Promise<ExternalSearchResult> => {
      let timerId: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          handler({
            orgId: args.orgId,
            userId: args.userId,
            query: args.q,
            limit: args.limit,
            cursor: args.cursors?.[app] ?? null,
            marketContext: args.marketContext ?? null,
          }),
          new Promise<never>((_, rej) => {
            timerId = setTimeout(() => rej(new Error("__timeout__")), timeoutMs)
          }),
        ])
        return {
          hits: result.hits.map((r) => normalizeHit(r, app)),
          nextCursor: result.nextCursor ?? null,
          ...(result.refused ? { refused: result.refused } : {}),
        }
      } finally {
        // Always clear the timeout timer so it doesn't leak after the race
        // settles (either the handler resolved first or the timeout fired).
        if (timerId !== undefined) clearTimeout(timerId)
      }
    }),
  )
  for (let i = 0; i < settled.length; i++) {
    const app = entries[i].app
    const s = settled[i]
    if (s.status === "fulfilled") {
      tagged.push(...s.value.hits)
      cursors[app] = s.value.nextCursor ?? null
      if (s.value.refused) refused[app] = s.value.refused
    } else {
      const reason = s.reason as { message?: string } | undefined
      if (reason?.message === "__timeout__") {
        timedOut.push(app)
        log.warn({ app }, "External search handler timed out")
      } else {
        log.error({ app, err: reason }, "External search handler errored")
      }
    }
  }
  return {
    hits: tagged,
    timedOut,
    cursors,
    ...(Object.keys(refused).length > 0 ? { refused } : {}),
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ExternalSearchHandlersTestAccess = {
  reset(): void {
    handlers.clear()
  },
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16 Task A4 — sandbox-bridged dispatch for manifest-declared search
// handlers. The kernel boot/registration pipeline calls this once per
// installed app whose manifest contains a `search` block; it returns an
// `ExternalSearchHandler` that wraps a `dispatch(handlerName, payload)`
// closure (the sandbox executor pool the runtime already operates).
//
// The returned handler:
//   1. dispatches into the sandbox with the spec §4.4 payload
//      `{ query, limit, cursor, marketContext }` (NOT orgId/userId — those are
//      the host's tenant context, never the bundle's; the bundle reads tenant
//      from its `ctx`),
//   2. validates the shape of the returned payload
//      (`{ results: [...], nextCursor? }`),
//   3. normalizes each result row to `ExternalSearchHit` and propagates the
//      opaque `nextCursor` so the fanout layer can paginate per-source.
import { CapLimitError } from "~/modules/org/caps"
import type {
  ExternalSearchHandler,
  ExternalSearchHit,
  ExternalSearchResult,
} from "./external-handlers"

/** Trusted tenant/identity context, supplied by the host out-of-band of the
 * §4.4 payload so the bundle never receives (or can spoof) orgId/userId. */
export interface SandboxSearchTenant {
  orgId: string
  userId: string
}

export interface SandboxSearchHandlerArgs {
  appName: string
  handlerName: string
  timeoutMs: number
  /**
   * Invokes the named bundle export inside the sandbox. The kernel runtime
   * wires this to the executor pool; tests pass a stub. `tenant` carries the
   * host's trusted orgId/userId for building the privileged DB context — it is
   * NOT part of the §4.4 `payload` the bundle receives. The returned value
   * MUST be the parsed JSON the handler returned (not a string).
   */
  dispatch: (handlerName: string, payload: unknown, tenant: SandboxSearchTenant) => Promise<unknown>
}

export function makeSandboxSearchHandler(args: SandboxSearchHandlerArgs): ExternalSearchHandler {
  return async (params): Promise<ExternalSearchResult> => {
    // Spec §4.4 dispatch payload — exactly { query, limit, cursor,
    // marketContext }. orgId/userId are the host's tenant context and are NOT
    // forwarded into the bundle (the bundle's `ctx` already carries identity);
    // they are passed separately so the runtime can scope the privileged DB.
    let raw: unknown
    try {
      raw = await args.dispatch(
        args.handlerName,
        {
          query: params.query,
          limit: params.limit,
          cursor: params.cursor ?? null,
          marketContext: params.marketContext ?? null,
        },
        { orgId: params.orgId, userId: params.userId },
      )
    } catch (err) {
      // The org reached an app day cap (modules/apps/usage/app-day-cap.ts): no
      // hits, and the reason, typed.
      if (err instanceof CapLimitError) {
        return { hits: [], nextCursor: null, refused: { code: err.code, message: err.message } }
      }
      throw err
    }
    if (!raw || typeof raw !== "object") return { hits: [], nextCursor: null }
    const results = (raw as { results?: unknown[] }).results
    if (!Array.isArray(results)) return { hits: [], nextCursor: null }
    const nextCursorRaw = (raw as { nextCursor?: unknown }).nextCursor
    const nextCursor = typeof nextCursorRaw === "string" ? nextCursorRaw : null
    const hits = results.map((r): ExternalSearchHit => {
      const row = (r ?? {}) as Record<string, unknown>
      const entity =
        typeof row.entity === "string"
          ? row.entity
          : typeof row.entity_type === "string"
            ? (row.entity_type as string)
            : "unknown"
      return {
        app: args.appName,
        id: String(row.id ?? ""),
        entity,
        entity_type: entity,
        title: typeof row.title === "string" ? row.title : "",
        snippet: typeof row.snippet === "string" ? (row.snippet as string) : undefined,
        market: typeof row.market === "string" ? (row.market as string) : undefined,
        currency: typeof row.currency === "string" ? (row.currency as string) : undefined,
        attributes:
          row.attributes && typeof row.attributes === "object"
            ? (row.attributes as Record<string, unknown>)
            : undefined,
      }
    })
    return { hits, nextCursor }
  }
}

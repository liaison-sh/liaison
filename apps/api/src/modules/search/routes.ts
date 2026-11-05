// SPDX-License-Identifier: FSL-1.1-ALv2
import { searchPageQuerySchema, searchQuerySchema } from "@liaison/shared"
import { type Context, Hono } from "hono"
import type { AppEnv } from "~/app"
import { markOwnDependencyDown } from "~/lib/own-dependency-down"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { isSearchReady } from "~/modules/search/drift"
import {
  globalSearch,
  MeiliUnavailableError,
  pageSearch,
  UnknownFilterError,
} from "~/modules/search/service"

export const search = new Hono<AppEnv>()

function searchUnavailable(c: Context<AppEnv>) {
  markOwnDependencyDown(c)
  return c.json({ error: { message: "Search unavailable", code: "SEARCH_UNAVAILABLE" } }, 503)
}

/**
 * Parse the per-section external cursor request param (criterion #7). The
 * client echoes back the prior response's `externalCursors` map as a
 * JSON-encoded `cursors` query param so each external section paginates
 * independently. Malformed JSON or non-string cursor values are dropped rather
 * than failing the whole search — a bad cursor must not 500 the page. Values
 * are coerced to `string | null` (the opaque cursor contract).
 */
function parseExternalCursors(raw: string | undefined): Record<string, string | null> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const out: Record<string, string | null> = {}
  for (const [app, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null) out[app] = null
    else if (typeof value === "string") out[app] = value
  }
  return out
}

search.get("/", zValidator("query", searchQuerySchema), async (c) => {
  if (!isSearchReady()) return searchUnavailable(c)
  const { q, limit } = c.req.valid("query")
  const externalCursors = parseExternalCursors(c.req.query("cursors"))
  const marketContext = c.req.query("marketContext") ?? null
  try {
    const result = await globalSearch({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      scopes: c.get("scopes"),
      dimensionGrants: c.get("dimensionGrants") ?? {},
      roleIds: c.get("roles") ?? [],
      q,
      limit,
      externalCursors,
      marketContext,
    })
    return success(c, result)
  } catch (err) {
    if (err instanceof MeiliUnavailableError) return searchUnavailable(c)
    throw err
  }
})

search.get("/page", zValidator("query", searchPageQuerySchema), async (c) => {
  if (!isSearchReady()) return searchUnavailable(c)
  const { q, limit, offset, app: appFilter, entityType, filters } = c.req.valid("query")
  const externalCursors = parseExternalCursors(c.req.query("cursors"))
  const marketContext = c.req.query("marketContext") ?? null
  try {
    const result = await pageSearch({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      scopes: c.get("scopes"),
      dimensionGrants: c.get("dimensionGrants") ?? {},
      roleIds: c.get("roles") ?? [],
      q,
      limit,
      offset,
      app: appFilter,
      entityType,
      filters,
      externalCursors,
      marketContext,
    })
    return success(c, result.hits, {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      externalCursors: result.externalCursors,
    })
  } catch (err) {
    if (err instanceof MeiliUnavailableError) return searchUnavailable(c)
    if (err instanceof UnknownFilterError) {
      return c.json({ error: { message: err.message, code: "UNKNOWN_FILTER" } }, 400)
    }
    throw err
  }
})

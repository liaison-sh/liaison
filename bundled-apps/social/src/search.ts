// SPDX-License-Identifier: FSL-1.1-ALv2
//
// External search handler. Queries the local `finding` index over content/
// author fields and returns hits with the BARE entity name "finding" (the
// kernel bridge tags `app:"social"`). Offset-paged into the DB read (the bridge
// `where` supports equality only); an empty query enumerates the surface.

import type { SocialToolCtx } from "./ctx"

interface SearchParams {
  query?: string
  limit?: number
  cursor?: string | null
}

export interface SearchHit {
  id: string
  entity: "finding"
  title: string
  attributes: {
    platform: string | null
    relation: string | null
    status: string | null
    author_handle: string | null
  }
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const SEARCH_FIELDS = ["content_text", "author_handle"]

function clampLimit(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return DEFAULT_LIMIT
  const n = Math.floor(input)
  if (n < 1) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, n)
}

function parseCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || cursor.length === 0) return 0
  const n = Number(cursor)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

export async function searchHandler(
  params: SearchParams,
  ctx: SocialToolCtx,
): Promise<{ results: SearchHit[]; nextCursor: string | null }> {
  const query = typeof params.query === "string" ? params.query.trim() : ""
  const limit = clampLimit(params.limit)
  const offset = parseCursor(params.cursor)

  const rows = (await ctx.db.findMany("finding", {
    ...(query.length > 0 ? { search: { fields: SEARCH_FIELDS, query } } : {}),
    orderBy: { id: "asc" },
    limit: limit + 1,
    offset,
  })) as Array<Record<string, unknown>>

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  const results: SearchHit[] = page.map((r) => ({
    id: String(r.id),
    entity: "finding",
    title: String(r.content_text ?? r.author_handle ?? r.external_id ?? r.id),
    attributes: {
      platform: (r.platform as string | null) ?? null,
      relation: (r.relation as string | null) ?? null,
      status: (r.status as string | null) ?? null,
      author_handle: (r.author_handle as string | null) ?? null,
    },
  }))

  const nextCursor = hasMore ? String(offset + limit) : null
  return { results, nextCursor }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Knowledge source kind `catalog`: knowledge articles kept in the connected
// database, synced through two curated reads the deployment's catalog declares
// (the catalog owns all SQL; nothing here names a table):
//
//   knowledge_sync_list  { after_updated_at, after_id, limit } -> id, title, updated_at, url?
//   knowledge_sync_get   { id }                                -> id, title, body, updated_at, url?
//
// Pages walk the list by keyset (updated_at, id); the platform keeps the cursor,
// so the next pass starts after the last row seen and only changed articles
// come back. A catalog without the list read syncs nothing (done at once).

import type { AppContext, KnowledgeSyncInput, KnowledgeSyncResult } from "@liaison/app-sdk"
import { isSqlError, MAIN } from "./tools"

const LIST_READ = "knowledge_sync_list"
const GET_READ = "knowledge_sync_get"
/** Rows per page: each needs its own body read inside one run's budget. */
export const PAGE_SIZE = 50
const MARKDOWN = "text/markdown"

export interface CatalogCursor {
  updated_at: string
  id: string
}

type Ctx = Pick<AppContext, "sql" | "logger">

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}

function isCursor(value: unknown): value is CatalogCursor {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as CatalogCursor).updated_at === "string" &&
    typeof (value as CatalogCursor).id === "string"
  )
}

export async function syncCatalogArticles(
  input: KnowledgeSyncInput<CatalogCursor>,
  ctx: Ctx,
): Promise<KnowledgeSyncResult<CatalogCursor>> {
  const cursor = isCursor(input.cursor) ? input.cursor : null
  const reads = await ctx.sql.reads(MAIN)
  if (isSqlError(reads)) throw new Error(`database catalog: ${reads.error.message}`)
  if (!reads.reads[LIST_READ] || !reads.reads[GET_READ]) {
    ctx.logger.warn("database knowledge: the catalog declares no knowledge_sync reads", {})
    return { done: true, nextCursor: cursor }
  }
  const page = await ctx.sql.query(MAIN, {
    read: LIST_READ,
    params: {
      after_updated_at: cursor?.updated_at ?? null,
      after_id: cursor?.id ?? null,
      limit: PAGE_SIZE,
    },
  })
  if (isSqlError(page)) throw new Error(`${LIST_READ}: ${page.error.message}`)
  const upsert = []
  for (const row of page.rows) {
    const got = await ctx.sql.query(MAIN, { read: GET_READ, params: { id: String(row.id) } })
    if (isSqlError(got)) throw new Error(`${GET_READ}: ${got.error.message}`)
    const article = got.rows[0]
    if (!article) continue // deleted between the two reads: the next pass skips it too
    const modifiedAt = iso(article.updated_at ?? row.updated_at)
    const url = article.url ?? row.url
    upsert.push({
      externalId: String(row.id),
      title: String(article.title ?? row.title),
      body: String(article.body ?? ""),
      mimeType: MARKDOWN,
      ...(modifiedAt ? { modifiedAt, rev: modifiedAt } : {}),
      ...(url ? { url: String(url) } : {}),
    })
  }
  const last = page.rows[page.rows.length - 1]
  const nextCursor = last ? { updated_at: iso(last.updated_at) ?? "", id: String(last.id) } : cursor
  return {
    documents: { upsert },
    nextCursor,
    done: page.rows.length < PAGE_SIZE,
  }
}

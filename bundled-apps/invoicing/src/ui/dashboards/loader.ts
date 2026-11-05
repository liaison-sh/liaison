// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Thin wrapper around `invoicing:documents.search` (E5/reads.ts). Each
// dashboard component calls this with its preset query shape; the loader
// returns the flat row list ready for the column accessors.
import { app } from "@liaison/host"
import type { DashboardFilter, DocumentRow } from "./types"

export interface SearchParams {
  type?: "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"
  /** Free-text search — matches document number and counterparty name. */
  query?: string
  /** Status passthrough (kernel-filtered server-side when set). */
  status?: string
  /** Optional treatment narrowing (used by Customs). */
  treatment?: string
  /** Date range — same shape as the toolbar. */
  date_from?: string | null
  date_to?: string | null
  /** Issue-date order; the server default is newest first. */
  sort?: "newest" | "oldest"
}

/** The most rows one list load asks for (the tool's own ceiling). */
export const LIST_PAGE_LIMIT = 100

/**
 * The exact `documents_search` arguments for a list load. A bound the toolbar left empty is
 * OMITTED, never sent as null: the tool declares each bound as an optional string, so a
 * `{ from: "2026-09-01", to: null }` range picked with only one date used to be refused as
 * invalid parameters and the list showed an unexpected error instead of rows.
 */
export function documentsSearchArgs(p: SearchParams = {}): Record<string, unknown> {
  const range: { from?: string; to?: string } = {}
  if (p.date_from) range.from = p.date_from
  if (p.date_to) range.to = p.date_to
  return {
    ...(p.type ? { type: p.type } : {}),
    ...(p.query?.trim() ? { query: p.query.trim() } : {}),
    ...(p.status ? { status: p.status } : {}),
    ...(p.treatment ? { treatment: p.treatment } : {}),
    ...(range.from || range.to ? { date_range: range } : {}),
    ...(p.sort === "oldest" ? { sort: "oldest" } : {}),
    limit: LIST_PAGE_LIMIT,
  }
}

export async function searchDocuments(p: SearchParams = {}): Promise<DocumentRow[]> {
  // documents_search resolves to a bare DocumentHeader[] — the tool route wraps
  // it as { data: [...] } and the api-client unwraps `.data`, so host.invokeTool
  // hands back the array directly. (The settings_* list reads use an { items }
  // envelope; documents_search does not — match the handler's actual contract,
  // not that convention, or the list collapses to empty.)
  const r = await app.invokeTool<DocumentRow[]>("documents_search", documentsSearchArgs(p))
  return Array.isArray(r) ? r : []
}

export function searchParamsFromFilter(f: DashboardFilter, base: SearchParams = {}): SearchParams {
  return {
    ...base,
    ...(f.query.trim() ? { query: f.query } : {}),
    date_from: f.date_from,
    date_to: f.date_to,
    sort: f.sort,
    ...(f.status !== "all" ? { status: f.status } : {}),
  }
}

/** A Shopify order id as the Shopify app keys its orders: the gid (`123` gives `gid://shopify/Order/123`). */
export function orderGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Order/${id}`
}

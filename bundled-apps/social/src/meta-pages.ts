// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Page ids a workspace receives through a server-wide Meta callback (managed
// edition). `webhooks_setup` records them on each Facebook account's sync_state
// rows (`metadata.meta_page_ids`) and the server routes a delivery by them. A
// stored list goes stale when a Page changes hands (the account's user loses
// admin of it, or the account is disconnected), so it is checked against Meta's
// own answer:
//
//  - before a delivery is ingested, every account that routes Pages is checked
//    with `GET /me/accounts` (at most once per CHECK_TTL_MS), the list is pruned
//    to the Pages the account still manages, and entries of any other Page are
//    dropped unread;
//  - a token Meta refuses ("not authorized": 401, #190, #10, #200) clears the
//    account's list, as a disconnect does;
//  - discovery sync re-checks the list on its own cadence.
//
// A self-hosted workspace records no Page ids (its Meta app is its own), so none
// of this runs there.

import { FB_BASE } from "./adapters/facebook"
import { resolveAccessToken } from "./connection"
import type { SocialToolCtx } from "./ctx"

export const META_PAGE_IDS_KEY = "meta_page_ids"
export const META_PAGES_CHECKED_AT_KEY = "meta_pages_checked_at"
/** How long a live check of an account's Pages is trusted. */
export const CHECK_TTL_MS = 60_000

/** Graph error codes that mean the token no longer authorizes the Pages. */
const NOT_AUTHORIZED_CODES = new Set([10, 190, 200])

interface Row {
  id: string
  account_external_id?: string
  active?: boolean
  metadata?: unknown
}

function metadataOf(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      return (JSON.parse(v) as Record<string, unknown>) ?? {}
    } catch {
      return {}
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function routedIdsOf(metadata: unknown): string[] | null {
  const ids = metadataOf(metadata)[META_PAGE_IDS_KEY]
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : null
}

async function facebookRows(ctx: SocialToolCtx, account?: string): Promise<Row[]> {
  return (await ctx.db.findMany("sync_state", {
    where: account ? { platform: "facebook", account_external_id: account } : { platform: "facebook" },
  })) as Row[]
}

async function writeIds(ctx: SocialToolCtx, rows: Row[], ids: string[], checkedAt: string): Promise<void> {
  for (const row of rows) {
    if (routedIdsOf(row.metadata) === null) continue
    await ctx.db.update("sync_state", row.id, {
      metadata: { ...metadataOf(row.metadata), [META_PAGE_IDS_KEY]: ids, [META_PAGES_CHECKED_AT_KEY]: checkedAt },
    })
  }
}

/** Disconnect: the account routes nothing any more. */
export async function clearMetaPageIds(ctx: SocialToolCtx, account: string): Promise<void> {
  const rows = await facebookRows(ctx, account)
  await writeIds(ctx, rows, [], new Date().toISOString())
}

export type RefreshOutcome =
  | { kind: "none" } // the account routes no Pages
  | { kind: "ok"; ids: string[] }
  | { kind: "unavailable"; reason: string } // Meta did not answer usably: nothing changed

/**
 * Re-read the Pages `account` manages from Meta and prune its routed list to
 * them. A refused token clears the list. `force` ignores CHECK_TTL_MS.
 */
export async function refreshMetaPageIds(
  ctx: SocialToolCtx,
  account: string,
  opts: { force?: boolean; token?: string | null; now?: Date } = {},
): Promise<RefreshOutcome> {
  const rows = await facebookRows(ctx, account)
  const stored = rows.map((r) => routedIdsOf(r.metadata)).find((ids) => ids !== null) ?? null
  if (stored === null) return { kind: "none" }
  const now = opts.now ?? new Date()
  const checkedAt = rows
    .map((r) => metadataOf(r.metadata)[META_PAGES_CHECKED_AT_KEY])
    .find((v): v is string => typeof v === "string")
  if (!opts.force && checkedAt && now.getTime() - Date.parse(checkedAt) < CHECK_TTL_MS) {
    return { kind: "ok", ids: stored }
  }
  if (stored.length === 0) return { kind: "ok", ids: [] }
  const token = opts.token !== undefined ? opts.token : await resolveAccessToken(ctx, "facebook", account)
  if (!token) {
    // No usable token (disconnected, or the refresh failed): it authorizes nothing.
    await writeIds(ctx, rows, [], now.toISOString())
    return { kind: "ok", ids: [] }
  }
  const managed = new Set<string>()
  let url: string | null = `${FB_BASE}/me/accounts?fields=id&limit=100`
  for (let page = 0; url && page < 20; page++) {
    const res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    let parsed: { data?: Array<{ id?: unknown }>; paging?: { next?: unknown }; error?: { code?: unknown } } = {}
    try {
      parsed = res.body ? JSON.parse(res.body) : {}
    } catch {
      return { kind: "unavailable", reason: `HTTP ${res.status}, unparseable body` }
    }
    const code = typeof parsed.error?.code === "number" ? parsed.error.code : null
    if (res.status === 401 || (code !== null && NOT_AUTHORIZED_CODES.has(code))) {
      ctx.logger?.warn?.("social: Meta no longer authorizes this account's Pages; routing cleared", {
        account,
        status: res.status,
        code,
      })
      await writeIds(ctx, rows, [], now.toISOString())
      return { kind: "ok", ids: [] }
    }
    if (res.status < 200 || res.status >= 300 || parsed.error) {
      return { kind: "unavailable", reason: `HTTP ${res.status}${code !== null ? ` (#${code})` : ""}` }
    }
    for (const p of parsed.data ?? []) if (p.id !== undefined && p.id !== null) managed.add(String(p.id))
    url = typeof parsed.paging?.next === "string" ? parsed.paging.next : null
  }
  // More Pages than were read: nothing is pruned on a partial answer.
  if (url) return { kind: "unavailable", reason: "too many managed Pages to read" }
  const kept = stored.filter((id) => managed.has(id))
  if (kept.length !== stored.length) {
    ctx.logger?.info?.("social: Pages no longer managed by this account left the routing list", {
      account,
      removed: stored.filter((id) => !managed.has(id)),
    })
  }
  await writeIds(ctx, rows, kept, now.toISOString())
  return { kind: "ok", ids: kept }
}

/** Thrown when a delivery cannot be checked now; the job retries it. */
export class MetaPagesUnavailableError extends Error {}

/**
 * The entries of a Facebook delivery this workspace may ingest. Without routed
 * Page ids (self-hosted, or before `webhooks_setup` on a cell) the body is
 * returned as it is. Otherwise only entries of a Page some connected account of
 * this workspace manages now are kept.
 */
export async function livePagesOnly(ctx: SocialToolCtx, body: unknown, now = new Date()): Promise<unknown> {
  const rows = await facebookRows(ctx)
  const accounts = [
    ...new Set(
      rows
        .filter((r) => routedIdsOf(r.metadata) !== null && typeof r.account_external_id === "string")
        .map((r) => r.account_external_id as string),
    ),
  ]
  if (accounts.length === 0) return body
  const live = new Set<string>()
  for (const account of accounts) {
    if (rows.some((r) => r.account_external_id === account && r.active === false)) continue
    const out = await refreshMetaPageIds(ctx, account, { now })
    if (out.kind === "unavailable") throw new MetaPagesUnavailableError(`Meta Pages check failed: ${out.reason}`)
    if (out.kind === "ok") for (const id of out.ids) live.add(id)
  }
  const envelope = body && typeof body === "object" && !Array.isArray(body) ? (body as { entry?: unknown }) : {}
  const entries = Array.isArray(envelope.entry) ? (envelope.entry as Array<{ id?: unknown }>) : []
  const kept = entries.filter((e) => e && e.id !== undefined && live.has(String(e.id)))
  if (kept.length !== entries.length) {
    ctx.logger?.info?.("social: delivery entries for Pages this workspace no longer manages were dropped", {
      dropped: entries.length - kept.length,
    })
  }
  return { ...envelope, entry: kept }
}

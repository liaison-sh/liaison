// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Read tools behind the Settings surface: `connections_status` (each of the
// app's OAuth connections with its real kernel state) and `quota_status`
// (per-platform API usage). Both are read only.
//
// Connection state comes from the kernel's `connections.describe(name)` bridge
// method: the org's rows plus the caller's personal ones, with owner, who
// connected it, health and token expiry. A kernel without that method answers
// `available: false` and the page says it cannot read the status, instead of
// claiming "Not connected".
//
// YouTube usage is the quota ledger's own read (`readYoutubeQuotaStatus` in
// sync.ts): today's Pacific quota day, split discovery / watch polls, with the
// deferred watch count and Google's exhaustion instant.
// Meta has no unit quota: a platform appears only when a rate-limit state is
// stored on its sync_state metadata.

import type { Platform } from "./adapters/types"
import type { SocialToolCtx } from "./ctx"
import type { YoutubeQuotaStatus } from "./quota"
import { readYoutubeQuotaStatus } from "./sync"

/** The app's connections, in the order the Settings page lists them. */
export const SOCIAL_CONNECTIONS: ReadonlyArray<{
  name: string
  label: string
  platform: Platform
}> = [
  { name: "facebook", label: "Facebook Page", platform: "facebook" },
  { name: "instagram", label: "Instagram", platform: "instagram" },
  { name: "google", label: "Google (YouTube)", platform: "youtube" },
]

/** A token this close to expiry is flagged so someone reconnects in time. */
export const EXPIRY_WARNING_MS = 7 * 24 * 3600 * 1000

export interface ConnectionAccount {
  id: string
  identifier: string
  displayName: string | null
  ownerType: "org" | "user"
  isMine: boolean
  status: "active" | "error"
  statusMessage: string | null
  tokenExpiresAt: string | null
  /** A refresh token is stored: the kernel renews the access token itself. */
  hasRefreshToken: boolean
  connectedByName: string | null
  connectedAt: string
  updatedAt: string
}

export type ConnectionState = "connected" | "expiring" | "needs_reconnect" | "not_connected"

export interface ConnectionStatusEntry {
  name: string
  label: string
  platform: Platform
  state: ConnectionState
  /** The account the app runs on: the org's active one first, then the caller's. */
  primary: ConnectionAccount | null
  accounts: ConnectionAccount[]
}

export interface ConnectionsStatusResult {
  /** False when the kernel cannot describe connections (older kernel). */
  available: boolean
  connections: ConnectionStatusEntry[]
}

type DescribeFn = (connectionName: string) => Promise<unknown>

/** The kernel's describe accessor under either `ctx.connections` shape, or null. */
function describeAccessor(connections: unknown): DescribeFn | null {
  const flat = connections as { describe?: (name: string) => Promise<unknown> } | null | undefined
  if (flat && typeof flat.describe === "function") return (name) => flat.describe!(name)
  const record = connections as Record<
    string,
    { describe?: () => Promise<unknown> } | undefined
  > | null
  if (record && typeof record === "object") {
    const any = SOCIAL_CONNECTIONS.some((c) => typeof record[c.name]?.describe === "function")
    if (any)
      return async (name) =>
        typeof record[name]?.describe === "function" ? record[name]!.describe!() : []
  }
  return null
}

function parseAccounts(raw: unknown): ConnectionAccount[] {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? (value as ConnectionAccount[]) : []
}

/**
 * Pick the account the app runs on and derive the connection's state. A failed
 * refresh (status error) always needs a reconnect. An account with a stored
 * refresh token renews its access token on its own, so its access expiry says
 * nothing about the connection; without one, an expired access token needs a
 * reconnect and a near expiry warns.
 */
export function deriveConnectionState(
  accounts: ConnectionAccount[],
  now: Date,
): { state: ConnectionState; primary: ConnectionAccount | null } {
  const rank = (a: ConnectionAccount) =>
    (a.status === "active" ? 0 : 2) + (a.ownerType === "org" ? 0 : 1)
  const sorted = [...accounts].sort((a, b) => rank(a) - rank(b))
  const primary = sorted[0] ?? null
  if (!primary) return { state: "not_connected", primary: null }
  if (primary.status === "error") return { state: "needs_reconnect", primary }
  if (primary.hasRefreshToken === true) return { state: "connected", primary }
  const expiry = primary.tokenExpiresAt ? Date.parse(primary.tokenExpiresAt) : Number.NaN
  if (Number.isFinite(expiry)) {
    if (expiry <= now.getTime()) return { state: "needs_reconnect", primary }
    if (expiry - now.getTime() <= EXPIRY_WARNING_MS) return { state: "expiring", primary }
  }
  return { state: "connected", primary }
}

export async function connectionsStatus(
  _params: Record<string, never>,
  ctx: SocialToolCtx,
  now: Date = new Date(),
): Promise<ConnectionsStatusResult> {
  const describe = describeAccessor(ctx.connections)
  if (!describe) {
    return {
      available: false,
      connections: SOCIAL_CONNECTIONS.map((c) => ({
        ...c,
        state: "not_connected",
        primary: null,
        accounts: [],
      })),
    }
  }
  const connections = await Promise.all(
    SOCIAL_CONNECTIONS.map(async (c) => {
      const accounts = parseAccounts(await describe(c.name))
      return { ...c, ...deriveConnectionState(accounts, now), accounts }
    }),
  )
  return { available: true, connections }
}

// ── quota_status ─────────────────────────────────────────────────────────────

export interface YoutubeQuotaView {
  /** Always "ledger": the quota ledger answered. */
  source: "ledger"
  day: string
  resetsAt: string
  cap: number
  consumed: number
  remaining: number
  deferred: number
  exhaustedUntil: string | null
  bySource: Array<{ source: string; consumed: number }>
}

export interface PlatformRateLimit {
  platform: Platform
  rateLimit: Record<string, unknown>
}

export interface QuotaStatusResult {
  youtube: YoutubeQuotaView | null
  rateLimits: PlatformRateLimit[]
}

interface SyncStateQuotaRow {
  platform: string
  source_type: string
  metadata?: unknown
}

function metadataOf(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
}

function fromLedger(s: YoutubeQuotaStatus): YoutubeQuotaView {
  return {
    source: "ledger",
    day: s.day,
    resetsAt: s.resetsAt,
    cap: s.cap,
    consumed: s.consumed,
    remaining: s.remaining,
    deferred: s.watch.deferred,
    exhaustedUntil: s.exhaustedUntil,
    bySource: [
      { source: "discovery", consumed: s.discovery.consumed },
      { source: "watch", consumed: s.watch.consumed },
    ],
  }
}

/** A stored rate-limit state on a Meta sync_state row (any `rate_limit*` key). */
function rateLimitOf(row: SyncStateQuotaRow): Record<string, unknown> | null {
  const meta = metadataOf(row.metadata)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) if (/^rate_?limit/i.test(k)) out[k] = v
  return Object.keys(out).length > 0 ? out : null
}

export async function quotaStatus(
  _params: Record<string, never>,
  ctx: SocialToolCtx,
  now: Date = new Date(),
): Promise<QuotaStatusResult> {
  const rows = (await ctx.db.findMany("sync_state", {
    where: { active: true },
    limit: 200,
  })) as SyncStateQuotaRow[]
  const ledger = await readYoutubeQuotaStatus(ctx, now)
  const youtube = ledger ? fromLedger(ledger) : null

  const rateLimits: PlatformRateLimit[] = []
  for (const platform of ["facebook", "instagram"] as const) {
    const states = rows
      .filter((r) => r.platform === platform)
      .map(rateLimitOf)
      .filter((x) => x !== null)
    if (states.length > 0) rateLimits.push({ platform, rateLimit: Object.assign({}, ...states) })
  }
  return { youtube, rateLimits }
}

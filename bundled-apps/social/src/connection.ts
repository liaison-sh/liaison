// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Connection lifecycle (B10 / H5). Subscribed via `events.subscribes` to the
// kernel `connected_account:create`/`disconnect` events.
//
// On connect: FIRST-CONNECT APP-LEVEL SETUP ONLY — seed a `sync_state` row per
// [platform, account_external_id, source_type] and enqueue an initial
// `discovery-sync` (and `dm-sync` for a connection that carries DMs) so the
// first cycle runs immediately rather than waiting up to 15 (10) min. We do NOT call `registerScheduledJob` — the kernel already fans the
// manifest-declared `jobs` out per connected org; a host-only scheduler call
// from a sandboxed app is both impossible and a purity violation.
//
// On disconnect: PER-CONNECTION teardown — flip this account's `sync_state` rows
// to inactive so `runDiscoverySync`/`runWatchPoller` skip them. This is distinct
// from the per-APP uninstall pause (kernel `pauseAppRoutinesForOrg`, Task A12).

import type { Platform } from "./adapters/types"
import type { SocialAuth, SocialToolCtx } from "./ctx"
import { clearMetaPageIds } from "./meta-pages"

interface ConnectionEventData {
  id: string
  appName: string
  orgId?: string
  connectionName: string
  identifier: string
  /** The kernel's public origin, carried on the connect event (empty in local dev). */
  kernelPublicBaseUrl?: string
}

interface ConnectionEvent {
  app: "kernel"
  entity: "connected_account"
  action: "create" | "disconnect"
  orgId: string
  data:
    | ConnectionEventData
    | { id: string; appName: string; connectionName?: string; identifier?: string }
}

/** Connection name → the platforms + source types its sync_state covers. */
/** The discovery run a connect asks for: deduplicated while it waits or runs. */
const DISCOVERY_KICK_JOB_ID = "discovery-sync-on-connect"
const DISCOVERY_KICK_DELAY_MS = 5_000
/** The DM sync a connect asks for, so DMs land without waiting for the next tick. */
const DM_KICK_JOB_ID = "dm-sync-on-connect"

const CONNECTION_SYNC_PLAN: Record<
  string,
  Array<{ platform: Platform; sourceTypes: Array<"discovery" | "watch" | "dm"> }>
> = {
  // Instagram Business Login backs the Instagram platform (comments + DMs).
  instagram: [{ platform: "instagram", sourceTypes: ["discovery", "watch", "dm"] }],
  // Instagram API with Unified login backs the same platform (graph.facebook.com).
  instagram_unified: [{ platform: "instagram", sourceTypes: ["discovery", "watch", "dm"] }],
  // Facebook Login backs the Facebook Page platform (comments + Messenger DMs).
  facebook: [{ platform: "facebook", sourceTypes: ["discovery", "watch", "dm"] }],
  // Google connection backs YouTube; discovery + watch only (no DMs).
  google: [{ platform: "youtube", sourceTypes: ["discovery", "watch"] }],
}

interface SyncStateRow {
  id: string
  active?: boolean
  metadata?: unknown
}

/** sync_state metadata key holding the kernel's public origin, read by `webhooks_setup`. */
export const BASE_URL_METADATA_KEY = "kernel_public_base_url"

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

/**
 * Platform → the OAuth connections that can hold its accounts, tried in order.
 * Meta gives each surface its OWN login: `facebook` (Facebook Login for the
 * Page) and, for Instagram, `instagram_unified` (Instagram API with Unified
 * login, current Meta apps) or `instagram` (Instagram Business Login, older
 * apps); `google` backs YouTube. The two Instagram logins identify the account
 * by different ids, so the connection holding the identifier is the one used.
 * Mirrors `CONNECTION_SYNC_PLAN` in reverse.
 */
const PLATFORM_CONNECTIONS: Record<Platform, readonly string[]> = {
  facebook: ["facebook"],
  instagram: ["instagram_unified", "instagram"],
  youtube: ["google"],
}

/** The connected accounts of one connection, in either `ctx.connections` shape; `null` when unreadable. */
async function connectionAccounts(
  ctx: SocialToolCtx,
  connectionName: string,
): Promise<Array<{ identifier?: string }> | null> {
  const conns = ctx.connections as unknown
  const flat = conns as { getAccounts?: (name: string) => Promise<unknown> }
  let raw: unknown
  try {
    if (typeof flat.getAccounts === "function") {
      raw = await flat.getAccounts(connectionName)
    } else {
      const entry = (
        conns as Record<string, { getAccounts?: () => Promise<unknown> } | undefined>
      )?.[connectionName]
      if (!entry || typeof entry.getAccounts !== "function") return null
      raw = await entry.getAccounts()
    }
    const accounts = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
      identifier?: string
    }> | null
    return Array.isArray(accounts) ? accounts : null
  } catch {
    return null
  }
}

/**
 * The credential of one connected account, for `ctx.fetch` auth: the host adds
 * the account's OAuth token (refreshed host-side) to a request that names it,
 * so the token never enters the app. The `identifier` is the connected
 * account's external id (the user / IG / channel id) so a multi-account org
 * sends the right token per account; `connection` is the connection that holds
 * it (for Instagram, `instagram_unified` or `instagram`).
 *
 * Returns `null` when the account is not connected (no active account with
 * that identifier in any of the platform's connections: `getAccounts` lists
 * only active ones, in either `ctx.connections` shape) — the caller turns that
 * into an explicit, observable auth error rather than an unauthenticated call.
 * A token the provider refuses later answers that call with its own 401.
 */
export async function resolveAccountAuth(
  ctx: SocialToolCtx,
  platform: Platform,
  accountExternalId: string,
): Promise<SocialAuth | null> {
  for (const connectionName of PLATFORM_CONNECTIONS[platform]) {
    const accounts = await connectionAccounts(ctx, connectionName)
    if ((accounts ?? []).some((a) => a?.identifier === accountExternalId)) {
      return { connection: connectionName, identifier: accountExternalId, scheme: "bearer" }
    }
  }
  return null
}

/**
 * The platform's connected account for calls that name no account (outbound
 * replies and DMs, the watch poller, own-post enrolment): the first active
 * `sync_state` row whose credential resolves. A row with no connected account
 * behind it (a seeded or stale row) is skipped, never picked with no token.
 * `null` when no active row resolves.
 */
export async function resolveConnectedAccount(
  ctx: SocialToolCtx,
  platform: Platform,
): Promise<{ accountExternalId: string; auth: SocialAuth } | null> {
  const rows = (await ctx.db.findMany("sync_state", {
    where: { platform, active: true },
  })) as Array<{ account_external_id: string }>
  const tried = new Set<string>()
  for (const row of rows) {
    const id = row.account_external_id
    if (!id || tried.has(id)) continue
    tried.add(id)
    const auth = await resolveAccountAuth(ctx, platform, id)
    if (auth) return { accountExternalId: id, auth }
  }
  return null
}

async function upsertSyncState(
  ctx: SocialToolCtx,
  row: {
    platform: Platform
    account_external_id: string
    source_type: "discovery" | "watch" | "dm"
  },
  extraMetadata: Record<string, unknown> = {},
): Promise<void> {
  const existing = (await ctx.db.findMany("sync_state", {
    where: {
      platform: row.platform,
      account_external_id: row.account_external_id,
      source_type: row.source_type,
    },
    limit: 1,
  })) as SyncStateRow[]
  const hasExtra = Object.keys(extraMetadata).length > 0
  if (existing[0]) {
    await ctx.db.update("sync_state", existing[0].id, {
      active: true,
      ...(hasExtra ? { metadata: { ...metadataOf(existing[0].metadata), ...extraMetadata } } : {}),
    })
  } else {
    await ctx.db.insert("sync_state", {
      ...row,
      active: true,
      cursor: null,
      units_consumed_today: 0,
      ...(hasExtra ? { metadata: extraMetadata } : {}),
    })
  }
}

export async function onConnectionEstablished(
  event: ConnectionEvent,
  ctx: SocialToolCtx,
): Promise<void> {
  if (event.data?.appName !== "social") return
  const data = event.data as ConnectionEventData
  const connectionName = data.connectionName ?? ""
  const accountExternalId = data.identifier ?? data.id
  const plan = CONNECTION_SYNC_PLAN[connectionName]
  if (!plan) {
    ctx.logger?.warn?.("social: unknown connection name on connect", { connectionName })
    return
  }
  // The public origin is remembered so `webhooks_setup` can build the Meta callback URL
  // without asking the operator for it.
  const base = typeof data.kernelPublicBaseUrl === "string" ? data.kernelPublicBaseUrl.trim() : ""
  const extra = base ? { [BASE_URL_METADATA_KEY]: base } : {}
  for (const { platform, sourceTypes } of plan) {
    for (const sourceType of sourceTypes) {
      await upsertSyncState(
        ctx,
        { platform, account_external_id: accountExternalId, source_type: sourceType },
        extra,
      )
    }
  }
  // One discovery cycle soon, so findings appear without waiting for the next
  // scheduled tick. The job syncs every active row, so connects close together
  // share one deduplicated run, a few seconds out so their rows are all written.
  await ctx.enqueueJob?.(
    "discovery-sync",
    {},
    { delay: DISCOVERY_KICK_DELAY_MS, jobId: DISCOVERY_KICK_JOB_ID },
  )
  // Same for direct messages: the DM sync runs every 10 min, so a connection
  // that carries DMs asks for one run now, deduplicated the same way.
  if (plan.some((p) => p.sourceTypes.includes("dm"))) {
    await ctx.enqueueJob?.("dm-sync", {}, { delay: DISCOVERY_KICK_DELAY_MS, jobId: DM_KICK_JOB_ID })
  }
}

export async function onConnectionDisconnected(
  event: ConnectionEvent,
  ctx: SocialToolCtx,
): Promise<void> {
  if (event.data?.appName !== "social") return
  const data = event.data as ConnectionEventData
  const connectionName = data.connectionName ?? ""
  const accountExternalId = data.identifier ?? data.id
  const plan = CONNECTION_SYNC_PLAN[connectionName]
  if (!plan) return
  for (const { platform } of plan) {
    const rows = (await ctx.db.findMany("sync_state", {
      where: { platform, account_external_id: accountExternalId },
    })) as SyncStateRow[]
    for (const r of rows) {
      await ctx.db.update("sync_state", r.id, { active: false })
    }
    // The server-wide Meta callback routes this account's Pages no more (meta-pages.ts).
    if (platform === "facebook") await clearMetaPageIds(ctx, accountExternalId)
  }
}

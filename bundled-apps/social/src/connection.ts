// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Connection lifecycle (B10 / H5). Subscribed via `events.subscribes` to the
// kernel `connected_account:create`/`disconnect` events.
//
// On connect: FIRST-CONNECT APP-LEVEL SETUP ONLY — seed a `sync_state` row per
// [platform, account_external_id, source_type] and enqueue an initial
// `discovery-sync` so the first cycle runs immediately rather than waiting up to
// 15 min. We do NOT call `registerScheduledJob` — the kernel already fans the
// manifest-declared `jobs` out per connected org; a host-only scheduler call
// from a sandboxed app is both impossible and a purity violation.
//
// On disconnect: PER-CONNECTION teardown — flip this account's `sync_state` rows
// to inactive so `runDiscoverySync`/`runWatchPoller` skip them. This is distinct
// from the per-APP uninstall pause (kernel `pauseAppRoutinesForOrg`, Task A12).

import type { Platform } from "./adapters/types"
import type { SocialToolCtx } from "./ctx"
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

const CONNECTION_SYNC_PLAN: Record<
  string,
  Array<{ platform: Platform; sourceTypes: Array<"discovery" | "watch" | "dm"> }>
> = {
  // Instagram Business Login backs the Instagram platform (comments + DMs).
  instagram: [{ platform: "instagram", sourceTypes: ["discovery", "watch", "dm"] }],
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
 * Platform → OAuth credentials-connection name. Meta's current model gives each
 * surface its OWN login: `instagram` (Instagram Business Login) and `facebook`
 * (Facebook Login for the Page); `google` backs YouTube. Mirrors
 * `CONNECTION_SYNC_PLAN` in reverse.
 */
const PLATFORM_CONNECTION: Record<Platform, string> = {
  facebook: "facebook",
  instagram: "instagram",
  youtube: "google",
}

/**
 * Resolve the per-platform/per-account OAuth access token via the host
 * connections accessor. `ctx.connections` has two runtime shapes (same as
 * boxtal/pennylane's `getCredentials` facade):
 *   - FLAT  `{ getToken(name, identifier?) }` — the sandbox bridge group.
 *   - RECORD `{ meta: { getToken(identifier?) } }` — the SDK type / unit-test mock.
 * We normalize to one accessor so the resolver is correct under both. The
 * `identifier` is the connected account's external id (the Page / IG / channel
 * id) so a multi-account org gets the right token per account.
 *
 * Returns `null` when no live token can be obtained (never connected, or the
 * stored token is empty/expired and the host throws) — the caller turns that
 * into an explicit, observable auth error rather than an unauthenticated call.
 */
export async function resolveAccessToken(
  ctx: SocialToolCtx,
  platform: Platform,
  accountExternalId: string,
): Promise<string | null> {
  const connectionName = PLATFORM_CONNECTION[platform]
  const conns = ctx.connections as unknown
  const flat = conns as {
    getToken?: (name: string, identifier?: string) => Promise<string>
  }
  let token: string | undefined
  try {
    if (typeof flat.getToken === "function") {
      token = await flat.getToken(connectionName, accountExternalId)
    } else {
      const record = conns as Record<
        string,
        { getToken?: (identifier?: string) => Promise<string> } | undefined
      >
      const entry = record?.[connectionName]
      if (entry && typeof entry.getToken === "function") {
        token = await entry.getToken(accountExternalId)
      }
    }
  } catch {
    // The host throws "No connected account" / "No access token stored" when the
    // connection is gone or the token is empty/expired — treated as "no token".
    return null
  }
  return token && token.length > 0 ? token : null
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

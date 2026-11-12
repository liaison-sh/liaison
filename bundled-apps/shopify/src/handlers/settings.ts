// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B14 — Settings panel data + connection teardown handlers.
//
// `settingsLoad` backs `app.invokeTool("settings_load", {})` (read-only,
// ungated). It returns exactly the `SettingsBundle` shape the Settings UI
// (`src/ui/settings.tsx`) consumes: connection snapshot, identity-mapping
// rows, sync diagnostics, inventory-location allowlist, and Plus-only seed
// suggestions.
//
// `connectionDisconnect` backs `app.invokeTool("connection_disconnect", {})`
// (gated admin, trustBoundary user). It tears down the Shopify connection as
// far as the app SDK allows — see the note on its declaration below for the
// kernel affordance that is still missing.
//
// Data sources are all APP-OWNED tables (`install_metadata`, `staff_mirror`,
// `staff_overrides`, `backfill_progress`, `webhook_deliveries`). We do NOT
// read `kernel.users` here: the sandbox db bridge resolves entities against
// `app_shopify.<entity>`, so a `kernel.users` enumeration cannot work from a
// sandboxed bundled app today (see crossTrackNeeds). The identity-mapping
// rows are therefore derived from the staff mirror + overrides, and the
// displayed identity is the Shopify staff email until a kernel user-directory
// read affordance lands.
import type { AppContext } from "@liaison/app-sdk"
import { grantSatisfies, REQUIRED_OAUTH_SCOPES, recordedGrantedScopes } from "../lib/constants"
import { resolveInstallMetadata } from "../lib/get-client"
import { camelizeRows } from "../lib/install-metadata"
import { scopeSeedJob } from "./scope-seed"

// ── SettingsBundle shape (mirrors src/ui/settings.tsx) ──────────────────────
interface IdentityMappingRow {
  liaisonUserId: string
  liaisonEmail: string
  shopifyStaffId: string | null
  source: "auto" | "override" | "unmapped"
}

interface DiagnosticsSnapshot {
  staffMirrorLastSyncedAt: string | null
  backfillStatus: "idle" | "running" | "failed" | "completed"
  backfillCursor: string | null
  webhookDeliveriesProcessed24h: number
  webhookDeliveriesFailed24h: number
}

interface ConnectionSnapshot {
  status: "connected" | "disconnected" | "needs_reconnect"
  shopDomain: string | null
  connectedAt: string | null
  /** Whether the recorded OAuth grant is known (a connection made before the
   *  kernel recorded granted scopes reports false — the operator should
   *  reconnect once so the grant becomes verifiable). */
  scopesKnown: boolean
  /** Manifest-required scopes the recorded grant is missing. Non-empty means
   *  a permissions update: tools degrade (60-day order window, no analytics)
   *  until the operator reconnects and re-authorizes. */
  missingScopes: string[]
}

interface SeedSuggestionRow {
  liaisonUserId: string
  shopifyStaffEmail: string
  scopes: string[]
}

export interface SettingsBundle {
  connection: ConnectionSnapshot
  mappings: IdentityMappingRow[]
  diagnostics: DiagnosticsSnapshot
  inventoryAllowlist: string[]
  seedAvailable: boolean
  seedSuggestions: SeedSuggestionRow[]
}

// ── Row shapes (app-owned schema, see app.manifest.json#schema) ─────────────
interface InstallMetadataRow {
  id: string
  shopDomain?: string | null
  installedAt?: string | Date | null
  connectionStatus?: "connected" | "disconnected" | "needs_reconnect" | null
  inventoryLocationAllowlist?: unknown
  consecutiveScopeMirrorFailures?: number | null
}

interface StaffMirrorRow {
  shopifyStaffId?: string | null
  email?: string | null
  mappedLiaisonUserId?: string | null
  lastSyncedAt?: string | Date | null
}

interface StaffOverrideRow {
  liaisonUserId?: string | null
  shopifyStaffId?: string | null
}

interface BackfillProgressRow {
  entityType?: string | null
  cursorExternalId?: string | null
  status?: "idle" | "running" | "failed" | "completed" | null
}

interface WebhookDeliveryRow {
  status?: "processing" | "processed" | "failed" | null
  receivedAt?: string | Date | null
}

// A row can flip from "connected" to "needs_reconnect" without the kernel
// emitting a disconnect: a run of scope-mirror failures (a revoked/expired
// token surfaces as repeated 401s) means the connection exists but cannot
// sync. Mirror the Settings UI's tri-state semantics here.
const NEEDS_RECONNECT_FAILURE_THRESHOLD = 3

function toIso(v: string | Date | null | undefined): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString()
  return v
}

function deriveConnectionStatus(row: InstallMetadataRow | undefined): ConnectionSnapshot["status"] {
  if (!row || !row.shopDomain) return "disconnected"
  if (row.connectionStatus === "disconnected") return "disconnected"
  if (row.connectionStatus === "needs_reconnect") return "needs_reconnect"
  // `connected` in the kernel sense, but a sustained scope-mirror failure run
  // means the operator must re-authorise before sync resumes.
  if ((row.consecutiveScopeMirrorFailures ?? 0) >= NEEDS_RECONNECT_FAILURE_THRESHOLD) {
    return "needs_reconnect"
  }
  return "connected"
}

function parseAllowlist(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string")
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string")
    } catch {
      return []
    }
  }
  return []
}

/**
 * Read-only, ungated. Backs `settings_load`.
 */
export async function settingsLoad(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<SettingsBundle> {
  // 1. Connection — resolved the same way home_load resolves it, so the two
  //    never disagree: when the row is missing but the shop connection is
  //    still active (the connect event was lost) this derives it in memory
  //    rather than reporting disconnected. Read-only: settingsLoad is
  //    `readOnly` in the manifest, so it must never persist the heal itself
  //    (that write happens on the webhook/disconnect paths and the hourly
  //    scan job).
  const meta = await resolveInstallMetadata(ctx)
  // Scope drift: compare the RECORDED grant against what the current manifest
  // requires. An empty recorded grant means the connection predates granted-
  // scope tracking — unverifiable, so surface "unknown" rather than guessing.
  const grantedScopes = recordedGrantedScopes(meta)
  const scopesKnown = grantedScopes.length > 0
  const granted = new Set(grantedScopes)
  // Shopify reports `write_X` without `read_X` (see grantSatisfies).
  const satisfied = (s: string): boolean => grantSatisfies(granted, s)
  const missingScopes = scopesKnown ? REQUIRED_OAUTH_SCOPES.filter((s) => !satisfied(s)) : []
  const connection: ConnectionSnapshot = {
    status: deriveConnectionStatus(meta ?? undefined),
    shopDomain: meta?.shopDomain ?? null,
    connectedAt: toIso(meta?.installedAt),
    scopesKnown,
    missingScopes,
  }

  // 2. Identity mappings — staff_mirror is the source of truth for "which
  //    Shopify staff exist", staff_overrides re-points specific staff to a
  //    Liaison user. We surface one row per staff mirror entry. `liaisonEmail`
  //    is the Shopify staff email (the only identity available without a
  //    kernel user-directory read — see crossTrackNeeds).
  const [mirrorRowsRaw, overrideRowsRaw] = await Promise.all([
    ctx.db.findMany("staff_mirror", { limit: 1000 }) as Promise<Array<Record<string, unknown>>>,
    ctx.db.findMany("staff_overrides", { limit: 1000 }) as Promise<Array<Record<string, unknown>>>,
  ])
  const mirrorRows = camelizeRows<StaffMirrorRow>(mirrorRowsRaw)
  const overrideRows = camelizeRows<StaffOverrideRow>(overrideRowsRaw)
  const overrideByStaffId = new Map<string, string>()
  for (const o of overrideRows) {
    if (o.shopifyStaffId && o.liaisonUserId)
      overrideByStaffId.set(o.shopifyStaffId, o.liaisonUserId)
  }
  const mappings: IdentityMappingRow[] = mirrorRows.map((m) => {
    const staffId = m.shopifyStaffId ?? null
    const overrideUserId = staffId ? overrideByStaffId.get(staffId) : undefined
    if (overrideUserId) {
      return {
        liaisonUserId: overrideUserId,
        liaisonEmail: m.email ?? "",
        shopifyStaffId: staffId,
        source: "override" as const,
      }
    }
    if (m.mappedLiaisonUserId) {
      return {
        liaisonUserId: m.mappedLiaisonUserId,
        liaisonEmail: m.email ?? "",
        shopifyStaffId: staffId,
        source: "auto" as const,
      }
    }
    return {
      liaisonUserId: m.mappedLiaisonUserId ?? "",
      liaisonEmail: m.email ?? "",
      shopifyStaffId: staffId,
      source: "unmapped" as const,
    }
  })

  // 3. Diagnostics.
  const lastSyncedAt = mirrorRows.reduce<string | null>((acc, m) => {
    const iso = toIso(m.lastSyncedAt)
    if (!iso) return acc
    if (!acc || iso > acc) return iso
    return acc
  }, null)

  // Customer backfill is the only backfill Phase 16 runs; surface it as THE
  // backfill state. If absent, treat as idle. entityType matches the value
  // written by the backfill-customers handler ("customers", plural). The db
  // bridge returns snake_case rows, so camelize before the entityType lookup.
  const CUSTOMER_BACKFILL_ENTITY_TYPE = "customers"
  const backfillRows = camelizeRows<BackfillProgressRow>(
    (await ctx.db.findMany("backfill_progress", { limit: 50 })) as Array<Record<string, unknown>>,
  )
  const customerBackfill =
    backfillRows.find((b) => b.entityType === CUSTOMER_BACKFILL_ENTITY_TYPE) ?? backfillRows[0]
  const backfillStatus = customerBackfill?.status ?? "idle"
  const backfillCursor = customerBackfill?.cursorExternalId ?? null

  // Webhook delivery counts over the trailing 24h. The db bridge `where` only
  // supports equality, so we pull recent rows and filter the window in-memory.
  // 250 rows is a generous ceiling for a 24h window at typical volume.
  const recentDeliveries = camelizeRows<WebhookDeliveryRow>(
    (await ctx.db.findMany("webhook_deliveries", {
      orderBy: { receivedAt: "desc" },
      limit: 250,
    })) as Array<Record<string, unknown>>,
  )
  const cutoff = Date.now() - 24 * 3_600_000
  let processed24h = 0
  let failed24h = 0
  for (const d of recentDeliveries) {
    const iso = toIso(d.receivedAt)
    const t = iso ? new Date(iso).getTime() : Number.NaN
    if (Number.isNaN(t) || t < cutoff) continue
    if (d.status === "processed") processed24h++
    else if (d.status === "failed") failed24h++
  }

  const diagnostics: DiagnosticsSnapshot = {
    staffMirrorLastSyncedAt: lastSyncedAt,
    backfillStatus,
    backfillCursor,
    webhookDeliveriesProcessed24h: processed24h,
    webhookDeliveriesFailed24h: failed24h,
  }

  // 4. Inventory allowlist.
  const inventoryAllowlist = parseAllowlist(meta?.inventoryLocationAllowlist)

  // 5. Plus-only seed suggestions. `scopeSeedJob` probes the Plus-only
  //    `read_users` capability and returns suggestions WITHOUT writing grants.
  //    When the connection is down we skip the probe entirely (it would just
  //    fail-closed to `available:false`).
  let seedAvailable = false
  let seedSuggestions: SeedSuggestionRow[] = []
  if (connection.status === "connected") {
    try {
      const seed = await scopeSeedJob({}, ctx)
      seedAvailable = seed.available
      seedSuggestions = seed.suggestions.map((s) => ({
        liaisonUserId: s.liaisonUserId,
        shopifyStaffEmail: s.shopifyStaffEmail,
        scopes: s.scopes,
      }))
    } catch {
      seedAvailable = false
      seedSuggestions = []
    }
  }

  return {
    connection,
    mappings,
    diagnostics,
    inventoryAllowlist,
    seedAvailable,
    seedSuggestions,
  }
}

/**
 * Gated admin handler — backs `connection_disconnect`.
 *
 * Tears down the Shopify connection as far as the app SDK allows. There is NO
 * SDK affordance for an app to disconnect a connected account
 * (`ConnectionClient` exposes only `getToken` / `getAccounts`; the kernel's
 * `disconnectConnection` is HTTP-route-only and not bridged into AppContext).
 * So we do the app-side half: flip `install_metadata.connectionStatus` to
 * `disconnected`, which immediately stops background sync jobs (they gate on
 * this status) and flips the Settings UI to the "Disconnected" / "Connect"
 * state. The kernel-side `connected_accounts` row is NOT yet torn down — see
 * crossTrackNeeds for the exact affordance required (`ctx.connections.shop.
 * disconnect(identifier)` or equivalent) so the OAuth token is actually
 * revoked/removed and a re-connect re-runs the full OAuth dance.
 */
export async function connectionDisconnect(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ ok: true; status: "disconnected" }> {
  const rows = (await ctx.db.findMany("install_metadata", {
    limit: 1,
  })) as InstallMetadataRow[]
  const row = rows[0]
  if (row) {
    await ctx.db.update("install_metadata", row.id, {
      connectionStatus: "disconnected",
    })
  }
  return { ok: true, status: "disconnected" }
}

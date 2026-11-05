// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B10 — Plus-conditional one-shot scope seed (Gap-log #7).
//
// Three entry points:
//   - `capabilityDetectSeed(ctx)`     : probes `staffMembers(first:1)`; returns true iff the
//                                        Shopify token has the `read_users` scope (Plus-only,
//                                        Partner-Support-gated). Never throws.
//   - `scopeSeedJob(params, ctx)`     : when capability present, returns suggested grants;
//                                        does NOT write to grants. The admin reviews/applies
//                                        from Settings → Shopify (Task B14).
//   - `applySeedSuggestion(args, ctx)`: scope-gated admin handler that finally calls
//                                        `ctx.grants_setUserScopes`. Idempotent.
//
// User-by-email lookup is performed via `ctx.db.findMany("kernel.users", { where: {email} })`
// — the mock surface exercised in unit tests; in production the host bridges this read
// through the kernel-side user directory (no row-level data leaves the kernel).
//
// Admin overrides win over email auto-match: a `staff_overrides` row keyed by
// `shopifyStaffId` re-maps that staff member to a different Liaison user.
//
// Same-email duplicate staff members fail closed (excluded + flagged in `conflicts`).
import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "../lib/get-client"
import type { ShopifyClient } from "../lib/shopify-client"
import { mapStaffPermissionsToScopes } from "../lib/staff-permissions-map"

interface SeedError extends Error {
  code: string
}

function makeError(code: string, message: string): SeedError {
  const e = new Error(message) as SeedError
  e.code = code
  return e
}

interface StaffNode {
  id: string
  email?: string | null
  permissions?: string[] | null
  isShopOwner?: boolean | null
}

interface StaffEdge {
  node: StaffNode
}

interface StaffMembersPage {
  edges: StaffEdge[]
  pageInfo?: { hasNextPage: boolean; endCursor?: string | null }
}

interface ShopifyResponse {
  data?: { staffMembers?: StaffMembersPage }
  errors?: Array<{ message: string }>
}

const PROBE_QUERY = `
  query StaffMembersProbe {
    staffMembers(first: 1) {
      edges { node { id email isShopOwner } }
    }
  }
`

const FULL_QUERY = `
  query StaffMembersAll($cursor: String) {
    staffMembers(first: 250, after: $cursor) {
      edges { node { id email permissions isShopOwner } }
      pageInfo { hasNextPage endCursor }
    }
  }
`

/**
 * Single-probe capability detector. Returns false on any Access-denied error,
 * non-2xx response, or thrown network error. Never throws.
 */
export async function capabilityDetectSeed(ctx: AppContext): Promise<boolean> {
  try {
    const client = await getShopifyClient(ctx)
    const data = await client.query<ShopifyResponse["data"]>(PROBE_QUERY, {})
    // `query` throws on GraphQL errors / non-2xx; if we got here, it has data.
    return Array.isArray(data?.staffMembers?.edges)
  } catch {
    return false
  }
}

export interface SeedSuggestion {
  liaisonUserId: string
  shopifyStaffEmail: string
  scopes: string[]
}

export interface SeedConflict {
  email: string
  staffIds: string[]
  reason: "duplicate_email"
}

export interface ScopeSeedResult {
  available: boolean
  suggestions: SeedSuggestion[]
  conflicts: SeedConflict[]
}

/** Fetch ALL staff members, paginating up to 10 pages (2500 max). */
async function fetchAllStaff(client: ShopifyClient): Promise<StaffNode[]> {
  const out: StaffNode[] = []
  let cursor: string | null = null
  for (let i = 0; i < 10; i++) {
    const data: { staffMembers?: StaffMembersPage } = await client.query<{
      staffMembers?: StaffMembersPage
    }>(FULL_QUERY, cursor ? { cursor } : {})
    const page: StaffMembersPage | undefined = data?.staffMembers
    if (!page) break
    for (const edge of page.edges) out.push(edge.node)
    if (!page.pageInfo?.hasNextPage) break
    cursor = page.pageInfo.endCursor ?? null
    if (!cursor) break
  }
  return out
}

/**
 * Produce seed suggestions WITHOUT writing to grants. Admin applies each
 * suggestion explicitly via `applySeedSuggestion`.
 */
export async function scopeSeedJob(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<ScopeSeedResult> {
  // 1. Capability probe.
  const available = await capabilityDetectSeed(ctx)
  if (!available) return { available: false, suggestions: [], conflicts: [] }

  // 2. Pull all staff.
  let staff: StaffNode[]
  try {
    const client = await getShopifyClient(ctx)
    staff = await fetchAllStaff(client)
  } catch {
    return { available: false, suggestions: [], conflicts: [] }
  }

  // 3. Group by email; same-email duplicates → conflict.
  const byEmail = new Map<string, StaffNode[]>()
  for (const s of staff) {
    if (!s.email) continue
    const key = s.email.toLowerCase()
    const list = byEmail.get(key) ?? []
    list.push(s)
    byEmail.set(key, list)
  }

  const conflicts: SeedConflict[] = []
  const uniqueStaff: StaffNode[] = []
  for (const [email, members] of byEmail) {
    if (members.length > 1) {
      conflicts.push({
        email,
        staffIds: members.map((m) => m.id),
        reason: "duplicate_email",
      })
      continue
    }
    uniqueStaff.push(members[0]!)
  }

  // 4. Build override index (Shopify staff id → Liaison user id).
  const overrideRows = (await ctx.db.findMany("staff_overrides", {})) as Array<{
    liaisonUserId?: string
    shopifyStaffId?: string
  }>
  const overrideByStaffId = new Map<string, string>()
  for (const row of overrideRows) {
    if (row.shopifyStaffId && row.liaisonUserId) {
      overrideByStaffId.set(row.shopifyStaffId, row.liaisonUserId)
    }
  }

  // 5. Resolve each staff member to a Liaison user (override first, then email).
  // Two-pass: first resolve all members to Liaison user ids so that the
  // shop-owner "otherMapped" check can see which non-owner staff actually
  // resolved (via override OR email), not just which ones have an override row.
  type Resolved = { staff: StaffNode; liaisonUserId: string }
  const resolved: Resolved[] = []
  for (const s of uniqueStaff) {
    const overrideUserId = overrideByStaffId.get(s.id)
    let liaisonUserId: string | null = overrideUserId ?? null
    if (!liaisonUserId && s.email) {
      const users = (await ctx.db.findMany("kernel.users", {
        where: { email: s.email },
      })) as Array<{ id?: string }>
      liaisonUserId = users[0]?.id ?? null
    }
    if (!liaisonUserId) continue
    resolved.push({ staff: s, liaisonUserId })
  }

  // Whether at least one NON-OWNER staff member has resolved to a Liaison user.
  // Excludes the current staff member and any other shop owner — the guard's
  // intent is "another ordinary staff member is mapped, so seeding the owner's
  // full scope set is safe". Using the fully-resolved set (override + email)
  // matches the documented intent ("mapped to a Liaison user").
  const nonOwnerMappedIds = new Set(
    resolved.filter((r) => !r.staff.isShopOwner).map((r) => r.staff.id),
  )

  const suggestions: SeedSuggestion[] = []
  for (const { staff: s, liaisonUserId } of resolved) {
    const scopes = mapStaffPermissionsToScopes({ permissions: s.permissions ?? [] })
    if (scopes.length === 0 && !s.isShopOwner) continue
    // Shop owners with no explicit permissions list inherit full, but only when
    // the store has at least one non-owner staff member that also mapped to a
    // Liaison user. An owner-only store with zero mapped users should not have
    // the full scope set seeded automatically — the operator must configure
    // scopes explicitly via the admin UI.
    const otherMapped = nonOwnerMappedIds.size > 0
    const finalScopes =
      s.isShopOwner && scopes.length === 0 && otherMapped
        ? mapStaffPermissionsToScopes({ permissions: ["full"] })
        : scopes
    if (finalScopes.length === 0) continue
    suggestions.push({
      liaisonUserId,
      shopifyStaffEmail: s.email ?? "",
      scopes: finalScopes,
    })
  }

  return { available: true, suggestions, conflicts }
}

/**
 * The complete set of scopes the seed path is ever allowed to grant. This is
 * exactly the universe `mapStaffPermissionsToScopes` can emit (a Shopify
 * "full"-permission staff member), which by construction contains ZERO
 * `shopify:admin:*` scopes — the admin scopes (`shopify:admin:identity-map`,
 * `shopify:admin:scope-seed`) are operator-conferred, never derivable from a
 * Shopify staff permission. Computed once at module load.
 *
 * Security (Gap #3): the seed path must never let a `shopify:admin:scope-seed`
 * holder self-escalate to arbitrary admin scopes by passing them in
 * `args.scopes`. We re-derive the grantable universe server-side and intersect
 * the caller's request with it, so anything outside the staff-permission-
 * derived set (notably every `shopify:admin:*`) is dropped before it can reach
 * `grants_setUserScopes`.
 */
const SEED_GRANTABLE_SCOPES: ReadonlySet<string> = new Set(
  mapStaffPermissionsToScopes({ permissions: ["full"] }),
)

/**
 * Scope-gated admin handler — the only call site that writes to grants.
 * Replace semantics (per Task A1).
 *
 * The caller-supplied `args.scopes` is treated as a *request*, not authority:
 * it is intersected with the server-derived seed-grantable universe
 * (`SEED_GRANTABLE_SCOPES`) so a scope-seed admin cannot self-grant
 * `shopify:admin:*` (or any non-seed scope) through this path.
 */
export async function applySeedSuggestion(
  args: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ ok: true }> {
  const liaisonUserId = args.liaisonUserId
  const scopes = args.scopes
  if (typeof liaisonUserId !== "string" || !liaisonUserId) {
    throw makeError("INVALID_ARG", "liaisonUserId is required")
  }
  if (!Array.isArray(scopes)) {
    throw makeError("INVALID_ARG", "scopes must be an array")
  }
  // Re-derive server-side: keep only scopes that a Shopify staff permission
  // could legitimately seed. Drops anything caller-supplied that falls outside
  // the mapper's universe (every `shopify:admin:*`, any typo, any forged
  // scope). The dropped scopes are logged so an attempted escalation is
  // observable, not silent.
  const requested = scopes.filter((s): s is string => typeof s === "string")
  const granted: string[] = []
  const rejected: string[] = []
  for (const s of requested) {
    if (SEED_GRANTABLE_SCOPES.has(s)) granted.push(s)
    else rejected.push(s)
  }
  if (rejected.length > 0) {
    ctx.logger.warn("applySeedSuggestion: dropped non-seed-grantable scopes", {
      liaisonUserId,
      rejected,
    })
  }
  const result = await ctx.grants_setUserScopes(liaisonUserId, JSON.stringify(granted))
  const parsed = JSON.parse(result) as { ok?: boolean; error?: { message: string } }
  if (parsed.error) {
    throw makeError("GRANTS_FAILED", parsed.error.message)
  }
  return { ok: true }
}

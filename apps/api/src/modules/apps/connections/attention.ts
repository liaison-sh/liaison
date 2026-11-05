// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel connection-health attention source. Registered into
// `attentionItemsRegistry` at `["*", "kernel.connection_health"]` (see
// `modules/apps/init.ts`), gated on `kernel:apps:admin` — same scope as the
// Settings → Apps admin section this surfaces items for.
//
// Motivation: a connection whose OAuth token expires with no way to self-heal
// (no refresh token, or a refresh that has already failed terminally) used to
// fail silently — syncs just stopped, with the only trace in server logs. This
// makes that failure an actionable attention item: "reconnect X", pointing at
// the Settings → Apps surface, generically for every app (not just the app
// that happened to have a provider-side attention.ts).
//
// This is a pure table scan, not a live probe — it relies on
// `connected_accounts.status` / `token_expires_at` already being kept current
// by the connections service:
//   - `refreshOAuthAccessToken` / `refreshViaAccessToken` mark the account
//     `status = 'error'` on a terminal refresh failure (400/401 == revoked /
//     invalid_grant), so a failed refresh is already visible here with no
//     extra persistence work.
//   - The OAuth callback deactivates (`status = 'disconnected'`) the PRIOR
//     `active` row and inserts a fresh `active` row on reconnect — but it only
//     deactivates rows that are still `active` at that moment. A row already
//     marked `error` is left behind as-is (harmless: every read path already
//     filters `status = 'active'`, so an orphaned `error` row is invisible to
//     the app). To avoid resurrecting one of those as a permanent phantom
//     item, this provider reduces to the MOST RECENT row per
//     (appName, connectionName, identifier) before flagging — so once a fresh
//     `active` row exists for that identifier, the old `error` row is
//     superseded and the item clears, exactly like a successful reconnect.

import type { AttentionItem } from "@liaison/shared"
import { eq } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel/connected-accounts"
import { appSettingsRegistry, connectionConfigRegistry } from "~/modules/apps/app-registries"
import {
  loadAllowedMailDomains,
  mailboxOutsideAllowedDomains,
} from "~/modules/apps/connections/mail-domains"
import { loadOptedInScopes, protectedScopesOf } from "~/modules/apps/connections/protected-scopes"
import { restrictedScopesOf } from "~/modules/apps/connections/restricted-scopes"
import { appSettingsPath } from "~/modules/apps/settings-paths"

const PROVIDER_ITEM_CAP = 200

type ConnectionHealthReason =
  | "error"
  | "expired_no_refresh"
  | "missing_scopes"
  | "mail_domain_not_allowed"
  | "expires_soon"

type ConnectedAccountRow = typeof connectedAccounts.$inferSelect

/** Structural subset of a connected_accounts row that the health classifier
 *  needs — exported so other surfaces (e.g. the tickets inbox list) can run
 *  the SAME classification over a joined row without a full drizzle select. */
export interface ConnectionHealthInput {
  orgId: string
  appName: string
  connectionName: string
  status: string
  providerType: string
  tokenExpiresAt: Date | null
  refreshTokenEncrypted: string | null
  metadata: unknown
  /** When the row (and so its token) was last written. */
  updatedAt?: Date | null
}

interface FlaggedAccount {
  id: string
  appName: string
  connectionName: string
  identifier: string
  displayName: string | null
  statusMessage: string | null
  tokenExpiresAt: Date | null
  /** For `expires_soon`: when, and how Liaison knows. */
  expiry?: TokenExpiry | null
  reason: ConnectionHealthReason
  missingScopes?: string[]
  /** Set when every missing scope is a protected one (protected-scopes.ts). */
  protectedScopes?: ProtectedScopeState
  /** The provider grants the scopes of its app's released configuration
   *  (`scopesFromAppConfiguration`, Shopify-managed installation): a reconnect alone
   *  cannot add a scope that configuration lacks. */
  scopesFromAppConfiguration?: boolean
}

/** The missing protected scopes of a connection and where the org stands on them. */
interface ProtectedScopeState {
  /** Labels of the settings that opt in, as the app's settings page shows them. */
  settingLabels: string[]
  /** The org already turned every one of them on: only a reconnect is left. */
  optedIn: boolean
}

/**
 * True when this connection has NO way to self-heal an expired access token:
 * no stored refresh token, and the connection isn't declared as one of the
 * self-refresh-via-access-token providers (Instagram-style long-lived tokens).
 */
function cannotSelfHeal(account: ConnectionHealthInput): boolean {
  if (account.refreshTokenEncrypted) return false
  const connConfig = connectionConfigRegistry.get([
    account.orgId,
    account.appName,
    account.connectionName,
  ])
  return connConfig?.refreshUsesAccessToken !== true
}

/**
 * Reduce to the latest row (by `updatedAt`) per (appName, connectionName,
 * identifier) key. An `error` row superseded by a later `active`/`disconnected`
 * row for the same identifier is dropped — it's a stale artifact of an OLDER
 * connection attempt, not the account's current state.
 */
function latestPerIdentifier(rows: ConnectedAccountRow[]): ConnectedAccountRow[] {
  const latest = new Map<string, ConnectedAccountRow>()
  for (const row of rows) {
    const key = `${row.appName}\u0000${row.connectionName}\u0000${row.identifier}`
    const existing = latest.get(key)
    if (!existing || row.updatedAt.getTime() > existing.updatedAt.getTime()) {
      latest.set(key, row)
    }
  }
  return [...latest.values()]
}

/** Scope drift: an ACTIVE oauth2 connection whose RECORDED grant is missing
 *  scopes the manifest now requires. This is the silent-degradation case a
 *  token-health check can never see — the provider does not error, it just
 *  hides data (e.g. Shopify's 60-day order window without read_all_orders).
 *  Only VERIFIED drift is flagged: a connection made before granted-scope
 *  tracking has no recorded grant, and nagging every legacy connection would
 *  drown the feed — the app's Settings banner covers the unknown case. */
function missingScopesFor(row: ConnectionHealthInput): string[] {
  if (row.status !== "active" || row.providerType !== "oauth2") return []
  const granted = (row.metadata as Record<string, unknown> | null)?.grantedOAuthScopes
  if (!Array.isArray(granted) || granted.length === 0) return []
  const connConfig = connectionConfigRegistry.get([row.orgId, row.appName, row.connectionName])
  // A protected scope (protected-scopes.ts) is required too: without it the provider
  // hides data (Shopify: orders older than 60 days), so it is always flagged; the
  // summary says how to get it (summaryFor).
  // A restricted scope (restricted-scopes.ts) missing from the grant is the
  // narrower mode the account was connected in (Drive: picked files), not drift.
  const restricted = new Set(restrictedScopesOf(connConfig))
  const required = [
    ...(connConfig?.scopes ?? []).filter((s) => !restricted.has(s)),
    ...protectedScopesOf(connConfig).map((p) => p.scope),
  ]
  if (required.length === 0) return []
  const have = new Set(granted.filter((s): s is string => typeof s === "string"))
  return required.filter((s) => !scopeSatisfied(s, have))
}

/** Google records OpenID Connect identity grants in canonical URL form even
 *  when they were REQUESTED as the short OIDC aliases (`email`, `profile`).
 *  A manifest that asks for `email` gets a grant recorded as
 *  `https://www.googleapis.com/auth/userinfo.email` — the same permission,
 *  different spelling. A literal set diff would flag these forever on every
 *  Google connection (Gmail, Calendar, Drive). Each alias maps to the exact
 *  canonical URL(s) Google reports for it — nothing broader, so genuinely
 *  missing scopes (e.g. gmail.modify) still flag. */
const GOOGLE_IDENTITY_SCOPE_EQUIVALENTS: Record<string, readonly string[]> = {
  email: ["https://www.googleapis.com/auth/userinfo.email"],
  profile: ["https://www.googleapis.com/auth/userinfo.profile"],
  openid: ["https://www.googleapis.com/auth/userinfo.email"], // any OIDC grant implies openid; Google always returns `openid` verbatim, this is a belt-and-braces fallback
}

/** Google scopes a BROADER grant already includes. A manifest that narrows its
 *  request (Calendar: full `calendar` down to `calendar.events` +
 *  `calendar.calendarlist.readonly`) must not flag the connections made before
 *  the narrowing: their recorded grant is the broader scope, which covers the
 *  narrow ones. Each entry lists only Google's documented supersets. */
const GOOGLE_BROADER_SCOPES: Record<string, readonly string[]> = {
  "https://www.googleapis.com/auth/calendar.events": ["https://www.googleapis.com/auth/calendar"],
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly": [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist",
  ],
}

/** Providers with verb_resource scopes (Shopify et al) NORMALIZE the grant they
 *  report: `write_X` implies `read_X`, so the token response omits the read
 *  scope even though it was requested and is effectively held. A literal set
 *  diff would flag every such read scope as missing forever. URL-style scopes
 *  (Google) never match the `read_`/`write_` prefix pair, so this is a no-op
 *  for them. Google's OIDC identity aliases are handled via
 *  GOOGLE_IDENTITY_SCOPE_EQUIVALENTS above. */
function scopeSatisfied(required: string, granted: ReadonlySet<string>): boolean {
  if (granted.has(required)) return true
  const equivalents = GOOGLE_IDENTITY_SCOPE_EQUIVALENTS[required]
  if (equivalents?.some((url) => granted.has(url))) return true
  if (GOOGLE_BROADER_SCOPES[required]?.some((url) => granted.has(url))) return true
  return required.startsWith("read_") && granted.has(`write_${required.slice("read_".length)}`)
}

/** How long before a token that cannot renew itself lapses its connection's admins are told. */
export const EXPIRY_REMINDER_MS = 14 * 24 * 60 * 60 * 1000

/** A stored expiry reminds only for a token meant to last longer than this (no standing noise). */
const MIN_REMINDED_LIFETIME_MS = 24 * 60 * 60 * 1000

/** When a token lapses, and how Liaison knows. */
export interface TokenExpiry {
  at: Date
  /** "provider": the provider's own answer for the token (Meta's debug_token,
   *  `tokenDebugUrl`), the earlier of its expiry and its data-access expiry.
   *  "stored": the `expires_in` the token exchange gave. */
  source: "provider" | "stored"
  /** For "provider": which of the two lapses first. */
  kind: "token" | "data_access"
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t) : null
}

/**
 * The token's real expiry: the provider's own answer when it was asked at
 * connect (`metadata.tokenExpiry`, written for a connection that declares
 * `tokenDebugUrl`), else the stored `token_expires_at`. A provider that says
 * the token never lapses (both null) yields none.
 */
export function tokenExpiryOf(row: ConnectionHealthInput): TokenExpiry | null {
  const meta =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as { tokenExpiry?: { expiresAt?: unknown; dataAccessExpiresAt?: unknown } })
          .tokenExpiry
      : undefined
  if (meta && typeof meta === "object") {
    const token = isoDate(meta.expiresAt)
    const data = isoDate(meta.dataAccessExpiresAt)
    if (!token && !data) return null
    if (data && (!token || data.getTime() < token.getTime())) {
      return { at: data, source: "provider", kind: "data_access" }
    }
    return { at: token as Date, source: "provider", kind: "token" }
  }
  return row.tokenExpiresAt ? { at: row.tokenExpiresAt, source: "stored", kind: "token" } : null
}

/**
 * A healthy connection whose token lapses within EXPIRY_REMINDER_MS and that has
 * no way to renew it (no refresh token, no self-refresh): Facebook Login's
 * long-lived user token (about 60 days, its data access 90 days). Its admins are
 * reminded to reconnect before it lapses instead of learning from stopped
 * syncs. The provider's own expiry is used when known (`tokenExpiryOf`); a
 * stored expiry reminds only for a token meant to last over a day (`updatedAt`,
 * when the token was stored, to its expiry), so short-lived tokens make no
 * standing noise. Kept apart from classifyConnectionHealth: the account still
 * works, so inbox and mailbox health stay green.
 */
export function expiresSoonWithoutRenewal(row: ConnectionHealthInput, now = Date.now()): boolean {
  if (row.status !== "active" || row.providerType !== "oauth2" || !cannotSelfHeal(row)) return false
  const expiry = tokenExpiryOf(row)
  if (!expiry) return false
  const at = expiry.at.getTime()
  if (at <= now || at - now > EXPIRY_REMINDER_MS) return false
  if (
    expiry.source === "stored" &&
    row.updatedAt &&
    at - row.updatedAt.getTime() <= MIN_REMINDED_LIFETIME_MS
  ) {
    return false
  }
  return true
}

export function classifyConnectionHealth(row: ConnectionHealthInput): {
  reason: ConnectionHealthReason
  missingScopes?: string[]
} | null {
  // `status='error'` covers BOTH the terminal-refresh-failure path (self-
  // refresh 4xx / OAuth refresh invalid_grant) and any other app-level error
  // marking — a single check catches everything the service already persists.
  if (row.status === "error") return { reason: "error" }
  if (
    row.status === "active" &&
    row.providerType === "oauth2" &&
    row.tokenExpiresAt &&
    row.tokenExpiresAt.getTime() <= Date.now() &&
    cannotSelfHeal(row)
  ) {
    return { reason: "expired_no_refresh" }
  }
  const missingScopes = missingScopesFor(row)
  if (missingScopes.length > 0) return { reason: "missing_scopes", missingScopes }
  return null
}

/**
 * When every missing scope of a connection is a protected one, the labels of the
 * settings that opt in to them and whether the org turned them all on; otherwise
 * undefined (a plain reconnect fixes it).
 */
async function protectedScopeState(
  tx: PrivilegedDb,
  row: ConnectedAccountRow,
  missing: readonly string[] | undefined,
): Promise<ProtectedScopeState | undefined> {
  if (!missing?.length) return undefined
  const declared = protectedScopesOf(
    connectionConfigRegistry.get([row.orgId, row.appName, row.connectionName]),
  ).filter((p) => missing.includes(p.scope))
  if (declared.length !== missing.length) return undefined
  const optedIn = await loadOptedInScopes(tx, row.orgId, row.appName, declared)
  const fields = appSettingsRegistry.get([row.orgId, row.appName])?.manifestSettings?.fields.org
  const settingLabels = [
    ...new Set(declared.map((p) => fields?.get(p.setting)?.field.label ?? p.setting)),
  ]
  return { settingLabels, optedIn: optedIn.length === declared.length }
}

/** Where an operator RECONNECTS this app's account: the app's settings page or its
 *  connector card, decided by its manifest (settings-paths.ts). Kept here (not in
 *  the frontend opener) so the attention item itself carries its destination and
 *  the frontend needs no per-app knowledge. */
export function settingsRouteFor(orgId: string, appName: string): string {
  return appSettingsPath(orgId, appName)
}

function summaryFor(account: FlaggedAccount): string {
  const label = account.displayName ?? account.identifier
  if (account.reason === "error") {
    return `${account.appName} connection "${label}" needs reconnecting: ${
      account.statusMessage ?? "authorization error"
    }`
  }
  if (account.reason === "mail_domain_not_allowed") {
    return `${account.appName} mailbox "${label}" is outside this organisation's allowed mail domains: disconnect it, or add its domain`
  }
  // Where the provider grants its app's released configuration, the missing scopes
  // go into that configuration (and are released) before a reconnect can grant them.
  const configStep = account.scopesFromAppConfiguration
    ? `add ${(account.missingScopes ?? []).join(", ")} to the ${account.appName} app's configuration (download the current file from Liaison's setup guide, or add ${(account.missingScopes ?? []).length > 1 ? "them" : "it"} to its scopes) and release it, then `
    : ""
  if (account.reason === "missing_scopes" && account.protectedScopes) {
    const scopes = (account.missingScopes ?? []).join(", ")
    const settings = account.protectedScopes.settingLabels.join(", ")
    if (account.protectedScopes.optedIn) {
      return `${account.appName} connection "${label}" still lacks ${scopes} although ${settings} is on: ${configStep}reconnect it and approve. If ${account.appName} refuses the ${configStep ? "release" : "reconnect"}, its approval of ${scopes} is not through yet.`
    }
    return `${account.appName} connection "${label}" lacks ${scopes}, which ${account.appName} grants only after approving the app, so part of its data is hidden. Request ${scopes} from ${account.appName}, then, once approved, turn on ${settings} and ${configStep}reconnect.`
  }
  if (account.reason === "missing_scopes") {
    return `${account.appName} connection "${label}" needs re-authorization: new permissions required (${(account.missingScopes ?? []).join(", ")}). Data is silently limited until you ${configStep}reconnect.`
  }
  if (account.reason === "expires_soon" && account.expiry) {
    const { at, source, kind } = account.expiry
    const what = kind === "data_access" ? "its data access expires" : "it expires"
    const how =
      source === "provider" ? "as the provider reports it" : "from the expiry given at connect"
    return `${account.appName} connection "${label}": ${what} on ${at.toISOString().slice(0, 10)} (${how}) and it cannot renew itself: reconnect it before then to keep syncing`
  }
  return `${account.appName} connection "${label}" has expired, reconnect to resume syncing`
}

/**
 * Aggregator-facing kernel provider. Flags `connected_accounts` rows that need
 * an operator to reconnect. Registered as a wildcard (`"*"`) kernel provider
 * so it runs for EVERY app generically — apps never need their own copy of
 * this logic.
 */
export async function computeConnectionHealthAttentionItems(
  _tx: RlsClient,
  orgId: string,
  _userId: string,
): Promise<AttentionItem[]> {
  const flagged = await withPrivilegedDb(
    orgId,
    "connection-health-attention",
    async (ptx: PrivilegedDb) => {
      // Non-kernel app connections are invisible to a plain RLS-scoped read
      // (the SELECT policy only exposes org-owned rows for app_name='kernel'),
      // so this needs the privileged handle to see every app's connections.
      const rows = await ptx
        .select()
        .from(connectedAccounts)
        .where(eq(connectedAccounts.orgId, orgId))

      const out: FlaggedAccount[] = []
      // A mailbox connected before the org restricted its mail domains keeps
      // syncing; admins are told so they can disconnect it (mail-domains.ts).
      // On this transaction: a second privileged slot while holding one is the
      // shape that deadlocks a full pool (every feed poll asked for two).
      const allowedDomains = await loadAllowedMailDomains(orgId, ptx)
      for (const row of latestPerIdentifier(rows)) {
        const classified: ReturnType<typeof classifyConnectionHealth> =
          classifyConnectionHealth(row) ??
          (mailboxOutsideAllowedDomains(row, allowedDomains)
            ? { reason: "mail_domain_not_allowed" }
            : null) ??
          (expiresSoonWithoutRenewal(row) ? { reason: "expires_soon" } : null)
        if (!classified) continue
        out.push({
          id: row.id,
          appName: row.appName,
          connectionName: row.connectionName,
          identifier: row.identifier,
          displayName: row.displayName,
          statusMessage: row.statusMessage,
          tokenExpiresAt: row.tokenExpiresAt,
          expiry: classified.reason === "expires_soon" ? tokenExpiryOf(row) : null,
          reason: classified.reason,
          missingScopes: classified.missingScopes,
          protectedScopes: await protectedScopeState(ptx, row, classified.missingScopes),
          scopesFromAppConfiguration:
            connectionConfigRegistry.get([row.orgId, row.appName, row.connectionName])
              ?.scopesFromAppConfiguration === true,
        })
      }
      return out
    },
  )

  return flagged.slice(0, PROVIDER_ITEM_CAP).map((account) => {
    const item: AttentionItem = {
      id: `kernel:connection_health:${account.id}`,
      app: "kernel",
      entity: "connected_account",
      entityId: account.id,
      kind: "system_alert",
      summary: summaryFor(account),
      // ≥70 crosses the email-digest materializer threshold on purpose: a dead
      // connection silently stops syncs org-wide, so it must reach operators
      // who aren't watching the feed — not just sit in the home tab.
      // A reminder ahead of an expiry is not yet an outage: below the digest bar.
      urgency: account.reason === "expires_soon" ? 50 : 75,
      occurredAt: (account.expiry?.at ?? account.tokenExpiresAt ?? new Date()).toISOString(),
      // "kernel:settings" fully qualified: bare "settings" is an ambiguous tab
      // alias (invoicing registers its own local `settings` type) and resolves
      // to no component at all.
      action: { type: "open_entity", tabType: "kernel:settings", entityId: account.id },
      metadata: {
        appName: account.appName,
        settingsRoute: settingsRouteFor(orgId, account.appName),
        connectionName: account.connectionName,
        identifier: account.identifier,
        reason: account.reason,
        ...(account.missingScopes?.length ? { missingScopes: account.missingScopes } : {}),
        ...(account.statusMessage ? { statusMessage: account.statusMessage } : {}),
        ...(account.tokenExpiresAt ? { tokenExpiresAt: account.tokenExpiresAt.toISOString() } : {}),
      },
    }
    return item
  })
}

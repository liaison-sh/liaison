// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Adapter documents (`kernel.api_adapters`, kept versions in
 * `kernel.api_adapter_versions`, migration 0300) and the connection's
 * credentials (`kernel.connected_accounts`, multiInstance, org-owned), keyed by
 * (org, app, connection, identifier): the app is whichever declares the API
 * connection (declarations.ts). Rows are written only through the platform's
 * validated paths; reads are scoped to the org, app and connection explicitly
 * on the privileged pool, like every org-owned connection lookup.
 */
import { createHash, createHmac } from "node:crypto"
import {
  type Adapter,
  type AdapterIssue,
  adapterWarnings,
  saveOnlyIssues,
} from "@liaison/api-connector-core"
import { and, desc, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { canonicalJson } from "~/modules/apps/app-config"
import { decryptAccountCredentials } from "~/modules/apps/connections/service"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { validateAdapterDocument, validateStoredAdapterDocument } from "./adapter-policy"
import type { ApiConn } from "./declarations"

function adaptersTable() {
  return drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent("api_adapters")}`)
}

function versionsTable() {
  return drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent("api_adapter_versions")}`)
}

/** The WHERE of one connection's rows (no alias). */
function connRows(conn: ApiConn) {
  return drizzleSql`org_id = ${conn.orgId}::uuid AND app_name = ${conn.app} AND connection_name = ${conn.connection}`
}

/** How many previous documents each connection keeps. */
export const ADAPTER_HISTORY_LIMIT = 20

export interface AdapterRow {
  identifier: string
  adapter: Adapter
  updatedAt: string
  /**
   * What the stored document would be refused for if saved today, and what
   * it may get wrong (a search POST with no body): said, never dropped.
   */
  warnings: string[]
}

export type ConnectionStatus = "ok" | "needs_credentials" | "error"

interface RawRow {
  identifier: string
  adapter: unknown
  updated_at: string | Date
}

function toRow(raw: RawRow): AdapterRow | null {
  // Stored documents were validated on write; re-validate on read so a row
  // edited outside the route can never reach the transport unchecked.
  const parsed = validateStoredAdapterDocument(raw.adapter)
  if (!parsed.ok) return null
  // Rules the document may predate are warnings on read, never a reason to
  // drop it: a saved connection keeps every operation it had.
  const warnings = [...saveOnlyIssues(parsed.adapter), ...adapterWarnings(parsed.adapter)].map(
    (w) => `${w.path}: ${w.message}`,
  )
  return {
    identifier: raw.identifier,
    adapter: parsed.adapter,
    updatedAt: new Date(raw.updated_at).toISOString(),
    warnings,
  }
}

export async function listAdapterRows(conn: ApiConn): Promise<AdapterRow[]> {
  const rows = await withPrivilegedDb(conn.orgId, "api-connection-list-adapters", async (tx) =>
    extractRows<RawRow>(
      await tx.execute(drizzleSql`
        SELECT identifier, adapter, updated_at FROM ${adaptersTable()}
        WHERE ${connRows(conn)} ORDER BY identifier`),
    ),
  )
  return rows.map(toRow).filter((r): r is AdapterRow => r !== null)
}

export async function getAdapterRow(conn: ApiConn, identifier: string): Promise<AdapterRow | null> {
  const [raw] = await withPrivilegedDb(conn.orgId, "api-connection-get-adapter", async (tx) =>
    extractRows<RawRow>(
      await tx.execute(drizzleSql`
        SELECT identifier, adapter, updated_at FROM ${adaptersTable()}
        WHERE ${connRows(conn)} AND identifier = ${identifier} LIMIT 1`),
    ),
  )
  return raw ? toRow(raw) : null
}

/** The (app, connection) pairs of the org holding an adapter named `identifier`. */
export async function findAdapterConnections(
  orgId: string,
  identifier: string,
): Promise<ApiConn[]> {
  const rows = await withPrivilegedDb(orgId, "api-connection-find-adapter", async (tx) =>
    extractRows<{ app_name: string; connection_name: string }>(
      await tx.execute(drizzleSql`
        SELECT app_name, connection_name FROM ${adaptersTable()}
        WHERE org_id = ${orgId}::uuid AND identifier = ${identifier}
        ORDER BY app_name, connection_name`),
    ),
  )
  return rows.map((r) => ({ orgId, app: r.app_name, connection: r.connection_name }))
}

/**
 * What a stored credential is bound to: the API's origin (scheme, host,
 * port), the auth type and where the secret goes (the apiKey header or query
 * name, the oauth2 token URL and token host). An adapter re-upload that
 * changes any of these would send the stored secret somewhere its owner did
 * not enter it for.
 */
export function credentialTarget(adapter: Adapter): string {
  const auth = adapter.auth
  return JSON.stringify({
    origin: new URL(adapter.baseUrl).origin,
    type: auth.type,
    ...(auth.type === "apiKey" ? { in: auth.in, name: auth.name } : {}),
    ...(auth.type === "oauth2ClientCredentials"
      ? { tokenUrl: auth.tokenUrl, tokenHost: auth.tokenHost ?? null }
      : {}),
  })
}

function credentialAccountsOf(conn: ApiConn, identifier: string) {
  return and(
    eq(connectedAccounts.orgId, conn.orgId),
    eq(connectedAccounts.appName, conn.app),
    eq(connectedAccounts.connectionName, conn.connection),
    eq(connectedAccounts.identifier, identifier),
  )
}

/** Content hash of a stored document (the raw jsonb, valid or not): what a plan is pinned to. */
export function storedDocumentHash(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 32)
}

/** What saving `adapter` under `identifier` would do, computed before anything is written. */
export interface AdapterSavePlan {
  ok: true
  adapter: Adapter
  /** Hash of the stored document, null when the identifier is new. */
  priorHash: string | null
  /** The stored document's credential target, null when there is none (or it is unreadable). */
  priorTarget: string | null
  newTarget: string
  /** A stored document exists and its credential target differs (or cannot be read). */
  credentialTargetChanged: boolean
  /** Credential accounts are stored for this identifier. */
  credentialsPresent: boolean
  /** The save would delete the stored credentials: the confirmation the agent must give (A4). */
  wipesCredentials: boolean
  /** Operations of the stored document the new one no longer has. */
  removedOperations: string[]
  /** The stored document is this one already (a save would change nothing). */
  unchanged: boolean
}

export type AdapterSavePlanResult = AdapterSavePlan | { ok: false; issues: AdapterIssue[] }

/**
 * Validate `input` (the server parser and this deployment's host rules) and
 * compare it with the stored document. Nothing is written. Credentials are
 * deleted by a save exactly when `wipesCredentials` is true: the same rule
 * `upsertAdapterRow` applies (no readable prior, or a different target).
 */
export async function planAdapterSave(
  conn: ApiConn,
  identifier: string,
  input: unknown,
): Promise<AdapterSavePlanResult> {
  const parsed = validateAdapterDocument(input)
  if (!parsed.ok) return { ok: false, issues: parsed.issues }
  const adapter = parsed.adapter
  const { prior, credentialCount } = await withPrivilegedDb(
    conn.orgId,
    "api-connection-plan-adapter",
    async (tx) => {
      const [row] = extractRows<{ adapter: unknown }>(
        await tx.execute(drizzleSql`
          SELECT adapter FROM ${adaptersTable()}
          WHERE ${connRows(conn)} AND identifier = ${identifier} LIMIT 1`),
      )
      const accounts = await tx
        .select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(credentialAccountsOf(conn, identifier))
      return { prior: row ?? null, credentialCount: accounts.length }
    },
  )
  const priorParsed = prior ? validateStoredAdapterDocument(prior.adapter) : null
  const priorAdapter = priorParsed?.ok === true ? priorParsed.adapter : null
  const priorTarget = priorAdapter ? credentialTarget(priorAdapter) : null
  const newTarget = credentialTarget(adapter)
  const sameTarget = priorTarget !== null && priorTarget === newTarget
  const kept = new Set(adapter.operations.map((o) => o.name))
  return {
    ok: true,
    adapter,
    priorHash: prior ? storedDocumentHash(prior.adapter) : null,
    priorTarget,
    newTarget,
    credentialTargetChanged: prior !== null && !sameTarget,
    credentialsPresent: credentialCount > 0,
    wipesCredentials: credentialCount > 0 && !sameTarget,
    removedOperations: (priorAdapter?.operations ?? [])
      .map((o) => o.name)
      .filter((name) => !kept.has(name)),
    unchanged: priorAdapter !== null && canonicalJson(priorAdapter) === canonicalJson(adapter),
  }
}

/** The stored document changed after a save was planned (and approved) against it. */
export class AdapterChangedError extends Error {
  constructor(identifier: string) {
    super(
      `The adapter "${identifier}" changed after this save was prepared. Read it again and prepare the save anew.`,
    )
    this.name = "AdapterChangedError"
  }
}

/** Credentials were stored or removed after a save was planned (and approved) without them. */
export class CredentialsChangedError extends Error {
  constructor(identifier: string) {
    super(
      `The credentials of "${identifier}" changed after this save was prepared. Nothing was saved; prepare the save anew, so its credential warning is right.`,
    )
    this.name = "CredentialsChangedError"
  }
}

export interface UpsertAdapterResult {
  /** The identifier's credential accounts were deleted (the credential target changed). */
  credentialsCleared: boolean
}

export interface UpsertAdapterOptions {
  /**
   * The stored document's hash the save was planned against (`planAdapterSave`
   * `priorHash`, null for "no document yet"). A different stored document
   * refuses the save with `AdapterChangedError`, nothing written.
   */
  expectPriorHash?: string | null
  /**
   * Whether credentials were stored when the save was planned. When the save
   * would delete credentials and this differs from what is stored now (they
   * were entered or removed since), the save is refused with
   * `CredentialsChangedError`, nothing written: credentials entered after a
   * plan that announced no deletion are never silently wiped.
   */
  expectCredentialsPresent?: boolean
}

/**
 * Create or replace an adapter. The previous document is kept in
 * `adapter_versions` (the last ADAPTER_HISTORY_LIMIT per identifier), with who
 * saved it and when. When the credential target changed (or there was no
 * readable prior adapter), the identifier's credential accounts are deleted in
 * the same transaction, so the connection needs its credentials again: an
 * `api-connector:admin` without `accounts:admin` can re-point an adapter,
 * never a secret someone else entered.
 */
export async function upsertAdapterRow(
  conn: ApiConn,
  identifier: string,
  adapter: Adapter,
  /** Who saved it; null when no person did (a config apply with no admin). */
  userId: string | null,
  options: UpsertAdapterOptions = {},
): Promise<UpsertAdapterResult> {
  const orgId = conn.orgId
  return withPrivilegedDb(orgId, "api-connection-put-adapter", async (tx) => {
    const [prior] = extractRows<{
      adapter: unknown
      adapter_version: string
      updated_by: string | null
      updated_at: string | Date
    }>(
      await tx.execute(drizzleSql`
        SELECT adapter, adapter_version, updated_by, updated_at FROM ${adaptersTable()}
        WHERE ${connRows(conn)} AND identifier = ${identifier}
        FOR UPDATE`),
    )
    if (options.expectPriorHash !== undefined) {
      const current = prior ? storedDocumentHash(prior.adapter) : null
      if (current !== options.expectPriorHash) throw new AdapterChangedError(identifier)
    }
    const priorParsed = prior ? validateStoredAdapterDocument(prior.adapter) : null
    const sameTarget =
      priorParsed?.ok === true &&
      credentialTarget(priorParsed.adapter) === credentialTarget(adapter)
    if (options.expectCredentialsPresent !== undefined && !sameTarget) {
      const accounts = await tx
        .select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(credentialAccountsOf(conn, identifier))
        .for("update")
      if (accounts.length > 0 !== options.expectCredentialsPresent) {
        throw new CredentialsChangedError(identifier)
      }
    }
    if (prior) {
      await tx.execute(drizzleSql`
        INSERT INTO ${versionsTable()} (org_id, app_name, connection_name, identifier, adapter, adapter_version, saved_by, saved_at)
        VALUES (${orgId}::uuid, ${conn.app}, ${conn.connection}, ${identifier}, ${JSON.stringify(prior.adapter)}::jsonb,
                ${prior.adapter_version}, ${prior.updated_by}::uuid, ${new Date(prior.updated_at).toISOString()}::timestamptz)`)
      await tx.execute(drizzleSql`
        DELETE FROM ${versionsTable()}
        WHERE ${connRows(conn)} AND identifier = ${identifier}
          AND id NOT IN (
            SELECT id FROM ${versionsTable()}
            WHERE ${connRows(conn)} AND identifier = ${identifier}
            ORDER BY created_at DESC, saved_at DESC
            LIMIT ${ADAPTER_HISTORY_LIMIT})`)
    }
    await tx.execute(drizzleSql`
      INSERT INTO ${adaptersTable()} (org_id, app_name, connection_name, identifier, adapter, adapter_version, updated_by)
      VALUES (${orgId}::uuid, ${conn.app}, ${conn.connection}, ${identifier}, ${JSON.stringify(adapter)}::jsonb, ${adapter.version}, ${userId}::uuid)
      ON CONFLICT (org_id, app_name, connection_name, identifier) DO UPDATE SET
        adapter = EXCLUDED.adapter,
        adapter_version = EXCLUDED.adapter_version,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()`)
    if (sameTarget) return { credentialsCleared: false }
    const removed = await tx
      .delete(connectedAccounts)
      .where(credentialAccountsOf(conn, identifier))
      .returning({ id: connectedAccounts.id })
    return { credentialsCleared: removed.length > 0 }
  })
}

/** One kept previous document, newest first in listings. */
export interface AdapterVersionSummary {
  id: string
  adapterVersion: string
  name: string | null
  savedBy: string | null
  savedByName: string | null
  savedAt: string
  /** The kept document's credential target, null when it no longer validates. */
  credentialTarget: string | null
}

interface RawVersionRow {
  id: string
  adapter: unknown
  adapter_version: string
  saved_by: string | null
  saved_by_name: string | null
  saved_at: string | Date
}

function toVersionSummary(raw: RawVersionRow): AdapterVersionSummary {
  const parsed = validateStoredAdapterDocument(raw.adapter)
  return {
    id: raw.id,
    adapterVersion: raw.adapter_version,
    name: parsed.ok ? parsed.adapter.name : null,
    savedBy: raw.saved_by,
    savedByName: raw.saved_by_name,
    savedAt: new Date(raw.saved_at).toISOString(),
    credentialTarget: parsed.ok ? credentialTarget(parsed.adapter) : null,
  }
}

async function selectVersions(
  conn: ApiConn,
  identifier: string,
  versionId: string | null,
): Promise<RawVersionRow[]> {
  const usersTable = drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent("users")}`)
  return withPrivilegedDb(conn.orgId, "api-connection-adapter-versions", async (tx) =>
    extractRows<RawVersionRow>(
      await tx.execute(drizzleSql`
        SELECT v.id, v.adapter, v.adapter_version, v.saved_by, u.name AS saved_by_name, v.saved_at
        FROM ${versionsTable()} v
        LEFT JOIN ${usersTable} u ON u.id = v.saved_by AND u.org_id = v.org_id
        WHERE v.org_id = ${conn.orgId}::uuid AND v.app_name = ${conn.app}
          AND v.connection_name = ${conn.connection} AND v.identifier = ${identifier}
          ${versionId === null ? drizzleSql`` : drizzleSql`AND v.id = ${versionId}::uuid`}
        ORDER BY v.created_at DESC, v.saved_at DESC`),
    ),
  )
}

/** The kept previous documents of one connection, newest first. */
export async function listAdapterVersions(
  conn: ApiConn,
  identifier: string,
): Promise<AdapterVersionSummary[]> {
  return (await selectVersions(conn, identifier, null)).map(toVersionSummary)
}

/** One kept document of `identifier` (validated), or null when absent or no longer valid. */
export async function getAdapterVersion(
  conn: ApiConn,
  identifier: string,
  versionId: string,
): Promise<(AdapterVersionSummary & { adapter: Adapter }) | null> {
  if (!UUID_RE.test(versionId)) return null
  const [raw] = await selectVersions(conn, identifier, versionId)
  if (!raw) return null
  // A kept version may predate a save rule; restoring it is a save, which
  // refuses it with that rule's issue (planAdapterSave).
  const parsed = validateStoredAdapterDocument(raw.adapter)
  if (!parsed.ok) return null
  return { ...toVersionSummary(raw), adapter: parsed.adapter }
}

/** Remove the adapter row, its kept versions and every credential account of this identifier. */
export async function deleteConnection(conn: ApiConn, identifier: string): Promise<boolean> {
  return withPrivilegedDb(conn.orgId, "api-connection-delete-connection", async (tx) => {
    await tx.execute(drizzleSql`
      DELETE FROM ${versionsTable()}
      WHERE ${connRows(conn)} AND identifier = ${identifier}`)
    const removed = extractRows<{ identifier: string }>(
      await tx.execute(drizzleSql`
        DELETE FROM ${adaptersTable()}
        WHERE ${connRows(conn)} AND identifier = ${identifier}
        RETURNING identifier`),
    )
    const accounts = await tx
      .delete(connectedAccounts)
      .where(credentialAccountsOf(conn, identifier))
      .returning({ id: connectedAccounts.id })
    return removed.length > 0 || accounts.length > 0
  })
}

/** Status of each identifier's credential account. */
export async function credentialStatuses(conn: ApiConn): Promise<Map<string, ConnectionStatus>> {
  const rows = await withPrivilegedDb(
    conn.orgId,
    "api-connection-credential-status",
    (tx: PrivilegedDb) =>
      tx
        .select({ identifier: connectedAccounts.identifier, status: connectedAccounts.status })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.orgId, conn.orgId),
            eq(connectedAccounts.appName, conn.app),
            eq(connectedAccounts.connectionName, conn.connection),
            eq(connectedAccounts.ownerType, "org"),
          ),
        ),
  )
  const out = new Map<string, ConnectionStatus>()
  for (const r of rows) {
    if (r.status === "active") out.set(r.identifier, "ok")
    else if (r.status === "error") out.set(r.identifier, "error")
  }
  return out
}

/** One connection's decrypted credentials and the version that keys its caches. */
export interface ConnectionCredentials {
  values: Record<string, string>
  version: string
}

/**
 * The cache version of a credential account: HMAC-SHA256 under the server
 * secret of the account row's id and update time. It changes on every
 * credential post and reveals nothing about the values (an unsalted hash of a
 * low-entropy key could be brute-forced from a Redis key listing).
 */
export function credentialVersionOf(accountId: string, updatedAt: Date): string {
  return createHmac("sha256", env.JWT_SECRET)
    .update(`api-connector-credential:${accountId}:${updatedAt.toISOString()}`)
    .digest("hex")
    .slice(0, 32)
}

/** The org-owned credentials of one connection, or null when none are stored. */
export async function resolveConnectionCredentials(
  conn: ApiConn,
  identifier: string,
): Promise<ConnectionCredentials | null> {
  return (await resolveConnectionsCredentials(conn, [identifier])).get(identifier) ?? null
}

/**
 * The org-owned credentials of several connections, read in ONE short
 * privileged transaction that opens no other: each connection's newest active
 * account row, decrypted after the transaction has released its slot. A
 * connection with no usable credentials is absent from the map.
 *
 * The decryption happens here rather than through the generic connection
 * lookup, which opens a privileged transaction of its own: nested in this
 * one, every call held two slots of the privileged pool, and a few calls in
 * parallel (a customer card's role calls) each held one and waited for a
 * second until the pool's acquire timeout.
 */
export async function resolveConnectionsCredentials(
  conn: ApiConn,
  identifiers: readonly string[],
): Promise<Map<string, ConnectionCredentials>> {
  const out = new Map<string, ConnectionCredentials>()
  const wanted = [...new Set(identifiers)]
  if (wanted.length === 0) return out
  let rows: {
    identifier: string | null
    id: string
    updatedAt: Date
    credentialsEncrypted: string | null
  }[]
  try {
    rows = await withPrivilegedDb(conn.orgId, "api-connection-credentials", (tx) =>
      tx
        .select({
          identifier: connectedAccounts.identifier,
          id: connectedAccounts.id,
          updatedAt: connectedAccounts.updatedAt,
          credentialsEncrypted: connectedAccounts.credentialsEncrypted,
        })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.orgId, conn.orgId),
            eq(connectedAccounts.appName, conn.app),
            eq(connectedAccounts.connectionName, conn.connection),
            inArray(connectedAccounts.identifier, wanted),
            eq(connectedAccounts.ownerType, "org"),
            eq(connectedAccounts.status, "active"),
          ),
        )
        .orderBy(desc(connectedAccounts.updatedAt), desc(connectedAccounts.createdAt)),
    )
  } catch {
    return out
  }
  const seen = new Set<string>()
  for (const row of rows) {
    // Newest first: the first row of an identifier is the credential entered last.
    if (!row.identifier || seen.has(row.identifier)) continue
    seen.add(row.identifier)
    if (!row.credentialsEncrypted) continue
    try {
      out.set(row.identifier, {
        values: decryptAccountCredentials(row.credentialsEncrypted),
        version: credentialVersionOf(row.id, row.updatedAt),
      })
    } catch {
      // Unreadable credentials count as none, as they always have.
    }
  }
  return out
}

/** The effective scopes of one user of the org, re-loaded from the database (an approver's re-check). */
export async function loadUserScopes(orgId: string, userId: string): Promise<string[]> {
  const perms = await withPrivilegedDb(orgId, "api-connection-approver-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return perms.scopes
}

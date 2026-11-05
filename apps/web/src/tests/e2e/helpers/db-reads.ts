// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Read-only database lookups browser tests assert on (rows a UI action wrote).
// Seeding goes through ./seed.ts, never here.
import type { WorkerEnv } from "@liaison/test-helpers"

/** The kernel schema of this run (a lane has its own prefix). */
export function ks(env: WorkerEnv) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

export interface InviteRow {
  id: string
  email: string
  roleId: string
  tokenHash: string
  invitedBy: string
  expiresAt: Date
  acceptedAt: Date | null
}

/** Look up the most recent invite row for an email — used after a UI submit. */
export async function getInviteRow(env: WorkerEnv, email: string): Promise<InviteRow | null> {
  const rows = (await env.db.sql.unsafe(
    `SELECT id, email, role_id AS "roleId", token_hash AS "tokenHash",
            invited_by AS "invitedBy", expires_at AS "expiresAt",
            accepted_at AS "acceptedAt"
       FROM ${ks(env)}.invitations
      WHERE email = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [email.toLowerCase()],
  )) as InviteRow[]
  return rows[0] ?? null
}

/** Read a user's current permission_version. */
export async function getPermissionVersion(env: WorkerEnv, userId: string): Promise<number> {
  const rows = (await env.db.sql.unsafe(
    `SELECT permission_version FROM ${ks(env)}.users WHERE id = $1`,
    [userId],
  )) as Array<{ permission_version: number }>
  return rows[0]?.permission_version ?? 0
}

/** Lookup approval rows matching a bulkRequestId in the JSON metadata column. */
export async function getApprovalsForBulkRequest(
  env: WorkerEnv,
  bulkRequestId: string,
): Promise<Array<{ id: string; status: string; bulkItemId: string | null }>> {
  return (await env.db.sql.unsafe(
    `SELECT id, status, metadata->>'bulkItemId' AS "bulkItemId"
       FROM ${ks(env)}.approval_requests
      WHERE metadata->>'bulkRequestId' = $1
      ORDER BY created_at`,
    [bulkRequestId],
  )) as Array<{ id: string; status: string; bulkItemId: string | null }>
}

/** The active people of the org with this name (case-insensitive). */
export async function getActiveUsersNamed(
  env: WorkerEnv,
  orgId: string,
  name: string,
): Promise<Array<{ id: string; email: string }>> {
  return (await env.db.sql.unsafe(
    `SELECT id, email FROM ${ks(env)}.users
     WHERE org_id = $1 AND lower(name) = lower($2) AND status = 'active'`,
    [orgId, name],
  )) as Array<{ id: string; email: string }>
}

/** The org's SLA target (seconds) for a ticket priority, from its tickets settings. */
export async function getTicketSlaTargetSeconds(
  env: WorkerEnv,
  orgId: string,
  priority: "low" | "normal" | "high" | "urgent",
): Promise<number> {
  const rows = (await env.db.sql.unsafe(
    `SELECT (settings->'tickets'->'sla'->'targets'->>$2)::int AS target
       FROM ${ks(env)}.organizations WHERE id = $1`,
    [orgId, priority],
  )) as Array<{ target: number | null }>
  const target = rows[0]?.target
  if (!target) throw new Error(`no ${priority} SLA target in the org's tickets settings`)
  return target
}

export interface LabelCatalogRow {
  id: string
  name: string
  sortOrder: number
  values: Array<{ id: string; name: string; sortOrder: number }>
}

/** Live label groups of the org with their live values, both in sort order. */
export async function readLabelCatalog(env: WorkerEnv, orgId: string): Promise<LabelCatalogRow[]> {
  const ps = env.schemaPrefix ? `"${env.schemaPrefix}app_projects"` : "app_projects"
  const rows = (await env.db.sql.unsafe(
    `SELECT id::text AS id, parent_id::text AS parent_id, name, sort_order
       FROM ${ps}.labels
      WHERE org_id = $1 AND archived_at IS NULL
      ORDER BY parent_id NULLS FIRST, sort_order`,
    [orgId],
  )) as unknown as Array<{ id: string; parent_id: string | null; name: string; sort_order: number }>
  const groups: LabelCatalogRow[] = rows
    .filter((r) => r.parent_id === null)
    .map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, values: [] }))
  for (const r of rows) {
    if (r.parent_id === null) continue
    groups
      .find((g) => g.id === r.parent_id)
      ?.values.push({ id: r.id, name: r.name, sortOrder: r.sort_order })
  }
  return groups
}

// ── Mail rows ───────────────────────────────────────────────────────────────

/** The mail app's schema of this run. */
function ms(env: WorkerEnv) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
}

/** A raw row (`SELECT *`); the tests assert on it column by column. */
type Row = any

/** Mail messages matching a SQL `where` clause. */
export async function queryMailMessages(env: WorkerEnv, where: string): Promise<Row[]> {
  return env.db.sql.unsafe(`SELECT * FROM ${ms(env)}.messages WHERE ${where}`)
}

/** Mail accounts (mailboxes) matching a SQL `where` clause. */
export async function queryMailAccounts(env: WorkerEnv, where: string): Promise<Row[]> {
  return env.db.sql.unsafe(`SELECT * FROM ${ms(env)}.accounts WHERE ${where}`)
}

/** Connected accounts matching a SQL `where` clause. */
export async function queryConnectedAccounts(env: WorkerEnv, where: string): Promise<Row[]> {
  return env.db.sql.unsafe(`SELECT * FROM ${ks(env)}.connected_accounts WHERE ${where}`)
}

/** Wait until a draft row matching `where` satisfies `predicate` (the UI autosaved it). */
export async function waitForDraftRow(
  env: WorkerEnv,
  where: string,
  predicate: (row: Row) => boolean,
  timeoutMs = 10000,
): Promise<Row> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const rows = await env.db.sql.unsafe(`SELECT * FROM ${ms(env)}.drafts WHERE ${where} LIMIT 1`)
    if (rows[0] && predicate(rows[0])) return rows[0]
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Draft did not satisfy predicate within ${timeoutMs}ms: ${where}`)
}

/** Wait until no draft row matches `where` (the UI deleted it). */
export async function waitForNoDraftRow(
  env: WorkerEnv,
  where: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const rows = await env.db.sql.unsafe(`SELECT id FROM ${ms(env)}.drafts WHERE ${where} LIMIT 1`)
    if (rows.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Draft row still exists after ${timeoutMs}ms: ${where}`)
}

/** The latest run of a routine (status and error), or null before its first. */
export async function latestRoutineRun(
  env: WorkerEnv,
  routineId: string,
): Promise<{ status: string; error: string | null } | null> {
  const rows = (await env.db.sql.unsafe(
    `SELECT status, error FROM ${ks(env)}.routine_runs
      WHERE routine_id = $1 ORDER BY ran_at DESC LIMIT 1`,
    [routineId],
  )) as Array<{ status: string; error: string | null }>
  return rows[0] ?? null
}

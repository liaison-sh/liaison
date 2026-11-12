// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SECRET_COLUMNS — the defense-in-depth belt (not the primary wall).
//
// The primary wall is the readonly DB role's allow-list grant (see
// `deploy/postgres-init/20-readonly-role.sh` / `scripts/db-readonly-role.ts` /
// `apps/api/src/modules/apps/connections/sql/generated/readonly-grants.sql`): the role is
// never granted SELECT on these columns/tables at all, so even a catalog bug
// or a bypassed validator hits `42501` at the DB layer.
//
// This list is a second, independent check applied at catalog-validation time
// (`validateCatalog` below) and — for curated reads — as a projection filter
// on the executed result. It must stay in sync with the grant allow-list; a
// mismatch is a build-time concern (see Task 7), not something this module
// enforces on its own.
//
// Exhaustive sweep performed against `apps/api/src/db/migrations/0000_initial.sql`
// + `apps/api/src/db/schema/kernel/*.ts` for every `*_encrypted|*_hash|password|
// secret|totp|recovery|token`-shaped column across `kernel` and all `app_*`
// schemas (re-swept for review finding C1/S1 — the first pass only covered
// `kernel.*` + `app_mcp_manager.*`; the app-schema secrets below were missed).
//
// Columns considered and DELIBERATELY excluded as non-secret (grep noise from
// the `*_hash|*_token|*_encrypted` sweep, not auth/credential material):
// kernel.apps.schema_hash (app-bundle content hash), kernel.oauth_providers.
// token_endpoint (a public OAuth URL, not a token), kernel.credit_transactions.
// {input_tokens,output_tokens} (LLM token-usage counters), kernel.routine_state.
// content_hash / kernel.files.analysis_context_hash (content hashes, not
// secrets), kernel.connected_accounts.token_expires_at (a timestamp),
// kernel.users.{totp_enabled,totp_last_used_at} (boolean/timestamp, not secret
// material), app_tickets.tickets.summary_token_usage (LLM usage JSON).
export const SECRET_COLUMNS: ReadonlyArray<{ readonly table: string; readonly column: string }> = [
  { table: "kernel.users", column: "password_hash" },
  { table: "kernel.users", column: "totp_secret" },
  { table: "kernel.users", column: "recovery_codes" },
  { table: "kernel.oauth_providers", column: "client_secret_encrypted" },
  { table: "kernel.sessions", column: "refresh_token_hash" },
  { table: "kernel.mcp_connections", column: "refresh_token_hash" },
  { table: "kernel.password_resets", column: "token_hash" },
  { table: "kernel.invitations", column: "token_hash" },
  { table: "kernel.connected_accounts", column: "access_token_encrypted" },
  { table: "kernel.connected_accounts", column: "refresh_token_encrypted" },
  { table: "kernel.connected_accounts", column: "credentials_encrypted" },
  { table: "kernel.organizations", column: "settings" },
  { table: "app_mcp_manager.mcp_connections", column: "secrets_encrypted" },
  // Mail CONTENT, not a credential, but withheld on the same terms: for an
  // enrolled personal mailbox the subject is sealed to the user's own key and
  // the server cannot read it, so exposing the legacy plaintext column through
  // the readonly role would be a content leak that survives the cutover.
  // `app_mail.messages` needs no entry: it receives no grant at all.
  { table: "app_mail.conversations", column: "subject" },
  { table: "app_mail.conversations", column: "snippet" },
  // app_* secrets (C1 sweep completion — review_code.md C1):
  { table: "app_tickets.tickets", column: "reply_token" },
  { table: "app_tickets.ticket_csat", column: "survey_token" },
  { table: "app_tickets.api_keys", column: "key_hash" },
] as const

/** Fast lookup set, `"schema.table.column"` (lowercased). */
const SECRET_COLUMN_SET = new Set(
  SECRET_COLUMNS.map(({ table, column }) => `${table.toLowerCase()}.${column.toLowerCase()}`),
)

/** True if `schema.table` + `column` names an exhaustively-swept secret column. */
export function isSecretColumn(table: string, column: string): boolean {
  return SECRET_COLUMN_SET.has(`${table.toLowerCase()}.${column.toLowerCase()}`)
}

/** All secret columns declared for a given `schema.table` (case-insensitive). */
export function secretColumnsForTable(table: string): string[] {
  const lower = table.toLowerCase()
  return SECRET_COLUMNS.filter((c) => c.table.toLowerCase() === lower).map((c) => c.column)
}

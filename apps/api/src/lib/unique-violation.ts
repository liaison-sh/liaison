// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Match a postgres unique violation (SQLSTATE 23505) against the index that
// raised it, WITHOUT assuming the index carries the name the migration gave it.
//
// Why the name is not stable: the parallel test substrate clones every base
// schema into a per-worker schema with `CREATE TABLE ... (LIKE <src> INCLUDING
// ALL)` (packages/test-helpers/src/db.ts). `LIKE ... INCLUDING INDEXES` copies
// the index DEFINITION but NOT its name — postgres regenerates a default
// `<table>_<col>_<col>_idx`. So the same index is
// `kernel.agents_org_handle_idx` in the migrated schema and
// `w7_kernel.agents_org_id_handle_idx` in a worker schema, and
// `kernel.skills_unique_owner_agent_name_idx` becomes
// `w7_kernel.skills_owner_agent_id_name_idx`.
//
// A literal substring check on the migration name therefore MISSES the
// violation on every parallel/Playwright worker schema: the handler's
// collision branch never runs and the raw 23505 escapes as a 500. Every
// constraint-scoped catch must list BOTH spellings, which is what the
// `*_UNIQUE_INDEX` constants below exist for.
import { describeDbError } from "./transient-db-error"

/** kernel.agents (org_id, handle): migrated name, then the LIKE-clone name. */
export const AGENT_HANDLE_UNIQUE_INDEX = [
  "agents_org_handle_idx",
  "agents_org_id_handle_idx",
] as const

/** kernel.skills (owner_agent_id, name): migrated name, then the LIKE-clone name. */
export const SKILL_NAME_UNIQUE_INDEX = [
  "skills_unique_owner_agent_name_idx",
  "skills_owner_agent_id_name_idx",
] as const

/** kernel.routines (org_id, owner_user_id, name): migrated name, then the LIKE-clone name. */
export const ROUTINE_NAME_UNIQUE_INDEX = [
  "routines_unique_owner_name_idx",
  "routines_org_id_owner_user_id_name_idx",
] as const

/**
 * True iff `err` is a unique violation raised by one of `indexNames`.
 * Prefers postgres.js's STRUCTURED `constraint_name` and falls back to a
 * message substring when the driver did not carry one.
 */
export function isUniqueViolationOn(err: unknown, indexNames: readonly string[]): boolean {
  const { code, message, constraintName } = describeDbError(err)
  if (code !== "23505") return false
  if (constraintName) return indexNames.includes(constraintName)
  return !!message && indexNames.some((name) => message.includes(name))
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// Recognises the failure a seeding or migration script hits when it is handed
// the application's RLS-bound DSN instead of the owner's.
//
// The app role is deliberately row-level-security bound and owns no table, so
// a TRUNCATE, an ALTER or an insert that bypasses a policy fails with a
// Postgres error whose own text ("permission denied", "must be owner of
// table", "violates row-level security policy") says nothing about WHICH
// credential the caller should have used. Inside a deployed container, where
// DATABASE_URL is the app's, that is the whole diagnosis.

/** Postgres SQLSTATEs and message fragments that mean "this role is not the owner / is RLS-bound". */
const RLS_SIGNATURES = [
  "permission denied",
  "must be owner",
  "row-level security",
  "row level security",
  "insufficient privilege",
]

/** SQLSTATE 42501 is insufficient_privilege; 42P01 shows up when RLS hides a relation entirely. */
const RLS_SQLSTATES = ["42501"]

/** Whether an error is the app role hitting its own RLS/ownership boundary. */
export function isOwnerPrivilegeError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  if (typeof code === "string" && RLS_SQLSTATES.includes(code)) return true
  const message = err instanceof Error ? err.message : String(err ?? "")
  const lower = message.toLowerCase()
  return RLS_SIGNATURES.some((signature) => lower.includes(signature))
}

/**
 * The message to print instead of the raw Postgres error: names the cause
 * (the DSN in hand belongs to the RLS-bound app role) and the fix (run it
 * with the owner DSN), since neither is in the error itself.
 */
export function ownerDsnHint(scriptName: string): string {
  return (
    `${scriptName} needs the database OWNER's DSN, not the application's. The app role is ` +
    `row-level-security bound and owns no table, so truncating and seeding under it fails with ` +
    `a permission error that never says which credential was missing. Inside a deployed ` +
    `container DATABASE_URL is the app's: re-run with DATABASE_URL set to the owner (the ` +
    `postgres superuser, or the role the migrations run as).`
  )
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One namespace for every transaction-scoped advisory lock the kernel takes.
//
// `pg_advisory_xact_lock` has a single 64-bit key space shared by the whole
// database, so two call sites that derive their keys differently -- one with a
// hash computed here, one with Postgres's `hashtext` -- are two namespaces
// overlaid on one space: nobody can tell whether two locks collide, and the
// collision (a lock taken for an unrelated reason) shows up only as latency
// nobody can explain. Every key comes from this helper, and every key is
// PREFIXED with what it locks, so distinct purposes stay distinct.

import { sql as drizzleSql } from "drizzle-orm"
import { PgTransaction } from "drizzle-orm/pg-core"

/**
 * The lock key for `input`: a rolling 32-bit-style hash widened to bigint and
 * masked to 63 bits, so it always fits Postgres's signed `bigint` argument.
 */
export function advisoryLockKey(input: string): bigint {
  let hash = 0n
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5n) - hash + BigInt(input.charCodeAt(i))) & 0x7fffffffffffffffn
  }
  return hash
}

/**
 * Refuses a handle that is not an open transaction.
 *
 * A transaction-scoped advisory lock taken outside a transaction block is
 * acquired and released within the same statement, so the read-then-create it
 * is meant to serialize runs completely unserialized while every line of the
 * code still says otherwise. That is worse than no lock at all, and it is
 * invisible: nothing errors.
 */
export function assertTransactionScoped(db: unknown, what: string): void {
  if (!(db instanceof PgTransaction)) {
    throw new Error(`${what} must run inside an open transaction: its advisory lock is xact scoped`)
  }
}

/** `SELECT pg_advisory_xact_lock(...)` for `name`, in the shared namespace. */
export function advisoryXactLock(name: string) {
  return drizzleSql`SELECT pg_advisory_xact_lock(${advisoryLockKey(name)})`
}

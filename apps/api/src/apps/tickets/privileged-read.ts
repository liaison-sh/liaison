// SPDX-License-Identifier: FSL-1.1-ALv2
import type { PrivilegedDb } from "~/db"

/**
 * Where a tickets helper runs its privileged reads (the org's SLA settings, the
 * category and assignee checks, the default inbox, the ID segment).
 *
 * Absent, each read opens a privileged transaction of its own, which is right
 * for a caller holding an RLS transaction. A caller that already holds a
 * PRIVILEGED transaction passes it, and every read runs on it. It must: its
 * transaction may already hold locks (a ticket it inserted holds a key-share
 * lock on its category), and a read on a second connection that queues behind
 * a lock request needing those (an app registration's policy DDL) waits for a
 * transaction that is itself waiting for the read. Neither Postgres nor the
 * pool can see that cycle, so it never ends.
 */
export interface PrivilegedReadOptions {
  privilegedTx?: PrivilegedDb
}

export async function onPrivilegedDb<T>(
  orgId: string,
  reason: string,
  privilegedTx: PrivilegedDb | undefined,
  fn: (tx: PrivilegedDb) => Promise<T>,
): Promise<T> {
  if (privilegedTx) return fn(privilegedTx)
  // Imported here: the state machine reaches this module, and a static import
  // of the privileged pool from it closes an import cycle.
  const { withPrivilegedDb } = await import("~/db/privileged")
  return withPrivilegedDb(orgId, reason, fn)
}

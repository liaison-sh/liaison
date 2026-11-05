// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AppEvent } from "~/infra/events/event-bus"

// Re-export sql for shutdown/migrations — NOT db or _privilegedDb
export { sql } from "./connection"

declare const RLS_BRAND: unique symbol

/** Base Drizzle transaction type (before branding). */
type BaseTx = Parameters<
  Parameters<typeof import("./connection").__privileged_db__.transaction>[0]
>[0]

/** Inner transaction produced by RlsClient.transaction() or RlsTx.transaction().
 *  Carries queueEvent so events are always tied to their transaction scope.
 *  Uses Omit to replace the base transaction() signature with our typed version. */
export type RlsTx = Omit<BaseTx, "transaction"> & {
  /** Queue a durable event into the transactional outbox (pending_events table).
   *  Runs inside the current transaction — rolls back with it. */
  queueEvent: (event: AppEvent) => Promise<void>
  /** Queue several events in one outbox insert, same transaction, same checks. */
  queueEvents: (events: AppEvent[]) => Promise<void>
  /** Nested savepoint — inner tx also carries queueEvent. */
  transaction: <T>(fn: (tx: RlsTx) => Promise<T>) => Promise<T>
}

/** Branded DB client that can only be produced by withRlsContext/withRequestRls.
 *  Services MUST accept RlsClient, not DbClient, to enforce RLS at compile time.
 *  Use withPrivilegedDb/withSystemDb for the rare cases that legitimately bypass RLS. */
export type RlsClient = Omit<BaseTx, "transaction"> & {
  readonly [RLS_BRAND]: true
  __rlsBrand: true
  /** Queue a durable event into the transactional outbox (pending_events table).
   *  The outbox worker publishes these after the transaction commits. */
  queueEvent: (event: AppEvent) => Promise<void>
  /** Queue several events in one outbox insert, same transaction, same checks. */
  queueEvents: (events: AppEvent[]) => Promise<void>
  /** Savepoint transaction — inner tx carries queueEvent. */
  transaction: <T>(fn: (tx: RlsTx) => Promise<T>) => Promise<T>
}

/** Transaction handle from withPrivilegedDb/withSystemDb — may bypass RLS. */
export type PrivilegedDb = Omit<BaseTx, "transaction"> & {
  /** Queue a durable event into the transactional outbox (pending_events table).
   *  The outbox worker publishes these after the transaction commits. */
  queueEvent: (event: AppEvent) => Promise<void>
  /** Queue several events in one outbox insert, same transaction, same checks. */
  queueEvents: (events: AppEvent[]) => Promise<void>
  /** Savepoint transaction — inner tx carries queueEvent. */
  transaction: <T>(fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
}

/** Extract rows from db.execute() result — isolates the `as any` cast in one place. */
export function extractRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result
  return ((result as any)?.rows as T[]) ?? []
}

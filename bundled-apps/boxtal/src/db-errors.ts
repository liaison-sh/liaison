// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recoverable database-write races, in ONE place.
//
// Every table this app upserts into by a natural key (`app_config(key)`,
// `prep_order_state(order_key)`, `prep_draft_cache(document_ref)`) is written
// read-then-insert through the generic db bridge, which has no upsert. Two
// writers that both see no row both INSERT, and the loser gets a postgres
// unique violation (23505). That is a race to converge on, not a failure to
// report: the operator's click must not fail because the 5 s poll wrote first.
//
// The predicate lived in three copies (draft-store.ts, prep.ts, and nowhere at
// all in order-state.ts / draft-cache.ts, which is why those two surfaced the
// raw pg error as a row error). One copy now.

/** A postgres unique-constraint (23505) violation, surfaced by the sandbox db bridge as an Error
 *  whose message carries the pg code/constraint (`... - pg: duplicate key value violates unique
 *  constraint "prep_order_state_org_id_order_key_key" (23505)`). Matched on the stable 23505 code
 *  or the duplicate-key text. */
export function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b23505\b/.test(msg) || /duplicate key value violates unique constraint/i.test(msg)
}

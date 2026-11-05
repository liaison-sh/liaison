// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 K3 — gapless app sequence allocator.
//
// Runs INSIDE the calling tool-handler's ambient transaction. Acquires
// `pg_advisory_xact_lock(hashtextextended(key, 0))` so two concurrent
// allocations on the same key serialize; UPSERTs `(org_id, app_id, key) →
// value+1` and returns the new value. Because the lock and the UPDATE run
// in the same transaction, a rolled-back tx releases its lock AND does not
// consume a value — that's what makes the allocator gapless.

import { sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"

export class SequenceAllocationError extends Error {
  readonly code: "forbidden"
  constructor(code: "forbidden", message: string) {
    super(message)
    this.code = code
    this.name = "SequenceAllocationError"
  }
}

export interface AllocateSequenceInput {
  orgId: string
  callingAppId: string
  /** Must start with `${callingAppId}:` — namespace enforcement. */
  key: string
}

export interface AllocateSequenceResult {
  value: number
}

export async function allocateSequence(
  db: RlsClient,
  p: AllocateSequenceInput,
): Promise<AllocateSequenceResult> {
  if (!p.key.startsWith(`${p.callingAppId}:`)) {
    throw new SequenceAllocationError("forbidden", `key must start with "${p.callingAppId}:"`)
  }

  // Scope the advisory lock to the org so that two different orgs allocating
  // the same logical key (e.g. "invoicing:invoice") do not contend with each other.
  const lockKey = `${p.orgId}:${p.key}`
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)

  // Schema-prefix aware: in worker-isolated E2E the kernel schema is cloned to
  // `${SCHEMA_PREFIX}kernel`; in prod/unit `schemaRef` is a no-op. Hard-coding
  // `kernel.` would target the un-prefixed base schema (which the worker role
  // cannot write), so we qualify through `schemaRef`.
  const seqTable = sql.raw(`${schemaRef("kernel")}.app_sequences`)
  const result = (await db.execute(sql`
    INSERT INTO ${seqTable} (org_id, app_id, key, value, updated_at)
    VALUES (${p.orgId}::uuid, ${p.callingAppId}, ${p.key}, 1, now())
    ON CONFLICT (org_id, app_id, key) DO UPDATE
      SET value = ${seqTable}.value + 1,
          updated_at = now()
    RETURNING value
  `)) as unknown as Array<{ value: number | string }> | { rows: Array<{ value: number | string }> }

  const rows = Array.isArray(result)
    ? result
    : ((result as { rows: Array<{ value: number | string }> }).rows ?? [])
  const row = rows[0]
  if (!row) {
    throw new Error("allocateSequence: empty result from UPSERT")
  }
  return { value: Number(row.value) }
}

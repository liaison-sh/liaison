// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ctx.db.batch(spec)`: several writes to the app's own tables that commit
 * together or not at all, in ONE bridge call.
 *
 * No sandboxed run holds a transaction across its run (run-wide-tx.ts): each
 * bridge call commits on its own. Writes that must land as one (a numbered
 * legal document with its lines, a line set replaced with the totals it adds
 * up to) go through this call instead. It runs in a savepoint of the call's
 * transaction, so a failing op undoes every op before it.
 *
 * With `sequence`, the batch also allocates the next value of one of the app's
 * sequences (modules/sequences/allocate.ts) inside that same savepoint: the
 * value is consumed only when every op committed, so a failed batch leaves no
 * gap, and two batches on the same key serialize on the allocator's lock, so
 * no value is handed out twice. `sequence.unique` names the column that
 * already holds values written another way (an import, a seed): the allocator
 * steps past every value a row matching `where` already holds.
 *
 * Ops reference the batch's own results through placeholder values, anywhere
 * in an op's `data` (nested objects and arrays included) or as an op's `id`:
 *   `{ "$seq": "value" }`      the allocated integer
 *   `{ "$seq": "formatted" }`  `format.prefix` + the value zero-padded to `format.pad`
 *   `{ "$ref": "<as>" }`       the id of the row an earlier insert named `as`
 *
 * An `update` may also `append` items to json array fields and `merge` keys into
 * json object fields of the row AS IT IS when the batch commits (`field || value`,
 * in the database): a log entry or a key added this way is never lost to a
 * writer that changed the row between the app's read and this write.
 *
 * Every op goes through the same checks as its single-call twin (`ctx.db.insert`,
 * `update`, `delete`, `updateMany`): the app's own declared tables and fields,
 * the bridge's org, the run's RLS actor, refused on a read-only run.
 */
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withReleasedSavepoint } from "~/db/savepoint"
import { quoteIdent } from "~/lib/sql-utils"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { snakeCase, withPgCause } from "~/modules/apps/sandbox/bridge/shared"

/** The most ops one batch may carry. */
export const MAX_BATCH_OPS = 500
/** How far past the sequence the allocator walks over values rows already hold. */
export const MAX_SEQUENCE_SKIPS = 10_000

type Row = Record<string, unknown>

export type BatchOp =
  | { insert: string; data: Row; as?: string }
  | {
      update: string
      id: unknown
      data?: Row
      append?: Record<string, unknown[]>
      merge?: Record<string, Row>
    }
  | { delete: string; id: unknown }
  | { updateMany: string; where: Row; data: Row }

export interface BatchSequence {
  key: string
  format?: { prefix: string; pad?: number }
  unique?: { entity: string; field: string; where?: Row }
}

export interface BatchSpec {
  sequence?: BatchSequence
  ops: BatchOp[]
}

export interface BatchResult {
  sequence?: { value: number; formatted?: string }
  /** The inserted rows an op named with `as`, by that name. */
  rows: Record<string, Row>
}

export class BatchSpecError extends Error {
  readonly code = "invalid_batch"
  constructor(message: string) {
    super(`ctx.db.batch: ${message}`)
    this.name = "BatchSpecError"
  }
}

function isObject(v: unknown): v is Row {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function parseSpec(raw: unknown): BatchSpec {
  const spec = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
  if (!isObject(spec) || !Array.isArray(spec.ops)) {
    throw new BatchSpecError("expects { ops: [...] }")
  }
  if (spec.ops.length === 0) throw new BatchSpecError("ops is empty")
  if (spec.ops.length > MAX_BATCH_OPS) {
    throw new BatchSpecError(`at most ${MAX_BATCH_OPS} ops per batch`)
  }
  const seq = spec.sequence
  if (seq !== undefined) {
    if (!isObject(seq) || typeof seq.key !== "string" || seq.key.length === 0) {
      throw new BatchSpecError("sequence.key is required")
    }
    if (seq.format !== undefined) {
      const f = seq.format
      if (
        !isObject(f) ||
        typeof f.prefix !== "string" ||
        (f.pad !== undefined && (typeof f.pad !== "number" || f.pad < 0 || f.pad > 20))
      ) {
        throw new BatchSpecError("sequence.format is { prefix: string, pad?: 0..20 }")
      }
    }
    if (seq.unique !== undefined) {
      const u = seq.unique
      if (
        !isObject(u) ||
        typeof u.entity !== "string" ||
        typeof u.field !== "string" ||
        (u.where !== undefined && !isObject(u.where))
      ) {
        throw new BatchSpecError("sequence.unique is { entity, field, where? }")
      }
    }
  }
  return spec as unknown as BatchSpec
}

export function createBatchMethods(
  ctx: BridgeContext,
  dbMethodsOn: (txDb: RlsClient) => Record<string, any>,
): { db_batch: (specJson: string) => Promise<string> } {
  return {
    db_batch: async (specJson: string): Promise<string> => {
      const spec = parseSpec(specJson)
      // Refused before anything runs: a read-only run writes nothing, whichever op it is.
      for (const op of spec.ops as unknown[]) {
        const entity = isObject(op) ? (op.insert ?? op.update ?? op.delete ?? op.updateMany) : null
        if (typeof entity === "string") {
          ctx.refuseWriteOnReadOnlyRun(ctx.writeTarget(entity), "ctx.db.batch")
        }
      }
      if (spec.sequence) ctx.requireCapability("sequences.allocate")
      const result = await withReleasedSavepoint(ctx.txDb, async (sp) => {
        const tx = sp as unknown as RlsClient
        const db = dbMethodsOn(tx)
        const out: BatchResult = { rows: {} }
        let seqValue: number | null = null
        let seqFormatted: string | undefined
        if (spec.sequence) {
          seqValue = await allocate(ctx, tx, db, spec.sequence)
          const f = spec.sequence.format
          if (f) seqFormatted = f.prefix + String(seqValue).padStart(f.pad ?? 0, "0")
          out.sequence = {
            value: seqValue,
            ...(seqFormatted !== undefined ? { formatted: seqFormatted } : {}),
          }
        }
        const resolve = (v: unknown, where: string): unknown => {
          if (Array.isArray(v)) return v.map((x) => resolve(x, where))
          if (!isObject(v)) return v
          const keys = Object.keys(v)
          if (keys.length === 1 && keys[0] === "$seq") {
            if (seqValue === null) throw new BatchSpecError(`${where}: $seq without a sequence`)
            if (v.$seq === "value") return seqValue
            if (v.$seq === "formatted") {
              if (seqFormatted === undefined) {
                throw new BatchSpecError(`${where}: $seq "formatted" needs sequence.format`)
              }
              return seqFormatted
            }
            throw new BatchSpecError(`${where}: $seq is "value" or "formatted"`)
          }
          if (keys.length === 1 && keys[0] === "$ref") {
            const row = typeof v.$ref === "string" ? out.rows[v.$ref] : undefined
            if (!row) throw new BatchSpecError(`${where}: $ref names no earlier insert`)
            return row.id
          }
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, where)]))
        }
        const idOf = (v: unknown, where: string): string => {
          const id = resolve(v, where)
          if (typeof id !== "string" || id.length === 0) {
            throw new BatchSpecError(`${where}: id must be a string or a $ref`)
          }
          return id
        }
        // Ops are checked field by field below (the spec is the guest's JSON).
        for (const [i, op] of (spec.ops as unknown[]).entries()) {
          const where = `ops[${i}]`
          if (!isObject(op)) throw new BatchSpecError(`${where} is not an object`)
          if (typeof op.insert === "string") {
            if (!isObject(op.data)) throw new BatchSpecError(`${where}.data is required`)
            const row = JSON.parse(
              await db.db_insert(op.insert, JSON.stringify(resolve(op.data, where))),
            ) as Row
            if (op.as !== undefined) {
              if (typeof op.as !== "string" || op.as in out.rows) {
                throw new BatchSpecError(`${where}.as must be a new name`)
              }
              out.rows[op.as] = row
            }
          } else if (typeof op.update === "string") {
            const append = op.append === undefined ? {} : op.append
            const merge = op.merge === undefined ? {} : op.merge
            if (
              (op.data !== undefined && !isObject(op.data)) ||
              !isObject(append) ||
              !isObject(merge) ||
              Object.values(append).some((v) => !Array.isArray(v)) ||
              Object.values(merge).some((v) => !isObject(v))
            ) {
              throw new BatchSpecError(`${where}: data and merge take objects, append takes arrays`)
            }
            const id = idOf(op.id, where)
            const data = isObject(op.data) ? op.data : {}
            const changes =
              Object.keys(data).length + Object.keys(append).length + Object.keys(merge).length
            if (changes === 0) throw new BatchSpecError(`${where} changes nothing`)
            if (Object.keys(data).length > 0) {
              await db.db_update(op.update, id, JSON.stringify(resolve(data, where)))
            }
            await appendAndMerge(ctx, tx, op.update, id, {
              append: resolve(append, where) as Record<string, unknown[]>,
              merge: resolve(merge, where) as Record<string, Row>,
            })
          } else if (typeof op.delete === "string") {
            await db.db_delete(op.delete, idOf(op.id, where))
          } else if (typeof op.updateMany === "string") {
            if (!isObject(op.data) || !isObject(op.where)) {
              throw new BatchSpecError(`${where} needs where and data`)
            }
            await db.db_updateMany(
              op.updateMany,
              JSON.stringify({ where: resolve(op.where, where), data: resolve(op.data, where) }),
            )
          } else {
            throw new BatchSpecError(`${where} is none of insert, update, delete, updateMany`)
          }
        }
        return out
      })
      return JSON.stringify(result)
    },
  }
}

async function allocate(
  ctx: BridgeContext,
  tx: RlsClient,
  db: Record<string, any>,
  seq: BatchSequence,
): Promise<number> {
  const { allocateSequence } = await import("~/modules/sequences/allocate")
  const next = async () =>
    (await allocateSequence(tx, { orgId: ctx.orgId, callingAppId: ctx.appName, key: seq.key }))
      .value
  let value = await next()
  const unique = seq.unique
  if (!unique) return value
  // A value a row already holds is consumed, never reissued: each step allocates (and so counts)
  // it, so the sequence ends past every such row and the next batch costs one allocation.
  const taken = async (v: number) =>
    Number(
      await db.db_count(
        unique.entity,
        JSON.stringify({ where: { ...(unique.where ?? {}), [unique.field]: v } }),
      ),
    ) > 0
  let skips = 0
  while (await taken(value)) {
    if (++skips > MAX_SEQUENCE_SKIPS) {
      throw new BatchSpecError(
        `sequence "${seq.key}" is more than ${MAX_SEQUENCE_SKIPS} values behind the rows already written`,
      )
    }
    value = await next()
  }
  return value
}

/** `field = field || value` for json fields, on the row as it is now (see the header). */
async function appendAndMerge(
  ctx: BridgeContext,
  tx: RlsClient,
  entity: string,
  id: string,
  ops: { append: Record<string, unknown[]>; merge: Record<string, Row> },
): Promise<void> {
  const sets = [
    ...Object.entries(ops.append).map(([field, value]) => ({ field, value, empty: "[]" })),
    ...Object.entries(ops.merge).map(([field, value]) => ({ field, value, empty: "{}" })),
  ]
  if (sets.length === 0) return
  // Declared fields only, as every write checks.
  ctx.validateFields(entity, Object.fromEntries(sets.map((x) => [x.field, x.value])))
  const table = drizzleSql.raw(`${quoteIdent(ctx.schemaName)}.${quoteIdent(entity)}`)
  const setChunk = drizzleSql.join(
    sets.map((x) => {
      const col = drizzleSql.raw(quoteIdent(snakeCase(x.field)))
      return drizzleSql`${col} = COALESCE(${col}, ${x.empty}::jsonb) || ${JSON.stringify(x.value)}::jsonb`
    }),
    drizzleSql.raw(", "),
  )
  try {
    await tx.execute(
      drizzleSql`UPDATE ${table} SET ${setChunk}, updated_at = now() WHERE id = ${id} AND org_id = ${ctx.orgId}`,
    )
  } catch (err) {
    throw withPgCause(err, "ctx.db.batch append/merge failed")
  }
}

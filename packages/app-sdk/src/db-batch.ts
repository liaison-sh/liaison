// SPDX-License-Identifier: FSL-1.1-ALv2

/** Which op of a `ctx.db.batch` broke its `expect` guard, and how many rows it matched. */
export interface DbBatchPreconditionFailure {
  /** The op's index in `spec.ops`. */
  op: number
  kind: "update" | "delete" | "updateMany"
  entity: string
  matched: number
}

const PRECONDITION =
  /precondition_failed at ops\[(\d+)\] \((update|delete|updateMany) ([^)]+)\): .*, matched (\d+)$/

/**
 * The guard failure a `ctx.db.batch` rejected with, or null for any other error.
 * The batch committed nothing (see `DbClient.batch`), so the handler may re-read and decide:
 *
 *   try { await ctx.db.batch(spec) } catch (err) {
 *     const failed = batchPreconditionFailure(err)
 *     if (!failed) throw err
 *     // failed.op is the index of the guarded op that matched failed.matched rows
 *   }
 */
export function batchPreconditionFailure(err: unknown): DbBatchPreconditionFailure | null {
  const e = err as { code?: unknown; message?: unknown } | null | undefined
  if (e === null || typeof e !== "object" || e.code !== "precondition_failed") return null
  const m = PRECONDITION.exec(String(e.message))
  if (!m) return null
  return {
    op: Number(m[1]),
    kind: m[2] as DbBatchPreconditionFailure["kind"],
    entity: m[3] as string,
    matched: Number(m[4]),
  }
}

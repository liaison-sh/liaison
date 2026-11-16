// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tests only: an in-memory double of the app's db client (findMany, findOne,
// insert, update, updateMany, count, batch with its sequence and refs).

import type { DbBatchOp, DbBatchSpec, DbClient } from "@liaison/app-sdk"

export type Row = Record<string, unknown> & { id: string }

export function memoryDb(): DbClient & { tables: Map<string, Row[]> } {
  const tables = new Map<string, Row[]>()
  const t = (e: string) => {
    if (!tables.has(e)) tables.set(e, [])
    return tables.get(e) as Row[]
  }
  const matches = (r: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => r[k] === v)
  const seq = new Map<string, number>()
  const resolve = (
    v: unknown,
    refs: Record<string, Row>,
    s: { value: number; formatted?: string } | undefined,
  ): unknown => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      if (typeof o.$ref === "string") return refs[o.$ref]?.id
      if (o.$seq === "formatted") return s?.formatted
      if (o.$seq === "value") return s?.value
    }
    return v
  }
  const db = {
    tables,
    async findMany(entity: string, opts?: { where?: Record<string, unknown>; limit?: number }) {
      return t(entity)
        .filter((r) => matches(r, opts?.where))
        .map((r) => ({ ...r }))
    },
    async findOne(entity: string, id: string) {
      return t(entity).find((r) => r.id === id) ?? null
    },
    async insert(entity: string, data: Record<string, unknown>) {
      const id = crypto.randomUUID()
      t(entity).push({ ...data, id })
      return { id }
    },
    async update(entity: string, id: string, data: Record<string, unknown>) {
      const r = t(entity).find((x) => x.id === id)
      if (r) Object.assign(r, data)
    },
    async updateMany(
      entity: string,
      opts: { where: Record<string, unknown>; data: Record<string, unknown> },
    ) {
      const rows = t(entity).filter((r) => matches(r, opts.where))
      for (const r of rows) Object.assign(r, opts.data)
      return { count: rows.length }
    },
    async delete() {
      throw new Error("rows of this app are never removed")
    },
    async count(entity: string, opts?: { where?: Record<string, unknown> }) {
      return t(entity).filter((r) => matches(r, opts?.where)).length
    },
    async batch(spec: DbBatchSpec) {
      let s: { value: number; formatted?: string } | undefined
      if (spec.sequence) {
        const n = (seq.get(spec.sequence.key) ?? 0) + 1
        seq.set(spec.sequence.key, n)
        const f = spec.sequence.format
        s = {
          value: n,
          formatted: f ? `${f.prefix}${String(n).padStart(f.pad ?? 0, "0")}` : undefined,
        }
      }
      const snapshot = new Map([...tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
      const refs: Record<string, Row> = {}
      try {
        for (const op of spec.ops as DbBatchOp[]) {
          if ("insert" in op) {
            const data = Object.fromEntries(
              Object.entries(op.data).map(([k, v]) => [k, resolve(v, refs, s)]),
            )
            const row = { ...data, id: crypto.randomUUID() } as Row
            t(op.insert).push(row)
            if (op.as) refs[op.as] = row
          } else if ("updateMany" in op) {
            const rows = t(op.updateMany).filter((r) => matches(r, op.where))
            if (op.expect?.minRows !== undefined && rows.length < op.expect.minRows)
              throw Object.assign(
                new Error(
                  `ctx.db.batch: precondition_failed at ops[0] (updateMany ${op.updateMany}): expected at least 1 row, matched ${rows.length}`,
                ),
                { code: "precondition_failed" },
              )
            for (const r of rows) Object.assign(r, op.data)
          } else if ("update" in op) {
            const id = resolve(op.id, refs, s) as string
            const r = t(op.update).find((x) => x.id === id)
            if (r && op.data)
              Object.assign(
                r,
                Object.fromEntries(
                  Object.entries(op.data).map(([k, v]) => [k, resolve(v, refs, s)]),
                ),
              )
          }
        }
      } catch (err) {
        tables.clear()
        for (const [k, v] of snapshot) tables.set(k, v)
        throw err
      }
      return { sequence: s, rows: refs }
    },
  }
  return db as unknown as DbClient & { tables: Map<string, Row[]> }
}

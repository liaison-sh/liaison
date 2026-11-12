// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @liaison/test-helpers/mock-db: the in-memory DB mock bundled-app unit tests
// run handlers against. Mirrors the sandbox bridge's generic-CRUD shape so
// tests exercise the same surface production code calls (semantic mocks were
// the source of post-implement gaps).
//
// Supports the subset of the bridge's `findMany` opts apps use:
//   - `where` (field equality; `{ in }` and IS NULL with bridgeWhereOperators)
//   - `orderBy` (single or multiple, asc/desc)
//   - `limit` / `offset`
//   - `search` ({fields, query}): case-insensitive substring on declared fields
//
// Values are stored as-is (no snake/camel conversion): production code passes
// snake_case keys to match the manifest schema.
//
// Per-app bridge fidelity is opt-in through `MockDbBehavior`, so each app keeps
// exactly the mock semantics its suite was written against.

export interface MockDbOptions {
  /** Seed rows per entity. Keys are entity names; arrays are rows. */
  seed?: Record<string, Array<Record<string, unknown>>>
}

/** A manifest `schema` block: entity name -> declared fields. */
export type ManifestSchema = Record<string, { fields: Record<string, unknown> }>

export interface MockDbBehavior {
  /**
   * "prefixed" (default): generated ids are `<entity>_<n>`. "uuid": ids are
   * uuid-SHAPED like prod's gen_random_uuid(), still counter-based so they stay
   * deterministic within a test.
   */
  ids?: "prefixed" | "uuid"
  /**
   * Stamp `created_at` on insert when the caller omits it, like the kernel's
   * DB-side DEFAULT NOW() base column.
   */
  stampCreatedAt?: boolean
  /** Apply `search` in `count` as well as in `findMany`. */
  countHonorsSearch?: boolean
  /**
   * Reject an `orderBy` key that is neither a kernel base column
   * (id/createdAt/updatedAt, camelCase) nor a field this manifest schema
   * declares for the entity, as the bridge's db_findMany does. Entities absent
   * from the schema (internal mock tables) are not checked.
   */
  orderByManifestSchema?: ManifestSchema
  /**
   * Honour the bridge's `where` semantics beyond plain equality: `{ in: [...] }`
   * is a set lookup (an empty set matches nothing), and a `null` value matches a
   * NULL or absent column (the bridge emits `IS NULL`). An `orderBy` on a kernel
   * base column given in camelCase (`createdAt`) reads the snake_case row key
   * (`created_at`) the bridge actually sorts on.
   */
  bridgeWhereOperators?: boolean
}

/**
 * The bridge refuses `where.id` on its bulk calls (`db_updateMany`, `db_count`:
 * `validateWhereFields(..., rejectProtected = true)` in the sandbox bridge), so
 * a handler that addresses one row that way throws on every prod run. Refused
 * here too, so the mock cannot pass what the bridge fails: invoicing's
 * link-shipments row lock did exactly that and never ran in prod.
 */
function assertNoWhereId(call: string, where: Record<string, unknown> | undefined): void {
  if (where && Object.hasOwn(where, "id")) {
    throw new Error(
      `${call}: where.id is not allowed here (the bridge refuses it; use update/findOne by id)`,
    )
  }
}

export interface MockDb {
  // Generic-CRUD bridge surface
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
      search?: { fields: string[]; query: string }
    },
  ): Promise<unknown[]>
  findOne(entity: string, id: string): Promise<unknown | null>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  /** The bridge's commit-now writes. A mock has no transaction, so they are `insert` / `update`. */
  insertNow(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  updateNow(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<{ count: number }>
  delete(entity: string, id: string): Promise<void>
  count(
    entity: string,
    opts?: { where?: Record<string, unknown>; search?: { fields: string[]; query: string } },
  ): Promise<number>
  /** The bridge's `ctx.db.batch`, in memory (`applyMockBatch`); sequences live in `__sequences`. */
  batch(spec: MockBatchSpec): Promise<MockBatchResult>

  // Inspection helpers
  /** The mock's sequences (key -> last value handed out), as `ctx.db.batch` allocates them. */
  __sequences: Map<string, number>
  __all(entity: string): Array<Record<string, unknown>>
  __seed(entity: string, rows: Array<Record<string, unknown>>): void
  __reset(): void
}

// -- ctx.db.batch, in memory ----------------------------------------------------

/** The bridge's `ctx.db.batch` spec (apps/api sandbox/bridge/batch.ts). */
export interface MockBatchSpec {
  sequence?: {
    key: string
    format?: { prefix: string; pad?: number }
    unique?: { entity: string; field: string; where?: Record<string, unknown> }
  }
  ops: Array<Record<string, unknown>>
}

export interface MockBatchResult {
  sequence?: { value: number; formatted?: string }
  rows: Record<string, Record<string, unknown> & { id: string }>
}

/** The writes and the sequence a batch runs on, plus a snapshot to undo them. */
export interface MockBatchTarget {
  findOne(entity: string, id: string): Promise<unknown | null>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  delete(entity: string, id: string): Promise<void>
  updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<{ count: number }>
  count(entity: string, opts?: { where?: Record<string, unknown> }): Promise<number>
  allocate(key: string): Promise<number>
  snapshot(): () => void
}

/**
 * The bridge's batch semantics on any in-memory target: ops in order, the
 * sequence allocated first (stepping past `unique` values already held), the
 * `$seq` / `$ref` placeholders resolved, and every write undone when one op
 * throws (the bridge's savepoint), the sequence included.
 */
export async function applyMockBatch(
  target: MockBatchTarget,
  spec: MockBatchSpec,
): Promise<MockBatchResult> {
  if (!spec || !Array.isArray(spec.ops) || spec.ops.length === 0) {
    throw new Error("ctx.db.batch: expects { ops: [...] } with at least one op")
  }
  const undo = target.snapshot()
  try {
    const out: MockBatchResult = { rows: {} }
    let value: number | null = null
    let formatted: string | undefined
    if (spec.sequence) {
      const seq = spec.sequence
      value = await target.allocate(seq.key)
      if (seq.unique) {
        const u = seq.unique
        while (
          (await target.count(u.entity, { where: { ...(u.where ?? {}), [u.field]: value } })) > 0
        ) {
          value = await target.allocate(seq.key)
        }
      }
      if (seq.format)
        formatted = seq.format.prefix + String(value).padStart(seq.format.pad ?? 0, "0")
      out.sequence = { value, ...(formatted !== undefined ? { formatted } : {}) }
    }
    const resolve = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(resolve)
      if (v === null || typeof v !== "object") return v
      const o = v as Record<string, unknown>
      const keys = Object.keys(o)
      if (keys.length === 1 && keys[0] === "$seq") {
        if (value === null) throw new Error("ctx.db.batch: $seq without a sequence")
        if (o.$seq === "formatted") {
          if (formatted === undefined) throw new Error("ctx.db.batch: $seq formatted needs format")
          return formatted
        }
        return value
      }
      if (keys.length === 1 && keys[0] === "$ref") {
        const row = out.rows[String(o.$ref)]
        if (!row) throw new Error(`ctx.db.batch: $ref ${String(o.$ref)} names no earlier insert`)
        return row.id
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]))
    }
    for (const op of spec.ops) {
      if (typeof op.insert === "string") {
        const row = (await target.insert(
          op.insert,
          resolve(op.data) as Record<string, unknown>,
        )) as Record<string, unknown> & { id: string }
        if (typeof op.as === "string") out.rows[op.as] = row
      } else if (typeof op.update === "string") {
        const id = String(resolve(op.id))
        const patch = { ...((resolve(op.data) as Record<string, unknown> | undefined) ?? {}) }
        const append = (resolve(op.append) as Record<string, unknown[]> | undefined) ?? {}
        const merge =
          (resolve(op.merge) as Record<string, Record<string, unknown>> | undefined) ?? {}
        if (Object.keys(append).length + Object.keys(merge).length > 0) {
          const row = ((await target.findOne(op.update, id)) ?? {}) as Record<string, unknown>
          const base = { ...row, ...patch }
          for (const [k, items] of Object.entries(append)) {
            patch[k] = [...((base[k] as unknown[] | null | undefined) ?? []), ...items]
          }
          for (const [k, keys] of Object.entries(merge)) {
            patch[k] = {
              ...((base[k] as Record<string, unknown> | null | undefined) ?? {}),
              ...keys,
            }
          }
        }
        await target.update(op.update, id, patch)
      } else if (typeof op.delete === "string") {
        await target.delete(op.delete, String(resolve(op.id)))
      } else if (typeof op.updateMany === "string") {
        await target.updateMany(op.updateMany, {
          where: resolve(op.where) as Record<string, unknown>,
          data: resolve(op.data) as Record<string, unknown>,
        })
      } else {
        throw new Error("ctx.db.batch: an op is none of insert, update, delete, updateMany")
      }
    }
    return out
  } catch (err) {
    undo()
    throw err
  }
}

const BASE_ENTITY_FIELDS = new Set(["id", "createdAt", "updatedAt"])

function assertOrderByDeclared(
  schema: ManifestSchema,
  entity: string,
  orderBy: Record<string, "asc" | "desc"> | undefined,
): void {
  if (!orderBy) return
  const declared = schema[entity]?.fields
  if (!declared) return
  for (const k of Object.keys(orderBy)) {
    if (!BASE_ENTITY_FIELDS.has(k) && !(k in declared)) {
      throw new Error(
        `Unknown orderBy field "${k}" on entity "${entity}". Declared fields: ${Object.keys(declared).join(", ")}`,
      )
    }
  }
}

let nextIdCounter = 1

function matchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown> | undefined,
  bridgeOperators = false,
): boolean {
  if (!where) return true
  for (const [key, val] of Object.entries(where)) {
    if (bridgeOperators) {
      if (val === null) {
        if (row[key] != null) return false
        continue
      }
      if (
        typeof val === "object" &&
        !Array.isArray(val) &&
        Object.keys(val).length === 1 &&
        "in" in val
      ) {
        const list = (val as { in: unknown[] }).in
        if (!list.includes(row[key])) return false
        continue
      }
    }
    if (row[key] !== val) return false
  }
  return true
}

function snakeCaseKey(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

function matchesSearch(
  row: Record<string, unknown>,
  search: { fields: string[]; query: string } | undefined,
): boolean {
  if (!search) return true
  const q = search.query.toLowerCase()
  return search.fields.some((f) => {
    const v = row[f]
    return typeof v === "string" && v.toLowerCase().includes(q)
  })
}

function compareForOrder(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  orderBy: Record<string, "asc" | "desc"> | undefined,
  snakeFallback = false,
): number {
  if (!orderBy) return 0
  for (const [key, dir] of Object.entries(orderBy)) {
    const alt = snakeFallback ? snakeCaseKey(key) : key
    const av = a[key] ?? a[alt]
    const bv = b[key] ?? b[alt]
    if (av == null && bv == null) continue
    if (av == null) return dir === "asc" ? -1 : 1
    if (bv == null) return dir === "asc" ? 1 : -1
    if ((av as number) < (bv as number)) return dir === "asc" ? -1 : 1
    if ((av as number) > (bv as number)) return dir === "asc" ? 1 : -1
  }
  return 0
}

export function createMockDb(opts: MockDbOptions = {}, behavior: MockDbBehavior = {}): MockDb {
  const store = new Map<string, Map<string, Record<string, unknown>>>()
  nextIdCounter = 1

  const makeId =
    behavior.ids === "uuid"
      ? (_prefix = "row"): string =>
          `00000000-0000-4000-8000-${String(nextIdCounter++).padStart(12, "0")}`
      : (prefix = "row"): string => `${prefix}_${nextIdCounter++}`

  function tableOf(entity: string): Map<string, Record<string, unknown>> {
    let t = store.get(entity)
    if (!t) {
      t = new Map()
      store.set(entity, t)
    }
    return t
  }

  function seed(entity: string, rows: Array<Record<string, unknown>>): void {
    const t = tableOf(entity)
    for (const row of rows) {
      const id = String(row.id ?? makeId(entity))
      t.set(id, { ...row, id })
    }
  }

  for (const [entity, rows] of Object.entries(opts.seed ?? {})) {
    seed(entity, rows)
  }

  const sequences = new Map<string, number>()
  const db: MockDb = {
    __sequences: sequences,
    async batch(spec) {
      return applyMockBatch(
        {
          findOne: (e, id) => db.findOne(e, id),
          insert: (e, d) => db.insert(e, d),
          update: (e, id, d) => db.update(e, id, d),
          delete: (e, id) => db.delete(e, id),
          updateMany: (e, o) => db.updateMany(e, o),
          count: (e, o) => db.count(e, o),
          allocate: async (key) => {
            const next = (sequences.get(key) ?? 0) + 1
            sequences.set(key, next)
            return next
          },
          snapshot: () => {
            const tables = new Map([...store].map(([k, t]) => [k, new Map(t)]))
            const seqs = new Map(sequences)
            const counter = nextIdCounter
            return () => {
              store.clear()
              for (const [k, t] of tables) store.set(k, t)
              sequences.clear()
              for (const [k, v] of seqs) sequences.set(k, v)
              nextIdCounter = counter
            }
          },
        },
        spec,
      )
    },
    async findMany(entity, opts) {
      const t = tableOf(entity)
      let rows = Array.from(t.values()).filter(
        (r) =>
          matchesWhere(r, opts?.where, behavior.bridgeWhereOperators) &&
          matchesSearch(r, opts?.search),
      )
      if (behavior.orderByManifestSchema) {
        assertOrderByDeclared(behavior.orderByManifestSchema, entity, opts?.orderBy)
      }
      if (opts?.orderBy) {
        rows = [...rows].sort((a, b) =>
          compareForOrder(a, b, opts.orderBy, behavior.bridgeWhereOperators),
        )
      }
      const offset = Math.max(0, Math.floor(opts?.offset ?? 0))
      const limit = Math.max(0, Math.floor(opts?.limit ?? 1000))
      return rows.slice(offset, offset + limit)
    },
    async findOne(entity, id) {
      return tableOf(entity).get(id) ?? null
    },
    async insert(entity, data) {
      const t = tableOf(entity)
      const id = String(data.id ?? makeId(entity))
      const row = behavior.stampCreatedAt
        ? { created_at: data.created_at ?? new Date().toISOString(), ...data, id }
        : { ...data, id }
      t.set(id, row)
      // Bridge returns the full inserted row (RETURNING *). We mirror that
      // shape: caller's interface narrows to `{id}` but extras don't hurt.
      return row as unknown as { id: string }
    },
    async update(entity, id, patch) {
      const t = tableOf(entity)
      const existing = t.get(id)
      if (!existing) throw new Error(`update: ${entity}#${id} not found`)
      t.set(id, { ...existing, ...patch, id })
    },
    async insertNow(entity, data) {
      return this.insert(entity, data)
    },
    async updateNow(entity, id, patch) {
      return this.update(entity, id, patch)
    },
    async updateMany(entity, opts) {
      assertNoWhereId("updateMany", opts.where)
      const t = tableOf(entity)
      let count = 0
      for (const [id, row] of t) {
        if (matchesWhere(row, opts.where, behavior.bridgeWhereOperators)) {
          t.set(id, { ...row, ...opts.data, id })
          count += 1
        }
      }
      return { count }
    },
    async delete(entity, id) {
      tableOf(entity).delete(id)
    },
    async count(entity, opts) {
      assertNoWhereId("count", opts?.where)
      const t = tableOf(entity)
      let n = 0
      for (const row of t.values()) {
        if (
          matchesWhere(row, opts?.where, behavior.bridgeWhereOperators) &&
          (!behavior.countHonorsSearch || matchesSearch(row, opts?.search))
        )
          n += 1
      }
      return n
    },
    __all(entity) {
      return Array.from(tableOf(entity).values())
    },
    __seed(entity, rows) {
      seed(entity, rows)
    },
    __reset() {
      store.clear()
      sequences.clear()
      nextIdCounter = 1
    },
  }
  return db
}

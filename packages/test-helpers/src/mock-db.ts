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
  updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<{ count: number }>
  delete(entity: string, id: string): Promise<void>
  count(
    entity: string,
    opts?: { where?: Record<string, unknown>; search?: { fields: string[]; query: string } },
  ): Promise<number>

  // Inspection helpers
  __all(entity: string): Array<Record<string, unknown>>
  __seed(entity: string, rows: Array<Record<string, unknown>>): void
  __reset(): void
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

  const db: MockDb = {
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
      nextIdCounter = 1
    },
  }
  return db
}

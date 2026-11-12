// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only AppContext double (mirrors the shopify/boxtal bundled-app test
// convention: an in-memory row store + emit/insert/update spies). Imported
// only from *.test.ts files — never bundled.
import type { AppContext } from "@liaison/app-sdk"
import { noopLogger, stubAppContext, TEST_USER_ID } from "@liaison/test-helpers/app-ctx"
import manifest from "../app.manifest.json"

export const USER = TEST_USER_ID

export type StoredRow = { id: string } & Record<string, unknown>

export interface CtxSpy {
  rows: Map<string, StoredRow[]>
  emits: Array<{
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  }>
  config: Record<string, unknown>
  failNextEmit: boolean
  /** Runs once at the start of the next emit, before `failNextEmit` is checked (simulates a
   *  concurrent delivery landing while an emit is in flight). */
  duringNextEmit?: () => Promise<void>
  /** When true (default), inserts into `incidents` enforce UNIQUE(source, dedup_key). */
  uniqueInsert: boolean
  /** Last value allocated per sequence key (absent key = never allocated). */
  sequences: Map<string, number>
  /** One-shot: the next `sequences.allocate` resolves an error envelope (it does not throw). */
  failNextAllocate: boolean
  /** One-shot: the next insert into this entity throws. */
  failNextInsert?: string
  /** One-shot: the next findOne on this entity throws. */
  failNextFindOne?: string
  /** One-shot: the next delete on this entity throws. */
  failNextDelete?: string
  /** Each hook runs once at the start of the named call, before its own work, then is cleared. */
  duringNextUpdateMany?: () => Promise<void>
  duringNextFindMany?: () => Promise<void>
  duringNextAllocate?: () => Promise<void>
  /** Every `ctx.logger.error(msg, data)` call. */
  errors: Array<{ msg: string; data?: unknown }>
  /** `ctx.store` documents, by `<collection>/<id>`. */
  store: Map<string, { data: Record<string, unknown>; version: number }>
}

function versionConflict(): Error {
  return Object.assign(new Error("version_conflict"), { code: "version_conflict", status: 409 })
}

/** `ctx.store` over `docs`, with the bridge's `ifVersion` compare-and-set (0: must not exist). */
function memoryStore(docs: CtxSpy["store"]) {
  const key = (c: string, id: string) => `${c}/${id}`
  const check = (cur: { version: number } | undefined, ifVersion?: number) => {
    if (ifVersion === undefined) return
    if ((cur?.version ?? 0) !== ifVersion) throw versionConflict()
  }
  return {
    get: async (c: string, id: string) => {
      const d = docs.get(key(c, id))
      return d ? { id, data: structuredClone(d.data), version: d.version, updatedAt: "" } : null
    },
    set: async (c: string, id: string, data: Record<string, unknown>, opts?: { ifVersion?: number }) => {
      const cur = docs.get(key(c, id))
      check(cur, opts?.ifVersion)
      const next = { data: structuredClone(data), version: (cur?.version ?? 0) + 1 }
      docs.set(key(c, id), next)
      return { id, data: structuredClone(data), version: next.version, updatedAt: "" }
    },
    delete: async (c: string, id: string, opts?: { ifVersion?: number }) => {
      const cur = docs.get(key(c, id))
      check(cur, opts?.ifVersion)
      return { deleted: docs.delete(key(c, id)) }
    },
  }
}

type Where = Record<string, unknown>

// Bridge parity: where and orderBy keys must be declared fields of the manifest table or the
// base fields (`id`, `createdAt`, `updatedAt`; the snake_case base column names are refused),
// and insert/update keys must be declared fields. Value types (uuid, enum) are NOT checked:
// the double's ids are `row-N`, not UUIDs.
const SCHEMA = manifest.schema as Record<string, { fields: Record<string, unknown> }>
const BASE_FIELDS: Record<string, string> = { id: "id", createdAt: "created_at", updatedAt: "updated_at" }

function declared(entity: string): Record<string, unknown> {
  const table = SCHEMA[entity]
  if (!table) throw new Error(`Unknown entity "${entity}"`)
  return table.fields
}

function checkKeys(kind: "where" | "orderBy", entity: string, keys: string[]): void {
  const fields = declared(entity)
  for (const k of keys) {
    if (!(k in BASE_FIELDS) && !(k in fields)) throw new Error(`Unknown ${kind} field "${k}" on entity "${entity}"`)
  }
}

/** Keys as `checkKeys`; operator objects (`{ in: [...] }`) are refused, the handlers never send one. */
function checkWhere(entity: string, where: Where): void {
  checkKeys("where", entity, Object.keys(where))
  for (const [k, v] of Object.entries(where)) {
    if (v !== null && typeof v === "object") throw new Error(`where.${k}: operators are not supported by the test double`)
  }
}

function checkWriteKeys(entity: string, data: Record<string, unknown>): void {
  const fields = declared(entity)
  for (const k of Object.keys(data)) {
    if (!(k in fields)) throw new Error(`Unknown field "${k}" on entity "${entity}"`)
  }
}

/** Bridge parity: a `null` value renders `IS NULL`, so it matches a null or a missing column. */
function whereMatches(row: StoredRow, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cell = (row as Record<string, unknown>)[BASE_FIELDS[k] ?? k]
    return v === null ? cell == null : cell === v
  })
}

/** Postgres default ordering: numbers numerically, NULL greater than any value (ASC NULLS LAST, DESC NULLS FIRST). */
function compareCells(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1
  if (typeof a === "number" && typeof b === "number") return a - b
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

/** Fire-and-clear a one-shot hook. */
async function runHook(hook: (() => Promise<void>) | undefined, clear: () => void): Promise<void> {
  if (!hook) return
  clear()
  await hook()
}

export function makeCtx(overrides?: { config?: Record<string, unknown>; scopes?: string[] }): {
  ctx: AppContext
  spy: CtxSpy
} {
  const spy: CtxSpy = {
    rows: new Map(),
    emits: [],
    config: overrides?.config ?? {},
    failNextEmit: false,
    uniqueInsert: true,
    sequences: new Map(),
    failNextAllocate: false,
    errors: [],
    store: new Map(),
  }
  let nextId = 1000
  let tick = 0
  // Monotonic stamps (one second apart): created_at orders successive inserts, and an update
  // moves updated_at past every stamp handed out before it.
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000).toISOString()
  const logger = noopLogger() as Record<string, unknown>
  logger.error = (msg: string, data?: unknown) => {
    spy.errors.push({ msg, data })
  }
  const ctx = {
    ...stubAppContext(),
    // Sandbox parity: `ctx.userId` is NOT populated in the QuickJS sandbox, the bridge exposes
    // `getUserId()` instead. A handler that reads the field gets undefined here, as in prod.
    userId: undefined,
    getUserId: async () => USER,
    logger,
    store: memoryStore(spy.store),
    sequences: {
      allocate: async ({ key }: { key: string }) => {
        await runHook(spy.duringNextAllocate, () => {
          spy.duringNextAllocate = undefined
        })
        if (spy.failNextAllocate) {
          spy.failNextAllocate = false
          return { error: { code: "test", message: "allocate failed (test)", retryable: true } }
        }
        const value = (spy.sequences.get(key) ?? 0) + 1
        spy.sequences.set(key, value)
        return { value }
      },
    },
    db: {
      findMany: async (
        entity: string,
        opts?: {
          where?: Where
          orderBy?: Record<string, "asc" | "desc">
          limit?: number
        },
      ) => {
        await runHook(spy.duringNextFindMany, () => {
          spy.duringNextFindMany = undefined
        })
        const where = opts?.where ?? {}
        checkWhere(entity, where)
        const all = spy.rows.get(entity) ?? []
        let filtered = all.filter((r) => whereMatches(r, where))
        const orderBy = opts?.orderBy
        if (orderBy) {
          checkKeys("orderBy", entity, Object.keys(orderBy))
          const keys = Object.entries(orderBy).map(([k, dir]) => [BASE_FIELDS[k] ?? k, dir] as const)
          filtered = [...filtered].sort((a, b) => {
            for (const [col, dir] of keys) {
              const cmp = compareCells(a[col], b[col])
              if (cmp !== 0) return dir === "asc" ? cmp : -cmp
            }
            return 0
          })
        }
        const limited = opts?.limit ? filtered.slice(0, opts.limit) : filtered
        // Rows come back as copies, like the bridge's JSON round trip.
        return limited.map((r) => ({ ...r }))
      },
      findOne: async (entity: string, id: string) => {
        if (spy.failNextFindOne === entity) {
          spy.failNextFindOne = undefined
          throw new Error("findOne failed (test)")
        }
        const all = spy.rows.get(entity) ?? []
        const row = all.find((r) => r.id === id)
        return row ? { ...row } : null
      },
      insert: async (entity: string, data: Record<string, unknown>) => {
        checkWriteKeys(entity, data)
        if (spy.failNextInsert === entity) {
          spy.failNextInsert = undefined
          throw new Error("insert failed (test)")
        }
        if (spy.uniqueInsert && entity === "incidents" && data.dedup_key != null) {
          const arr = spy.rows.get(entity) ?? []
          if (arr.some((r) => r.source === data.source && r.dedup_key === data.dedup_key)) {
            throw new Error("UNIQUE constraint failed: (source, dedup_key)")
          }
        }
        const id = `row-${nextId++}`
        const at = stamp()
        const row: StoredRow = { ...data, id, created_at: at, updated_at: at }
        const arr = spy.rows.get(entity) ?? []
        arr.push(row)
        spy.rows.set(entity, arr)
        return { id }
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        checkWriteKeys(entity, data)
        const arr = spy.rows.get(entity) ?? []
        const row = arr.find((r) => r.id === id)
        // Backstop of the real UNIQUE (org_id, ref_number).
        if (
          entity === "incidents" &&
          data.ref_number != null &&
          arr.some((r) => r.id !== id && r.ref_number === data.ref_number)
        ) {
          throw new Error("UNIQUE constraint failed: (ref_number)")
        }
        if (row) Object.assign(row, data, { updated_at: stamp() })
      },
      // The bridge's order (db_updateMany): empty data resolves { count: 0 } before `where` is
      // validated, then `where.id` is rejected, then the match runs.
      updateMany: async (entity: string, opts: { where: Where; data: Record<string, unknown> }) => {
        if (Object.keys(opts.data).length === 0) return { count: 0 }
        if ("id" in opts.where) throw new Error("where.id is not allowed here")
        checkWhere(entity, opts.where)
        checkWriteKeys(entity, opts.data)
        await runHook(spy.duringNextUpdateMany, () => {
          spy.duringNextUpdateMany = undefined
        })
        const matched = (spy.rows.get(entity) ?? []).filter((r) => whereMatches(r, opts.where))
        for (const row of matched) Object.assign(row, opts.data, { updated_at: stamp() })
        return { count: matched.length }
      },
      delete: async (entity: string, id: string) => {
        if (spy.failNextDelete === entity) {
          spy.failNextDelete = undefined
          throw new Error("delete failed (test)")
        }
        const arr = spy.rows.get(entity) ?? []
        spy.rows.set(
          entity,
          arr.filter((r) => r.id !== id),
        )
        // ON DELETE CASCADE of incident_comments.incident_id.
        if (entity === "incidents" && spy.rows.has("incident_comments")) {
          spy.rows.set(
            "incident_comments",
            spy.rows.get("incident_comments")!.filter((c) => c.incident_id !== id),
          )
        }
      },
      count: async (entity: string) => (spy.rows.get(entity) ?? []).length,
    },
    emit: async (event: {
      entity: string
      action: string
      entityId?: string
      data?: unknown
      metadata?: Record<string, unknown>
    }) => {
      const during = spy.duringNextEmit
      if (during) {
        spy.duringNextEmit = undefined
        await during()
      }
      if (spy.failNextEmit) {
        spy.failNextEmit = false
        throw new Error("emit failed (test)")
      }
      spy.emits.push(event)
    },
    config: { get: async (key: string) => spy.config[key] ?? null },
    // Mirrors the sandbox bridge's `hasScope` (exact grant, a parent grant, or
    // a trailing-`*` wildcard) over the caller's scopes.
    hasScope: async (scope: string) =>
      (overrides?.scopes ?? []).some((g) =>
        g.endsWith("*") ? scope.startsWith(g.slice(0, -1)) : scope === g || scope.startsWith(`${g}:`),
      ),
  } as unknown as AppContext
  return { ctx, spy }
}

/** Make the double's acting user (what `ctx.getUserId()` resolves) another id, e.g. a system actor. */
export function setActor(ctx: AppContext, userId: string): void {
  ;(ctx as unknown as { getUserId: () => Promise<string> }).getUserId = async () => userId
}

/** Rows helper — the incidents table content. */
export function incidents(spy: CtxSpy): StoredRow[] {
  return spy.rows.get("incidents") ?? []
}

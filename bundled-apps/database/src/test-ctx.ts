// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A fake `ctx` for the app's unit tests: an in-memory store, a directory of
// roles and people, the caller, and `ctx.sql` answering from a fixed catalog
// and a per-call responder. Records every `ctx.sql` call.

import type { KernelCaller, SqlReadInfo } from "@liaison/app-sdk"

export interface FakeSqlCall {
  method: "query" | "reads" | "schema" | "probe"
  connection: string
  request?: unknown
}

export interface FakeOptions {
  caller?: KernelCaller
  scopes?: string[]
  reads?: Record<string, Partial<SqlReadInfo>>
  domains?: Record<string, { tier: "internal" | "confidential" | "restricted" }>
  roles?: Array<{ id: string; name: string }>
  people?: Array<{ id: string; name: string; email: string }>
  stored?: unknown
  /** Answers `ctx.sql.query`; default: no rows. */
  query?: (connection: string, request: Record<string, unknown>) => unknown
  schema?: (connection: string, request: Record<string, unknown>) => unknown
  probe?: (connection: string) => unknown
  readsError?: { error: { code: string; message: string } }
}

export function readInfo(partial: Partial<SqlReadInfo> = {}): SqlReadInfo {
  return { params: {}, columns: [], tables: [], allowed: true, ...partial }
}

export function fakeCtx(opts: FakeOptions = {}) {
  const calls: FakeSqlCall[] = []
  const docs = new Map<string, { data: unknown; version: number }>()
  if (opts.stored !== undefined) {
    docs.set("settings/domain_access", { data: { value: opts.stored }, version: 1 })
  }
  const lookups = { caller: 0 }
  const people = opts.people ?? []
  const logs: Array<{ level: string; message: string }> = []
  const ctx = {
    calls,
    docs,
    lookups,
    logs,
    callerHasScope: (scope: string) => (opts.scopes ?? []).includes(scope),
    store: {
      async get(collection: string, id: string) {
        const doc = docs.get(`${collection}/${id}`)
        return doc ? { id, data: doc.data, version: doc.version } : null
      },
      async set(collection: string, id: string, data: unknown) {
        const prev = docs.get(`${collection}/${id}`)
        const next = { data, version: (prev?.version ?? 0) + 1 }
        docs.set(`${collection}/${id}`, next)
        return { id, ...next }
      },
    },
    kernel: {
      async caller(scopes: string[] = []) {
        lookups.caller++
        const base = opts.caller ?? { kind: "system", holds: {} }
        const holds = Object.fromEntries(
          scopes.map((s) => [s, base.kind === "system" || (opts.scopes ?? []).includes(s)]),
        )
        return { ...base, holds } as KernelCaller
      },
      async roles() {
        return opts.roles ?? []
      },
      async findByIds(_entity: string, ids: string[]) {
        return people.filter((p) => ids.includes(p.id))
      },
      async findUsersByEmail(emails: string[]) {
        const wanted = new Set(emails.map((e) => e.toLowerCase()))
        return people.filter((p) => wanted.has(p.email.toLowerCase()))
      },
    },
    sql: {
      async reads(connection: string) {
        calls.push({ method: "reads", connection })
        if (opts.readsError) return opts.readsError
        const reads = Object.fromEntries(
          Object.entries(opts.reads ?? {}).map(([name, r]) => [name, readInfo(r)]),
        )
        return { adapter: "test-catalog", reads, domains: opts.domains ?? {} }
      },
      async query(connection: string, request: Record<string, unknown>) {
        calls.push({ method: "query", connection, request })
        return opts.query?.(connection, request) ?? { rows: [], truncated: false, durationMs: 1 }
      },
      async schema(connection: string, request: Record<string, unknown>) {
        calls.push({ method: "schema", connection, request })
        return opts.schema?.(connection, request) ?? { tables: [] }
      },
      async probe(connection: string, request: Record<string, unknown>) {
        calls.push({ method: "probe", connection, request })
        return opts.probe?.(connection) ?? { ok: true, warnings: [] }
      },
    },
    logger: {
      info: (message: string) => logs.push({ level: "info", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      error: (message: string) => logs.push({ level: "error", message }),
      debug: (message: string) => logs.push({ level: "debug", message }),
    },
  }
  return ctx
}

/** The fake, typed as what a handler takes. */
// biome-ignore lint/suspicious/noExplicitAny: the handlers each take a narrow Pick of AppContext.
export const asCtx = (ctx: ReturnType<typeof fakeCtx>): any => ctx

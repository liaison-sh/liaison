// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit tests for PostgresDirect's `dialect` switch, against a fake postgres.js
// client (no database): what the driver is configured with, and which SQL
// describe and probe send. The Redshift SQL itself was checked against a live
// cluster; these tests pin that the transport sends it, and that the default
// Postgres path sends exactly what it sent before.

import { describe, expect, test } from "bun:test"
import type { ReadCatalog } from "@liaison/db-core"
import type postgres from "postgres"
import { DbTransportError } from "../transport"
import {
  PostgresDirect,
  type PostgresDirectOptions,
  PRIVILEGED_ROLE_REACH_SQL,
} from "./postgres-direct"

const emptyCatalog: ReadCatalog = { adapter: "t", reads: {} }

interface Sent {
  sql: string
  params?: unknown[]
}

function fakeConnect(
  rows: Record<string, unknown>[] = [],
  /** What the privileged-role pre-flight finds: roles the login can reach. */
  reachableRoles: Record<string, unknown>[] = [],
) {
  const sent: Sent[] = []
  let options: Record<string, unknown> | undefined
  const tx = {
    unsafe: async (sql: string, params?: unknown[]) => {
      sent.push({ sql, params })
      if (sql === PRIVILEGED_ROLE_REACH_SQL) return reachableRoles
      return /^\s*SET /.test(sql) ? [] : rows
    },
  }
  const connect: NonNullable<PostgresDirectOptions["connect"]> = (_dsn, opts) => {
    options = opts as Record<string, unknown>
    return {
      begin: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      end: async () => {},
    } as unknown as postgres.Sql
  }
  return { connect, sent, options: () => options }
}

const DESCRIBE_ROWS = [
  { table_schema: "dwh", table_name: "fact", column_name: "id", data_type: "bigint" },
  { table_schema: "dwh", table_name: "fact", column_name: "label", data_type: "character varying" },
]

describe("PostgresDirect — redshift dialect", () => {
  test("turns off postgres.js's connect-time type fetch (Redshift's pg_type lacks its columns)", () => {
    const fake = fakeConnect()
    new PostgresDirect({
      dsn: "postgres://u:p@127.0.0.9:5439/wh",
      dialect: "redshift",
      connect: fake.connect,
    })
    expect(fake.options()?.fetch_types).toBe(false)
  })

  test("describe reads svv_columns behind the USAGE guard, inside the READ ONLY preamble", async () => {
    const fake = fakeConnect(DESCRIBE_ROWS)
    const t = new PostgresDirect({
      dsn: "postgres://u:p@127.0.0.9:5439/wh",
      dialect: "redshift",
      connect: fake.connect,
    })
    const info = await t.describe(emptyCatalog, "dwh.fact")
    expect(fake.sent[0]?.sql).toBe("SET TRANSACTION READ ONLY")
    expect(fake.sent[1]?.sql).toMatch(/^SET LOCAL statement_timeout = \d+$/)
    const describeSql = fake.sent[2]?.sql ?? ""
    expect(describeSql).toContain("FROM svv_columns")
    expect(describeSql).toContain("has_schema_privilege(current_user, c.table_schema, 'USAGE')")
    expect(describeSql).not.toContain("information_schema.columns")
    expect(fake.sent[2]?.params).toEqual(["dwh", "fact"])
    expect(info.tables).toEqual([
      {
        table: "dwh.fact",
        columns: [
          { column: "id", dataType: "bigint" },
          { column: "label", dataType: "character varying" },
        ],
      },
    ])
  })

  test("the write-grant probe avoids a VALUES list (a Redshift syntax error)", async () => {
    const fake = fakeConnect([])
    const t = new PostgresDirect({
      dsn: "postgres://u:p@127.0.0.1:5439/wh",
      dialect: "redshift",
      connect: fake.connect,
    })
    await t.probe()
    const grantSql = fake.sent.map((s) => s.sql).find((q) => q.includes("privilege_type")) ?? ""
    expect(grantSql).toContain("FROM svv_tables")
    expect(grantSql).not.toContain("VALUES")
  })
})

describe("PostgresDirect — default (postgres) dialect is unchanged", () => {
  test("driver options carry no fetch_types override", () => {
    const fake = fakeConnect()
    new PostgresDirect({ dsn: "postgres://u:p@localhost/db", connect: fake.connect })
    expect(fake.options()).not.toHaveProperty("fetch_types")
  })

  test("describe still reads information_schema.columns", async () => {
    const fake = fakeConnect(DESCRIBE_ROWS)
    const t = new PostgresDirect({ dsn: "postgres://u:p@localhost/db", connect: fake.connect })
    await t.describe(emptyCatalog)
    expect(fake.sent[2]?.sql).toBe(PRIVILEGED_ROLE_REACH_SQL)
    expect(fake.sent[3]?.sql).toContain("FROM information_schema.columns")
    expect(fake.sent[3]?.params).toEqual([null, null])
  })
})

describe("PostgresDirect — a login that can reach a privileged role is refused", () => {
  const dsn = "postgres://u:p@localhost/db"

  test("pre-flight sees superuser or BYPASSRLS roles the login is a member of: refuse, run nothing", async () => {
    const fake = fakeConnect([{ x: 1 }], [{ rolname: "liaison_admin" }])
    const t = new PostgresDirect({ dsn, connect: fake.connect })
    const err = await t.runQuery("SELECT 1").catch((e) => e)
    expect(err).toBeInstanceOf(DbTransportError)
    expect((err as DbTransportError).kind).toBe("config")
    expect(fake.sent.some((s) => s.sql.includes("SELECT 1"))).toBe(false)
    // describe and probe are covered by the same wall.
    expect(await t.describe(emptyCatalog).catch((e) => e)).toBeInstanceOf(DbTransportError)
    expect((await t.probe()).ok).toBe(false)
  })

  test("a login that reaches no such role runs, and the pre-flight is not repeated", async () => {
    const fake = fakeConnect([{ x: 1 }], [])
    const t = new PostgresDirect({ dsn, connect: fake.connect })
    await t.runQuery("SELECT 1")
    await t.runQuery("SELECT 1")
    expect(fake.sent.filter((s) => s.sql === PRIVILEGED_ROLE_REACH_SQL)).toHaveLength(1)
  })

  test("the pre-flight runs before any caller SQL", async () => {
    const fake = fakeConnect([{ x: 1 }], [])
    const t = new PostgresDirect({ dsn, connect: fake.connect })
    await t.runQuery("SELECT 1")
    const order = fake.sent.map((s) => s.sql)
    const pre = order.indexOf(PRIVILEGED_ROLE_REACH_SQL)
    expect(pre).toBeGreaterThan(-1)
    expect(pre).toBeLessThan(order.findIndex((q) => q.includes("SELECT 1")))
  })

  test("fails closed when the pre-flight itself cannot run", async () => {
    const fake = fakeConnect([{ x: 1 }], [])
    const connect: NonNullable<PostgresDirectOptions["connect"]> = (d, o) => {
      const sql = fake.connect(d, o) as unknown as {
        begin: (
          fn: (tx: { unsafe: (q: string) => Promise<unknown> }) => Promise<unknown>,
        ) => Promise<unknown>
      }
      return {
        ...sql,
        begin: (fn: (tx: { unsafe: (q: string) => Promise<unknown> }) => Promise<unknown>) =>
          sql.begin((tx) =>
            fn({
              unsafe: async (q: string, ...rest: unknown[]) => {
                if (q === PRIVILEGED_ROLE_REACH_SQL) throw new Error("permission denied")
                return (tx.unsafe as (...a: unknown[]) => Promise<unknown>)(q, ...rest)
              },
            }),
          ),
        end: async () => {},
      } as unknown as postgres.Sql
    }
    const t = new PostgresDirect({ dsn, connect })
    expect(await t.runQuery("SELECT 1").catch((e) => e)).toBeInstanceOf(DbTransportError)
  })

  test("the explicit opt-out skips it", async () => {
    const fake = fakeConnect([{ x: 1 }], [{ rolname: "liaison_admin" }])
    const t = new PostgresDirect({ dsn, connect: fake.connect, allowPrivilegedSession: true })
    await t.runQuery("SELECT 1")
    expect(fake.sent.some((s) => s.sql === PRIVILEGED_ROLE_REACH_SQL)).toBe(false)
  })
})

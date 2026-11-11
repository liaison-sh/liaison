// SPDX-License-Identifier: FSL-1.1-ALv2
// The platform's SQL connection pools: created on first use, reused while the
// credentials are unchanged, replaced (and the old one closed) when they change,
// closed on removal, when idle, and beyond the bound (least recently used first),
// never while a call runs on them.
import { afterEach, describe, expect, it } from "bun:test"
import type { DatabaseCredentials } from "./credentials"
import {
  closeSqlPools,
  type SqlPoolKey,
  SqlPoolTestAccess,
  sweepIdleSqlPools,
  withSqlTransport,
} from "./pool"
import type { DbTransport } from "./transport"

class FakeTransport implements DbTransport {
  closed = false
  constructor(readonly creds: DatabaseCredentials) {}
  async probe() {
    return { ok: true, mode: "direct" as const, warnings: [] }
  }
  async runRead() {
    return { rows: [], truncated: false, durationMs: 0 }
  }
  async runQuery() {
    return { rows: [], truncated: false, durationMs: 0 }
  }
  async describe() {
    return { tables: [] }
  }
  async close() {
    this.closed = true
  }
}

const built: FakeTransport[] = []
const factory = (creds: DatabaseCredentials) => {
  const t = new FakeTransport(creds)
  built.push(t)
  return t
}

const key = (orgId: string, identifier = "default"): SqlPoolKey => ({
  orgId,
  appName: "dbapp",
  connectionName: "main",
  identifier,
})
const DSN_A = { connectionString: "postgres://a@db.example/x" }
const DSN_B = { connectionString: "postgres://b@db.example/x" }

const use = (k: SqlPoolKey, creds: DatabaseCredentials) =>
  withSqlTransport(k, creds, async (t) => t as FakeTransport, factory)

const savedMax = process.env.LIAISON_SQL_POOLS_MAX

afterEach(() => {
  SqlPoolTestAccess.reset()
  built.length = 0
  if (savedMax === undefined) delete process.env.LIAISON_SQL_POOLS_MAX
  else process.env.LIAISON_SQL_POOLS_MAX = savedMax
})

describe("SQL connection pools", () => {
  it("is created lazily and reused for the same credentials", async () => {
    expect(SqlPoolTestAccess.size()).toBe(0)
    const first = await use(key("org-1"), DSN_A)
    const second = await use(key("org-1"), DSN_A)
    expect(second).toBe(first)
    expect(built).toHaveLength(1)
  })

  it("keeps orgs apart: the same credentials in two orgs are two pools", async () => {
    const a = await use(key("org-1"), DSN_A)
    const b = await use(key("org-2"), DSN_A)
    expect(a).not.toBe(b)
    expect(SqlPoolTestAccess.size()).toBe(2)
  })

  it("replaces the pool when the credentials change and closes the old one", async () => {
    const old = await use(key("org-1"), DSN_A)
    const fresh = await use(key("org-1"), DSN_B)
    expect(fresh).not.toBe(old)
    expect(old.closed).toBe(true)
    expect(SqlPoolTestAccess.size()).toBe(1)
  })

  it("closes an org connection's pools on removal, and only those", async () => {
    const mine = await use(key("org-1"), DSN_A)
    const other = await use(key("org-2"), DSN_A)
    expect(closeSqlPools({ orgId: "org-1", appName: "dbapp", connectionName: "main" })).toBe(1)
    expect(mine.closed).toBe(true)
    expect(other.closed).toBe(false)
    expect(SqlPoolTestAccess.size()).toBe(1)
  })

  it("closes idle pools, never one running a call", async () => {
    const idle = await use(key("org-1"), DSN_A)
    let release!: () => void
    const running = withSqlTransport(
      key("org-2"),
      DSN_A,
      (t) => new Promise<FakeTransport>((r) => (release = () => r(t as FakeTransport))),
      factory,
    )
    await Promise.resolve()
    SqlPoolTestAccess.age(60 * 60_000)
    expect(sweepIdleSqlPools()).toBe(1)
    expect(idle.closed).toBe(true)
    release()
    const busy = await running
    expect(busy.closed).toBe(false)
  })

  it("is bounded: past the bound the least recently used pool is closed", async () => {
    process.env.LIAISON_SQL_POOLS_MAX = "2"
    const one = await use(key("org-1"), DSN_A)
    const two = await use(key("org-2"), DSN_A)
    await use(key("org-1"), DSN_A) // org-1 is now the most recent
    const three = await use(key("org-3"), DSN_A)
    expect(SqlPoolTestAccess.size()).toBe(2)
    expect(two.closed).toBe(true)
    expect(one.closed).toBe(false)
    expect(three.closed).toBe(false)
  })

  it("shares one pool across orgs for a host-built shared handle (demo warehouse)", async () => {
    const shared = { connectionString: "postgres://w@wh/x", sharedPool: "demo" }
    const a = await use(key("org-1"), shared)
    const b = await use(key("org-2"), shared)
    expect(b).toBe(a)
    // A shared pool belongs to no org: an org's removal does not close it.
    expect(closeSqlPools({ orgId: "org-1", appName: "dbapp" })).toBe(0)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What an org admin can point the connector at, and what it tells them when a
// connection fails. Against a fake postgres.js client: no database, no network.
import { describe, expect, test } from "bun:test"
import type postgres from "postgres"
import { buildTransport, instanceServiceEndpoints } from "../credentials"
import { DbTransportError } from "../transport"
import {
  hostMatchesAllowList,
  isForbiddenResolvedIp,
  PostgresDirect,
  type PostgresDirectOptions,
} from "./postgres-direct"

function fakeConnect(failWith?: unknown) {
  let connected = 0
  const tx = { unsafe: async () => [] }
  const connect: NonNullable<PostgresDirectOptions["connect"]> = () => {
    connected++
    return {
      begin: async (fn: (t: typeof tx) => Promise<unknown>) => {
        if (failWith) throw failWith
        return fn(tx)
      },
      end: async () => {},
    } as unknown as postgres.Sql
  }
  return { connect, connected: () => connected }
}

const resolveTo = (ip: string) => async () => [ip]

async function refusal(t: PostgresDirect): Promise<DbTransportError> {
  const err = await t.runQuery("SELECT 1").catch((e) => e)
  expect(err).toBeInstanceOf(DbTransportError)
  return err as DbTransportError
}

describe("connector host policy", () => {
  test("link-local and metadata addresses are refused, whatever name resolves to them", async () => {
    for (const ip of [
      "169.254.169.254",
      "169.254.10.1",
      "fe80::1",
      "::ffff:169.254.169.254",
      "0.0.0.0",
    ]) {
      const t = new PostgresDirect({
        dsn: "postgres://u:p@metadata.example.test/db?sslmode=require",
        resolveDns: resolveTo(ip),
        connect: fakeConnect().connect,
      })
      const err = await refusal(t)
      expect(err.kind).toBe("config")
      expect(err.message).toContain("not allowed")
    }
    // IPv6-mapped spellings of the metadata address, as a DSN host literal: the
    // resolver hands back exactly what it was given.
    for (const literal of [
      "[::ffff:a9fe:a9fe]",
      "[::ffff:169.254.169.254]",
      "[0:0:0:0:0:ffff:a9fe:a9fe]",
    ]) {
      const t = new PostgresDirect({
        dsn: `postgres://u:p@${literal}/db?sslmode=require`,
        resolveDns: async (h) => [h],
        connect: fakeConnect().connect,
      })
      expect((await refusal(t)).message).toContain("not allowed")
    }
    expect(isForbiddenResolvedIp("::ffff:a9fe:a9fe")).toBe(true)
    expect(isForbiddenResolvedIp("10.0.0.5")).toBe(false)
    expect(isForbiddenResolvedIp("127.0.0.1")).toBe(false)
  })

  test("a host that does not resolve is refused before any connection, with the generic answer", async () => {
    const fake = fakeConnect()
    const t = new PostgresDirect({
      dsn: "postgres://u:p@nowhere.invalid/db?sslmode=require",
      resolveDns: async () => [],
      connect: fake.connect,
    })
    const err = await refusal(t)
    expect(err.kind).toBe("unreachable")
    expect(err.message).toBe("Could not connect to the database")
  })

  test("the operator allow-list restricts the DSN host when set", async () => {
    const fake = fakeConnect()
    const denied = new PostgresDirect({
      dsn: "postgres://u:p@10.1.2.3/db",
      allowedHosts: ["db.corp.example", "*.warehouse.example"],
      resolveDns: resolveTo("10.1.2.3"),
      connect: fake.connect,
    })
    const err = await refusal(denied)
    expect(err.message).toContain("allow-list")

    const allowed = new PostgresDirect({
      dsn: "postgres://u:p@eu.warehouse.example/db",
      allowedHosts: ["db.corp.example", "*.warehouse.example"],
      resolveDns: resolveTo("10.1.2.3"),
      connect: fake.connect,
    })
    await allowed.runQuery("SELECT 1")
  })

  test("no allow-list keeps today's behaviour for private hosts", async () => {
    const t = new PostgresDirect({
      dsn: "postgres://u:p@10.1.2.3/db",
      resolveDns: resolveTo("10.1.2.3"),
      connect: fakeConnect().connect,
    })
    await t.runQuery("SELECT 1")
  })

  test("the instance's own redis, search and storage endpoints are refused", async () => {
    const t = new PostgresDirect({
      dsn: "postgres://u:p@redis.internal:6379/db",
      blockedEndpoints: ["redis.internal:6379"],
      resolveDns: resolveTo("10.0.0.7"),
      connect: fakeConnect().connect,
    })
    expect((await refusal(t)).message).toContain("service of this Liaison instance")
    // Same host, the database port: not a service endpoint.
    const ok = new PostgresDirect({
      dsn: "postgres://u:p@redis.internal:5432/db",
      blockedEndpoints: ["redis.internal:6379"],
      resolveDns: resolveTo("10.0.0.7"),
      connect: fakeConnect().connect,
    })
    await ok.runQuery("SELECT 1")
  })

  test("another spelling of a service endpoint (IP literal, other name, loopback alias) is refused too", async () => {
    const dns: Record<string, string[]> = {
      redis: ["172.18.0.4"],
      "cache-alias.internal": ["172.18.0.4"],
      localhost: ["::1", "127.0.0.1"],
    }
    const resolveDns = async (h: string) => dns[h] ?? (/^[0-9a-f.:]+$/i.test(h) ? [h] : [])
    for (const [dsnHost, blocked] of [
      ["172.18.0.4", "redis:6379"],
      ["cache-alias.internal", "redis:6379"],
      ["[::ffff:172.18.0.4]", "redis:6379"],
      ["127.0.0.1", "localhost:6379"],
      ["127.0.0.2", "localhost:6379"],
    ] as const) {
      const t = new PostgresDirect({
        dsn: `postgres://u:p@${dsnHost}:6379/db`,
        blockedEndpoints: [blocked],
        resolveDns,
        connect: fakeConnect().connect,
      })
      expect((await refusal(t)).message).toContain("service of this Liaison instance")
    }
  })

  test("a trusted (deployment-chosen) host skips the allow-list but not the link-local denial", async () => {
    const t = new PostgresDirect({
      dsn: "postgres://u:p@warehouse.internal/db",
      allowedHosts: ["only.this.example"],
      trustedHost: true,
      resolveDns: resolveTo("10.0.0.9"),
      connect: fakeConnect().connect,
    })
    await t.runQuery("SELECT 1")
    const meta = new PostgresDirect({
      dsn: "postgres://u:p@warehouse.internal/db",
      trustedHost: true,
      resolveDns: resolveTo("169.254.169.254"),
      connect: fakeConnect().connect,
    })
    expect((await refusal(meta)).kind).toBe("config")
  })

  test("allow-list matching: exact, wildcard subdomain, not the bare suffix", () => {
    expect(hostMatchesAllowList("a.example.com", ["*.example.com"])).toBe(true)
    expect(hostMatchesAllowList("example.com", ["*.example.com"])).toBe(false)
    expect(hostMatchesAllowList("DB.Example.com", ["db.example.com"])).toBe(true)
    expect(hostMatchesAllowList("evil-example.com", ["*.example.com"])).toBe(false)
  })

  test("instanceServiceEndpoints reads redis, search and storage host:port", () => {
    expect(
      instanceServiceEndpoints({
        REDIS_URL: "redis://cache.internal:6380",
        MEILISEARCH_HOST: "http://search.internal:7700",
        OBJECT_STORAGE_ENDPOINT: "https://s3.internal",
      }),
    ).toEqual(["cache.internal:6380", "search.internal:7700", "s3.internal:443"])
  })

  test("buildTransport wires the allow-list from the environment", async () => {
    const prior = process.env.LIAISON_DATABASE_ALLOWED_HOSTS
    process.env.LIAISON_DATABASE_ALLOWED_HOSTS = "db.corp.example"
    try {
      const t = buildTransport({ connectionString: "postgres://u:p@127.0.0.1:5432/db" })
      const err = await t.runQuery("SELECT 1").catch((e) => e)
      expect(err).toBeInstanceOf(DbTransportError)
      expect((err as DbTransportError).message).toContain("allow-list")
      await t.close().catch(() => {})
    } finally {
      if (prior === undefined) delete process.env.LIAISON_DATABASE_ALLOWED_HOSTS
      else process.env.LIAISON_DATABASE_ALLOWED_HOSTS = prior
    }
  })
})

describe("connection failures are one answer", () => {
  const failures = [
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("connect ETIMEDOUT 10.0.0.6:5432"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("getaddrinfo ENOTFOUND internal-host"), { code: "ENOTFOUND" }),
    Object.assign(new Error("write CONNECT_TIMEOUT 10.0.0.7:5432"), { code: "CONNECT_TIMEOUT" }),
    new Error("Connection closed by 10.0.0.8:6379 socket hang up"),
  ]
  for (const failure of failures) {
    test(String((failure as Error).message), async () => {
      const t = new PostgresDirect({
        dsn: "postgres://u:p@10.0.0.5/db",
        resolveDns: resolveTo("10.0.0.5"),
        connect: fakeConnect(failure).connect,
      })
      const err = await refusal(t)
      expect(err.kind).toBe("unreachable")
      expect(err.message).toBe("Could not connect to the database")
      expect(err.code).toBeUndefined()
    })
  }

  test("a SQL error still reports its own message", async () => {
    const sqlError = Object.assign(new Error('relation "nope" does not exist'), { code: "42P01" })
    const t = new PostgresDirect({
      dsn: "postgres://u:p@10.0.0.5/db",
      resolveDns: resolveTo("10.0.0.5"),
      connect: fakeConnect(sqlError).connect,
    })
    const err = await refusal(t)
    expect(err.kind).toBe("execution")
    expect(err.message).toContain("does not exist")
  })
})

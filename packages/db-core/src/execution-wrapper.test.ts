// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  ConcurrencyBound,
  capRows,
  classifyDsnHost,
  classifyIp,
  type DnsResolver,
  projectColumns,
  redactDbError,
  wrapWithRowCap,
} from "./execution-wrapper"

describe("classifyIp", () => {
  test("loopback v4", () => expect(classifyIp("127.0.0.1")).toBe("loopback"))
  test("loopback v6", () => expect(classifyIp("::1")).toBe("loopback"))
  test("RFC1918 10.x", () => expect(classifyIp("10.1.2.3")).toBe("private"))
  test("RFC1918 172.16-31.x", () => expect(classifyIp("172.20.0.5")).toBe("private"))
  test("172.15.x is NOT RFC1918 (public)", () => expect(classifyIp("172.15.0.5")).toBe("public"))
  test("172.32.x is NOT RFC1918 (public)", () => expect(classifyIp("172.32.0.5")).toBe("public"))
  test("RFC1918 192.168.x", () => expect(classifyIp("192.168.1.1")).toBe("private"))
  test("public IPv4", () => expect(classifyIp("203.0.113.5")).toBe("public"))
  test("IPv6 unique-local (fc00::/7)", () => expect(classifyIp("fd12:3456::1")).toBe("private"))
  test("public IPv6", () => expect(classifyIp("2001:db8::1")).toBe("public"))
})

function stubResolver(map: Record<string, string[]>): DnsResolver {
  return async (host: string) => map[host] ?? []
}

describe("classifyDsnHost — TLS-by-resolved-IP classifier matrix", () => {
  test("loopback DSN -> no TLS required", async () => {
    const result = await classifyDsnHost("localhost", stubResolver({ localhost: ["127.0.0.1"] }))
    expect(result.kind).toBe("loopback")
    expect(result.tlsRequired).toBe(false)
  })

  test("docker service name resolving to a private IP -> no TLS required", async () => {
    const result = await classifyDsnHost("postgres", stubResolver({ postgres: ["172.20.0.5"] }))
    expect(result.kind).toBe("private")
    expect(result.tlsRequired).toBe(false)
  })

  test("bare public IP DSN -> TLS required", async () => {
    const result = await classifyDsnHost(
      "203.0.113.5",
      stubResolver({ "203.0.113.5": ["203.0.113.5"] }),
    )
    expect(result.kind).toBe("public")
    expect(result.tlsRequired).toBe(true)
  })

  test("a bare/.internal-suffixed name that RESOLVES to a public IP -> TLS required (classified by IP, not name shape)", async () => {
    const result = await classifyDsnHost(
      "db.internal",
      stubResolver({ "db.internal": ["203.0.113.9"] }),
    )
    expect(result.kind).toBe("public")
    expect(result.tlsRequired).toBe(true)
  })

  test("mixed resolution (one private + one public IP) -> most-public-wins, TLS required", async () => {
    const result = await classifyDsnHost(
      "mixed.example",
      stubResolver({ "mixed.example": ["10.0.0.1", "203.0.113.5"] }),
    )
    expect(result.kind).toBe("public")
    expect(result.tlsRequired).toBe(true)
  })

  test("unresolvable host -> fails closed as public/TLS-required", async () => {
    const result = await classifyDsnHost("nonexistent.invalid", stubResolver({}))
    expect(result.kind).toBe("public")
    expect(result.tlsRequired).toBe(true)
  })
})

describe("ConcurrencyBound", () => {
  test("allows up to `limit` concurrent executions", async () => {
    const bound = new ConcurrencyBound(2)
    let concurrent = 0
    let maxConcurrent = 0
    const task = () =>
      bound.run(async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 20))
        concurrent--
      })
    await Promise.all([task(), task(), task(), task()])
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  test("queues beyond the limit rather than exhausting immediately (N parallel pg_sleep-shaped calls cannot all acquire at once)", async () => {
    const bound = new ConcurrencyBound(1)
    const order: number[] = []
    const task = (id: number) =>
      bound.run(async () => {
        order.push(id)
        await new Promise((r) => setTimeout(r, 5))
      })
    await Promise.all([task(1), task(2), task(3)])
    // All ran, but serially (bound=1) — queuing observed, not exhaustion/crash.
    expect(order).toEqual([1, 2, 3])
    expect(bound.activeCount).toBe(0)
    expect(bound.queuedCount).toBe(0)
  })
})

describe("capRows", () => {
  test("no truncation when under the cap", () => {
    const result = capRows([1, 2, 3], 5)
    expect(result.truncated).toBe(false)
    expect(result.rows).toEqual([1, 2, 3])
  })
  test("truncates and flags when over the cap", () => {
    const result = capRows([1, 2, 3, 4, 5], 3)
    expect(result.truncated).toBe(true)
    expect(result.rows).toEqual([1, 2, 3])
  })
})

describe("projectColumns — non-vacuous column projection", () => {
  test("drops columns not in the allow-list even when the row has extra/secret-like columns", () => {
    const rows = [
      {
        id: "1",
        tier: "pro",
        credentials_encrypted: "should-never-surface",
        internal_note: "also should not surface",
      },
    ]
    const projected = projectColumns(rows, ["id", "tier"])
    expect(projected).toEqual([{ id: "1", tier: "pro" }])
    expect(projected[0]).not.toHaveProperty("credentials_encrypted")
    expect(projected[0]).not.toHaveProperty("internal_note")
  })

  test("missing declared column on a row is simply omitted, not errored", () => {
    const rows = [{ id: "1" }]
    const projected = projectColumns(rows, ["id", "tier"])
    expect(projected).toEqual([{ id: "1" }])
  })
})

describe("redactDbError", () => {
  test("strips a DSN from the error message", () => {
    const err = new Error("connection failed: postgres://user:hunter2@10.0.0.5:5432/db unreachable")
    const { message } = redactDbError(err)
    expect(message).not.toContain("hunter2")
    expect(message).not.toContain("postgres://")
  })

  test("strips password= key-value pairs", () => {
    const err = new Error("auth failed for password=supersecret123")
    const { message } = redactDbError(err)
    expect(message).not.toContain("supersecret123")
  })

  test("preserves SQLSTATE code when present", () => {
    const err = Object.assign(new Error("permission denied for table users"), { code: "42501" })
    const { code } = redactDbError(err)
    expect(code).toBe("42501")
  })

  // A connected database's error text is not ours (a value echoed back, or a
  // hostile server): the DSN pattern rescans from every letter of a long run,
  // so a few hundred kilobytes held the event loop for seconds.
  test("stays fast on a huge message, and keeps redacting what it keeps", () => {
    for (const unit of ["a", "a.", "A"]) {
      const err = new Error(`${unit.repeat(400_000)} postgres://u:hunter2@h/db`)
      const start = performance.now()
      const { message } = redactDbError(err)
      expect(performance.now() - start).toBeLessThan(250)
      expect(message).not.toContain("hunter2")
    }
    const { message } = redactDbError(new Error(`bad: password=s3cret ${"x".repeat(10_000)}`))
    expect(message).not.toContain("s3cret")
    expect(message.length).toBeLessThan(5_000)
  })
})

describe("wrapWithRowCap — a trailing line comment cannot swallow the cap", () => {
  test("the LIMIT survives `-- note` at the end of the statement", () => {
    const wrapped = wrapWithRowCap("SELECT 1 AS one -- note", 500)
    const lastLine = wrapped.split("\n").at(-1)
    expect(lastLine).toBe(") AS __liaison_row_cap LIMIT 501")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  redisUrlFromEnvFile,
  sweepRedisPrefix,
  testRedisFlushCommand,
  testRedisFlushTarget,
} from "./test-redis-flush"

describe("testRedisFlushTarget", () => {
  it("flushes the database the process env names", () => {
    expect(testRedisFlushTarget({ REDIS_URL: "redis://localhost:6379/10" })).toEqual({
      url: "redis://localhost:6379/10",
      db: 10,
    })
  })

  it("falls back to .env.test, the process env winning", () => {
    const file = '# test env\nDATABASE_URL=postgres://x\nREDIS_URL="redis://127.0.0.1:6380/3"\n'
    expect(testRedisFlushTarget({}, file)).toEqual({ url: "redis://127.0.0.1:6380/3", db: 3 })
    expect(testRedisFlushTarget({ REDIS_URL: "redis://h:1/4" }, file)).toEqual({
      url: "redis://h:1/4",
      db: 4,
    })
  })

  it("never flushes database 0, named or implied, nor anything when no URL is set", () => {
    for (const env of [
      {},
      { REDIS_URL: "redis://localhost:6379" },
      { REDIS_URL: "redis://localhost:6379/" },
      { REDIS_URL: "redis://localhost:6379/0" },
      { REDIS_URL: "http://localhost:6379/5" },
      { REDIS_URL: "redis://localhost:6379/x" },
    ]) {
      expect("skip" in testRedisFlushTarget(env)).toBe(true)
    }
  })

  it("reads REDIS_URL from an env file, quoted or exported", () => {
    expect(redisUrlFromEnvFile("export REDIS_URL='redis://a/2'")).toBe("redis://a/2")
    expect(redisUrlFromEnvFile("# REDIS_URL=redis://a/2")).toBeUndefined()
  })
})

describe("scripts/test-run.ts pretest reset", () => {
  it("flushes the test env's own database, or nothing (bare-run helper)", () => {
    expect(testRedisFlushCommand({ REDIS_URL: "redis://localhost:6379/12" })).toEqual({
      cmd: ["redis-cli", "-u", "redis://localhost:6379/12", "FLUSHDB"],
    })
    expect("skip" in testRedisFlushCommand({ REDIS_URL: "redis://localhost:6379" })).toBe(true)
  })

  // A namespaced run shares Redis with every other checkout: its reset unlinks
  // its own prefix and never flushes a database.
  it("sweeps only the run namespace's own keys", async () => {
    const source = await Bun.file(new URL("../test-run.ts", import.meta.url)).text()
    expect(source).not.toContain('"redis-cli"')
    expect(source).not.toContain("FLUSHDB")
    expect(source).toContain("sweepRedisPrefix(COORDS.redisUrl, COORDS.redisPrefix)")
  })

  it("refuses to sweep with an empty prefix", async () => {
    await expect(sweepRedisPrefix("redis://localhost:6379", "")).rejects.toThrow(/empty prefix/)
  })
})

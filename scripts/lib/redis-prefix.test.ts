// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import os from "node:os"
import path from "node:path"
import { resolveTestRedisPrefix } from "./redis-prefix"

const ROOT = path.resolve(import.meta.dir, "../..")

describe("resolveTestRedisPrefix", () => {
  it("keeps an explicit prefix, so the parallel runners stay in charge", () => {
    expect(resolveTestRedisPrefix({ REDIS_PREFIX: "w3_abcd:" }, 42)).toBe("w3_abcd:")
  })

  it("invents a prefix when none is set, so an unprefixed run gets its own namespace", () => {
    const prefix = resolveTestRedisPrefix({}, 42, () => 0.5)
    expect(prefix).not.toBe("")
    expect(prefix).toContain("42")
    expect(prefix.endsWith(":")).toBe(true)
  })

  it("treats an empty prefix as absent", () => {
    expect(resolveTestRedisPrefix({ REDIS_PREFIX: "" }, 42, () => 0.5)).not.toBe("")
  })

  it("gives two concurrent runs different namespaces", () => {
    let n = 0
    const a = resolveTestRedisPrefix({}, 42, () => {
      n += 0.1
      return n
    })
    const b = resolveTestRedisPrefix({}, 42, () => {
      n += 0.1
      return n
    })
    expect(a).not.toBe(b)
  })
})

// with-test-lock takes a machine slot, then the checkout's namespace lock, then
// prepares the namespace database. Under `test-run.ts root` the parent already
// holds the namespace lock, so a child that re-takes it waits on its own parent
// until the 30 s test timeout (and waits on other agents' runs of the same
// checkout otherwise). These cases are about the Redis prefix only, so they
// declare slot, namespace and port block as already held (the documented
// handshake a parent uses) and neither queue on the machine nor need a database.
// TEST_SLOT_DIR points at a private directory so no real lock file is touched.
const HELD_ENV = {
  LIAISON_TEST_LOCK_HELD: "1",
  LIAISON_TEST_NS_HELD: "1",
  LIAISON_TEST_PORT_BASE: "59000",
  TEST_SLOT_DIR: path.join(os.tmpdir(), `liaison-redis-prefix-test-${process.pid}`),
}

describe("with-test-lock", () => {
  it("hands the wrapped command a non-empty REDIS_PREFIX", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "scripts/with-test-lock.ts",
        "--",
        "bun",
        "-e",
        'console.log("PREFIX=" + (process.env.REDIS_PREFIX ?? ""))',
      ],
      cwd: ROOT,
      env: { ...process.env, REDIS_PREFIX: "", ...HELD_ENV },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const line = out.split("\n").find((l) => l.startsWith("PREFIX="))
    expect(line).toBeDefined()
    expect(line).not.toBe("PREFIX=")
  }, 30000)

  it("passes an explicit REDIS_PREFIX through untouched", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "scripts/with-test-lock.ts",
        "--",
        "bun",
        "-e",
        'console.log("PREFIX=" + (process.env.REDIS_PREFIX ?? ""))',
      ],
      cwd: ROOT,
      env: { ...process.env, REDIS_PREFIX: "pinned_x:", ...HELD_ENV },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain("PREFIX=pinned_x:")
  }, 30000)
})

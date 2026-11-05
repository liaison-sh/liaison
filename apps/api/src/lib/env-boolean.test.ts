// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, test } from "bun:test"
import { envFlag, parseEnvBoolean } from "~/lib/env-boolean"

describe("parseEnvBoolean", () => {
  test("accepts true/1/yes and false/0/no/empty, case-insensitive", () => {
    for (const raw of ["true", "1", "yes", "TRUE", " Yes "]) expect(parseEnvBoolean(raw)).toBe(true)
    for (const raw of ["false", "0", "no", "False", ""]) expect(parseEnvBoolean(raw)).toBe(false)
  })

  test("unset and unrecognized values are undefined", () => {
    expect(parseEnvBoolean(undefined)).toBeUndefined()
    expect(parseEnvBoolean("on")).toBeUndefined()
    expect(parseEnvBoolean("maybe")).toBeUndefined()
  })
})

describe("envFlag", () => {
  const KEY = "LIAISON_ENV_FLAG_TEST_KEY"
  afterEach(() => {
    delete process.env[KEY]
  })

  test("the string false reads as false", () => {
    process.env[KEY] = "false"
    expect(envFlag(KEY)).toBe(false)
  })

  test("unset takes the fallback", () => {
    expect(envFlag(KEY)).toBe(false)
    expect(envFlag(KEY, true)).toBe(true)
  })
})

describe("boolean env keys are never read by raw truthiness", () => {
  // A direct `process.env.KEY` read of a boolean key re-opens the "false is
  // true" hole (`if (process.env.X)`) or silently disagrees with env.ts
  // (`=== "true"` ignores "1" and "yes"). Such reads go through envFlag.
  test("no production source under apps/api/src reads a boolean env key off process.env", async () => {
    const { readFileSync } = await import("node:fs")
    const { Glob } = await import("bun")
    const root = new URL("..", import.meta.url).pathname
    const envSource = readFileSync(`${root}lib/env.ts`, "utf8")
    const keys = [...envSource.matchAll(/^\s+([A-Z0-9_]+): envBoolean\(/gm)].map((m) => m[1])
    expect(keys.length).toBeGreaterThanOrEqual(8)
    const pattern = new RegExp(`(process|Bun)\\.env(\\.|\\[["'])(${keys.join("|")})\\b`)
    const offenders: string[] = []
    for (const file of new Glob("**/*.ts").scanSync(root)) {
      if (/\.test\.ts$|\.test-fixtures\.ts$|^tests\//.test(file)) continue
      const lines = readFileSync(`${root}${file}`, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (pattern.test(line)) offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

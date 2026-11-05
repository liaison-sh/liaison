// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

const SCRIPT = path.resolve(import.meta.dir, "test-run.ts")

function run(suite: string | undefined, env: Record<string, string>) {
  return spawnSync("bun", suite ? ["run", SCRIPT, suite] : ["run", SCRIPT], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  })
}

test("web-unit suite invokes vitest with bail flag when LIAISON_TEST_BAIL=1", () => {
  const result = run("web-unit", {
    LIAISON_TEST_BAIL: "1",
    LIAISON_TEST_DRY_RUN: "1",
  })
  expect(result.stdout).toContain("vitest")
  expect(result.stdout).toContain("run")
  expect(result.stdout).toContain("--bail=1")
  expect(result.stdout).toContain("cwd: apps/web")
})

test("web-unit dry-run without bail omits the flag", () => {
  const result = run("web-unit", { LIAISON_TEST_DRY_RUN: "1" })
  expect(result.stdout).toContain("vitest")
  expect(result.stdout).not.toContain("--bail=1")
})

test("web-unit appears in suite list when no suite passed", () => {
  const result = run(undefined, {})
  expect(result.stderr).toContain("web-unit")
})

test("unknown suite errors", () => {
  const result = run("not-a-suite", { LIAISON_TEST_DRY_RUN: "1" })
  expect(result.stderr).toContain("Unknown suite")
})

test("playwright suite gets --max-failures=1 when LIAISON_TEST_BAIL=1", () => {
  const result = run("playwright", {
    LIAISON_TEST_BAIL: "1",
    LIAISON_TEST_DRY_RUN: "1",
  })
  expect(result.stdout).toContain("--max-failures=1")
})

function runArgs(args: string[]) {
  return spawnSync("bun", ["run", SCRIPT, ...args], {
    env: { ...process.env, LIAISON_TEST_DRY_RUN: "1" },
    encoding: "utf8",
  })
}

// An argument the parser did not recognise used to be dropped, so a mistyped
// file filter silently ran the whole suite.
test("an unrecognised argument is refused, never run as the whole suite", () => {
  for (const args of [
    ["unit", "--file=src/a.test.ts"],
    ["unit", "src/a.test.ts"],
    ["unit", "--files", "src/a.test.ts"],
  ]) {
    const result = runArgs(args)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Unrecognised argument")
  }
})

test("a --file value holding several paths or a flag is refused", () => {
  for (const args of [
    ["unit", "--file", "src/a.test.ts --file src/b.test.ts"],
    ["unit", "--file", "src/a.test.ts src/b.test.ts"],
    ["unit", "--file", "--test"],
    ["unit", "--file"],
  ]) {
    const result = runArgs(args)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--file takes one path")
  }
})

test("repeated --file flags still pass every path", () => {
  const result = runArgs(["unit", "--file", "src/a.test.ts", "--file", "src/b.test.ts"])
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("src/a.test.ts")
  expect(result.stdout).toContain("src/b.test.ts")
})

test("suite children run with OMG off unless the caller set the flag", () => {
  const { BUN_JSC_useOMGJIT: _unset, ...parent } = process.env
  const byDefault = spawnSync("bun", ["run", SCRIPT, "unit"], {
    env: { ...parent, LIAISON_TEST_DRY_RUN: "1" },
    encoding: "utf8",
  })
  expect(byDefault.stdout).toContain("env: BUN_JSC_useOMGJIT=0")
  const explicit = run("unit", { LIAISON_TEST_DRY_RUN: "1", BUN_JSC_useOMGJIT: "1" })
  expect(explicit.stdout).toContain("env: BUN_JSC_useOMGJIT=1")
})

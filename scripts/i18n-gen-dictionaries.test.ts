// SPDX-License-Identifier: FSL-1.1-ALv2
// I7: adding a locale must be FILE-ONLY. This proves it end-to-end: drop a
// stub locale directory (JSON only, zero code edits), run the generator, and
// observe the stub locale become shipped + its dictionary present. Restores
// the repo state in `finally` so the real _generated.ts is left intact.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const LOCALES = join(ROOT, "packages", "shared", "src", "i18n", "locales")
const GEN = join(LOCALES, "_generated.ts")
const STUB = join(LOCALES, "zz")

function runGen(args: string[] = []) {
  return Bun.spawnSync(["bun", "run", join(ROOT, "scripts", "i18n-gen-dictionaries.ts"), ...args], {
    cwd: ROOT,
  })
}

afterEach(() => {
  if (existsSync(STUB)) rmSync(STUB, { recursive: true, force: true })
  // Restore the canonical generated file (en/fr only).
  runGen()
})

describe("i18n locale generation is file-only (I7)", () => {
  test("dropping locales/zz/*.json + regenerating makes 'zz' shipped — no code edit", () => {
    const before = readFileSync(GEN, "utf8")
    expect(before).not.toContain('"zz"')

    // FILE-ONLY: only a JSON dictionary directory is added.
    mkdirSync(STUB, { recursive: true })
    writeFileSync(join(STUB, "kernel.json"), JSON.stringify({ hello: "Hallo (zz)" }))

    const res = runGen()
    expect(res.exitCode).toBe(0)

    const after = readFileSync(GEN, "utf8")
    expect(after).toContain('GENERATED_LOCALES = ["en", "fr", "zz"]')
    // biome drops the quotes on a plain identifier key (the generator now
    // emits formatter output verbatim).
    expect(after).toContain("zz: {")
    expect(after).toContain('import zz_Kernel from "./zz/kernel.json"')
  })

  test("--check fails when the generated file is stale (CI guard)", () => {
    mkdirSync(STUB, { recursive: true })
    writeFileSync(join(STUB, "kernel.json"), JSON.stringify({ hello: "x" }))
    // _generated.ts still reflects en/fr only → stale.
    const res = runGen(["--check"])
    expect(res.exitCode).toBe(1)
  })

  test("the generator emits what biome formats, so i18n:gen:check can be green", () => {
    expect(runGen().exitCode).toBe(0)
    const biome = join(ROOT, "node_modules", ".bin", "biome")
    const check = Bun.spawnSync([biome, "check", GEN], { cwd: ROOT })
    expect(check.stdout.toString() + check.stderr.toString()).toContain("No fixes applied")
    expect(check.exitCode).toBe(0)
    // And the check the CI runs agrees with the file on disk.
    expect(runGen(["--check"]).exitCode).toBe(0)
  })
})

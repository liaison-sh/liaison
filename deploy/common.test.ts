// SPDX-License-Identifier: FSL-1.1-ALv2
//
// deploy/lib/common.sh's env_get: reads KEY from deploy/.env the way docker
// compose does, so one pair of surrounding quotes is not part of the value.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const COMMON = join(import.meta.dir, "lib", "common.sh")
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function envGet(env: string, key: string): string {
  const dir = mkdtempSync(join(tmpdir(), "liaison-envget-"))
  dirs.push(dir)
  writeFileSync(join(dir, ".env"), env)
  const r = Bun.spawnSync(["bash", "-c", `. "${COMMON}"; env_get "$1"`, "_", key], {
    env: { ...process.env, DEPLOY_DIR: dir, PROJECT_NAME: "t" },
  })
  expect(r.exitCode).toBe(0)
  return r.stdout.toString().replace(/\n$/, "")
}

describe("env_get", () => {
  const env = ["APP_PORT='3001'", 'BASE_URL="https://x"', "PLAIN=3002", "INNER=a'b", "LONE='x", "EMPTYQ=''", ""].join("\n")

  it("strips single and double quotes", () => {
    expect(envGet(env, "APP_PORT")).toBe("3001")
    expect(envGet(env, "BASE_URL")).toBe("https://x")
    expect(envGet(env, "EMPTYQ")).toBe("")
  })

  it("leaves unquoted, inner-quote and unbalanced values unchanged", () => {
    expect(envGet(env, "PLAIN")).toBe("3002")
    expect(envGet(env, "INNER")).toBe("a'b")
    expect(envGet(env, "LONE")).toBe("'x")
  })

  it("is empty for an absent key", () => {
    expect(envGet(env, "NOPE")).toBe("")
  })
})

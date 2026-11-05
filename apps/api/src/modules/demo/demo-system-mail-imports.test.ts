// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo system mail channel is the one way mail leaves a demo box. Only the
// two fixed-template senders may reach it: the verification code and the owner
// alert. A new importer is a new way to mail a stranger, so it fails here.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dir, "../..")
const ALLOWED = new Set([
  "infra/email.ts",
  "modules/demo/demo-verification.ts",
  "modules/demo/demo-alerts.ts",
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (
      /\.tsx?$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      !name.includes("test-fixture")
    ) {
      out.push(full)
    }
  }
  return out
}

describe("demo system mail channel", () => {
  it("is reached only by the verification and alert senders", () => {
    const users = walk(SRC)
      .filter((f) => /getDemoSystemMailProvider/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f))
    for (const file of users) expect(ALLOWED.has(file)).toBe(true)
    expect(users).toContain("modules/demo/demo-verification.ts")
  })
})

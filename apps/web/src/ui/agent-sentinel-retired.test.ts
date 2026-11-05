// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = resolve(__dirname, "..")
const SENTINEL = ["LIAISON", "AGENT", "ID"].join("_")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

describe("agent identity (P4b-T27)", () => {
  it("no source file under apps/web/src imports or references the agent id sentinel", () => {
    const offenders = sourceFiles(SRC).filter((f) => {
      if (f === resolve(__dirname, "agent-sentinel-retired.test.ts")) return false
      return readFileSync(f, "utf8").includes(SENTINEL)
    })
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([])
  })
})

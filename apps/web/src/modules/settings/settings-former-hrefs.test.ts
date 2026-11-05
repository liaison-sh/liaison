// SPDX-License-Identifier: FSL-1.1-ALv2
// L3 (A22): web code links to the new settings paths. A former path keeps
// working through the alias table (settings-aliases.ts), but no link, opener or
// fallback in the product names one.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SETTINGS_ALIAS_PREFIXES, SETTINGS_ALIASES } from "./settings-aliases"

const SRC = resolve(__dirname, "../..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "tests") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

describe("former settings hrefs", () => {
  it("no web source names a former settings path (the alias table alone does)", () => {
    const exact = SETTINGS_ALIASES.map((a) => escapeRegExp(a.from)).join("|")
    const prefixes = SETTINGS_ALIAS_PREFIXES.map((a) => escapeRegExp(a.from)).join("|")
    // A quoted literal that IS a former path (or it followed by ? or #), or that
    // starts with a former path prefix.
    const pattern = new RegExp(`["'\`](?:(?:${exact})["'\`?#]|(?:${prefixes}))`)
    const offenders: string[] = []
    for (const f of sourceFiles(SRC)) {
      if (f.endsWith("settings-aliases.ts")) continue
      const lines = readFileSync(f, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (pattern.test(line)) offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

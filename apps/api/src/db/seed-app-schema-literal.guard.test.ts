// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ratchet: the seed engine's raw SQL never names an app schema literally.
//
// A seed runs under a schema prefix in test lanes and isolated test worlds
// (SCHEMA_PREFIX), where every app schema is `<prefix>app_<name>`. A raw query
// that says `FROM app_calendar.events` reads the unprefixed schema instead: it
// fails when that schema does not exist there, and otherwise reads or writes
// another world's rows. The rule: spell it `${sql.raw(schemaRef("app_<name>"))}`.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const SRC = resolve(import.meta.dir, "..")
const SEED = join(SRC, "seed")

const APP_LITERAL = /\b(?:FROM|INTO|UPDATE|JOIN|ANALYZE)\s+"?app_[a-z_]+"?\./g

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe("seed SQL and the schema prefix", () => {
  it("no seed source names an app schema literally in SQL", () => {
    const hits: string[] = []
    for (const file of sourceFiles(SEED)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (APP_LITERAL.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
        APP_LITERAL.lastIndex = 0
      })
    }
    expect(hits).toEqual([])
  })

  it("the pattern catches a literal app schema and passes a prefixed one", () => {
    const catches = (s: string) => {
      APP_LITERAL.lastIndex = 0
      return APP_LITERAL.test(s)
    }
    expect(catches("sql`SELECT id FROM app_calendar.events`")).toBe(true)
    expect(catches("UPDATE app_tickets.tickets SET")).toBe(true)
    expect(catches('sql`SELECT id FROM ${sql.raw(schemaRef("app_calendar"))}.events`')).toBe(false)
  })
})

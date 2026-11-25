// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Attention goes through the one pipeline: every Home item of the agreements and
// client-portal work comes from a manifest `attention.translations` row or from
// `kernel-translations.ts`, and no notification table exists beside the attention
// store. A new table, or a direct write to the store, fails here.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { kernelTranslations } from "./kernel-translations"

const ROOT = resolve(import.meta.dir, "../../../../..")
const API_SRC = join(ROOT, "apps/api/src")
const AGREEMENTS = join(ROOT, "bundled-apps/agreements")
const MIGRATIONS = join(API_SRC, "db/migrations")

/** A table that would hold notifications, alerts, reminders or read marks of its own. */
const NOTIFICATION_TABLE = /notif|alert|remind|unread|digest|inbox|bell/i

function tablesOfMigrationsFrom(first: number): Array<{ file: string; table: string }> {
  const found: Array<{ file: string; table: string }> = []
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f))) {
    if (Number(file.slice(0, 4)) < first) continue
    const sql = readFileSync(join(MIGRATIONS, file), "utf8")
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([\w."]+)/gi))
      found.push({ file, table: (m[1] as string).replaceAll('"', "") })
  }
  return found
}

function productSources(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.(test|testutil)\.tsx?$/.test(f))
    .map((f) => join(dir, f))
}

describe("attention of the agreements and portal work", () => {
  const manifest = JSON.parse(readFileSync(join(AGREEMENTS, "app.manifest.json"), "utf8")) as {
    schema: Record<string, unknown>
    attention: {
      translations: Array<{
        event: string
        kind: string
        summary: string
        recipients: { kind: string }
      }>
    }
  }

  it("no table of the phase's migrations, and none of the agreements schema, holds notifications", () => {
    const tables = tablesOfMigrationsFrom(329).map((t) => `${t.file}: ${t.table}`)
    expect(tables.length).toBeGreaterThan(5)
    expect(tables.filter((t) => NOTIFICATION_TABLE.test(t.split(": ")[1] as string))).toEqual([])
    expect(Object.keys(manifest.schema).filter((t) => NOTIFICATION_TABLE.test(t))).toEqual([])
  })

  it("every Home row of the agreements app is a manifest translation of its own kind, with a summary and recipients", () => {
    const rows = manifest.attention.translations
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.kind.startsWith("agreements:"), row.kind).toBe(true)
      expect(row.summary.length, row.kind).toBeGreaterThan(0)
      expect(row.recipients.kind, row.kind).toBeTruthy()
    }
    expect(new Set(rows.map((r) => `${r.event} ${r.kind}`)).size).toBe(rows.length)
  })

  it("every kind the agreements code names in a Home row is one of its manifest rows", () => {
    const declared = new Set(manifest.attention.translations.map((r) => r.kind))
    const named = new Set<string>()
    for (const file of productSources(join(AGREEMENTS, "src")).concat(
      join(AGREEMENTS, "handlers.ts"),
    ))
      for (const m of readFileSync(file, "utf8").matchAll(
        /["'`](agreements:[a-z_]+\.[a-z_]+)["'`]/g,
      ))
        named.add(m[1] as string)
    expect([...named].filter((k) => !declared.has(k))).toEqual([])
  })

  it("the client-action Home rows are kernel translations", () => {
    const events = new Set(kernelTranslations.map((t) => t.event))
    for (const event of [
      "client_action:requested",
      "client_action:opened",
      "client_action:decided",
      "client_action:code_locked",
    ])
      expect(events.has(event), event).toBe(true)
  })

  it("no product file of the phase writes the attention store itself", () => {
    const dirs = [
      join(API_SRC, "modules/client-actions"),
      join(API_SRC, "modules/portal"),
      join(API_SRC, "modules/signing"),
      join(API_SRC, "modules/pdf-render"),
      join(AGREEMENTS, "src"),
    ]
    const writers: string[] = []
    for (const file of dirs.flatMap(productSources).concat(join(AGREEMENTS, "handlers.ts"))) {
      const text = readFileSync(file, "utf8")
      if (/(INSERT INTO|UPDATE|DELETE FROM)\s+[\w."]*attention_events/i.test(text))
        writers.push(file.slice(ROOT.length + 1))
    }
    expect(writers).toEqual([])
  })
})

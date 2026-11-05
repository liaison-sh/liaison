// SPDX-License-Identifier: FSL-1.1-ALv2
// The nightly demo reset refuses to run while an org scoped kernel table has no
// rule, and it only finds out against a live database. This reads the
// migrations instead, so a new table fails here rather than on the demo box.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { KERNEL_RESET_RULES } from "~/modules/demo/demo-reset"

const MIGRATIONS = join(import.meta.dir, "../../db/migrations")

function orgScopedKernelTables(): string[] {
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n")
  // One pass in file order: a migration may rename a table and then create a
  // new one under the old name (0140 renames node_sessions to node_connections
  // and creates a new node_sessions), so the order of the statements matters.
  type Step = { at: number; apply: (tables: Set<string>) => void }
  const steps: Step[] = []
  for (const m of sql.matchAll(
    /CREATE TABLE(?: IF NOT EXISTS)? "?kernel"?\."?(\w+)"?\s*\(([\s\S]*?)\n\);/g,
  )) {
    if (/^\s*"?org_id"?\s/m.test(m[2])) steps.push({ at: m.index, apply: (t) => t.add(m[1]) })
  }
  for (const m of sql.matchAll(
    /ALTER TABLE(?: ONLY)? "?kernel"?\."?(\w+)"? ADD COLUMN(?: IF NOT EXISTS)? "?org_id"?\s/g,
  )) {
    steps.push({ at: m.index, apply: (t) => t.add(m[1]) })
  }
  for (const m of sql.matchAll(
    /ALTER TABLE(?: IF EXISTS)? "?kernel"?\."?(\w+)"? RENAME TO "?(\w+)"?/g,
  )) {
    steps.push({
      at: m.index,
      apply: (t) => {
        if (t.delete(m[1])) t.add(m[2])
      },
    })
  }
  for (const m of sql.matchAll(/DROP TABLE(?: IF EXISTS)? "?kernel"?\."?(\w+)"?/g)) {
    steps.push({ at: m.index, apply: (t) => t.delete(m[1]) })
  }
  const tables = new Set<string>()
  for (const step of steps.sort((a, b) => a.at - b.at)) step.apply(tables)
  return [...tables].sort()
}

describe("KERNEL_RESET_RULES", () => {
  it("rules every org scoped kernel table the migrations create", () => {
    const tables = orgScopedKernelTables()
    expect(tables.length).toBeGreaterThan(20)
    expect(tables).toContain("reply_thread_followers")
    expect(tables).toContain("node_connections")
    expect(tables).toContain("node_sessions")
    expect(tables.filter((t) => !(t in KERNEL_RESET_RULES))).toEqual([])
  })
})

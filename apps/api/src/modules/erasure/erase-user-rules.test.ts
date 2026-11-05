// SPDX-License-Identifier: FSL-1.1-ALv2
// Erasing a user refuses to run while a kernel column that can hold a user id
// has no rule, and the live check in erase-user.test.ts needs a database. This
// reads the migrations instead, so a new column fails in CI rather than the
// first time someone who appears in it asks to be erased.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  KERNEL_USER_COLUMN_DISPOSITION,
  KERNEL_USER_COLUMN_NAMES,
} from "~/modules/erasure/erase-user"

const MIGRATIONS = join(import.meta.dir, "../../db/migrations")
const NAMES = new Set<string>(KERNEL_USER_COLUMN_NAMES)
const ID = String.raw`"?(\w+)"?`
const KERNEL = String.raw`"?kernel"?\.`
const USERS_FK = new RegExp(String.raw`REFERENCES\s+${KERNEL}"?users"?\s*\(`, "i")
const USER_TYPES = /^(uuid(\[\])?|jsonb)\b/i

/** A column the live sweep would find: a foreign key to users, or a recognised name of an id type. */
function userColumn(name: string, rest: string): boolean {
  return USERS_FK.test(rest) || (NAMES.has(name) && USER_TYPES.test(rest.trim()))
}

function kernelUserColumns(): string[] {
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n")
  // One pass in file order: tables and columns are renamed and dropped later.
  type Step = { at: number; apply: (cols: Set<string>) => void }
  const steps: Step[] = []
  const add = (at: number, key: string) => steps.push({ at, apply: (c) => c.add(key) })
  for (const m of sql.matchAll(
    new RegExp(String.raw`CREATE TABLE(?: IF NOT EXISTS)? ${KERNEL}${ID}\s*\(([\s\S]*?)\n\);`, "g"),
  )) {
    for (const line of m[2].split("\n")) {
      const col = /^\s*"?(\w+)"?\s+(.*)$/.exec(line)
      if (col && userColumn(col[1], col[2])) add(m.index, `${m[1]}.${col[1]}`)
    }
  }
  for (const m of sql.matchAll(
    new RegExp(
      String.raw`ALTER TABLE(?: ONLY| IF EXISTS)* ${KERNEL}${ID}\s+ADD COLUMN(?: IF NOT EXISTS)? ${ID}\s+([^,;]*)`,
      "g",
    ),
  )) {
    if (userColumn(m[2], m[3])) add(m.index, `${m[1]}.${m[2]}`)
  }
  for (const m of sql.matchAll(
    new RegExp(
      String.raw`ALTER TABLE(?: ONLY| IF EXISTS)* ${KERNEL}${ID}\s+ADD CONSTRAINT ${ID}\s+FOREIGN KEY\s*\(${ID}\)\s*REFERENCES\s+${KERNEL}"?users"?\s*\(`,
      "g",
    ),
  )) {
    add(m.index, `${m[1]}.${m[3]}`)
  }
  for (const m of sql.matchAll(
    new RegExp(String.raw`ALTER TABLE(?: ONLY| IF EXISTS)* ${KERNEL}${ID}\s+RENAME TO ${ID}`, "g"),
  )) {
    steps.push({
      at: m.index,
      apply: (c) => {
        for (const key of [...c]) {
          if (!key.startsWith(`${m[1]}.`)) continue
          c.delete(key)
          c.add(`${m[2]}.${key.slice(m[1].length + 1)}`)
        }
      },
    })
  }
  for (const m of sql.matchAll(
    new RegExp(
      String.raw`ALTER TABLE(?: ONLY| IF EXISTS)* ${KERNEL}${ID}\s+RENAME COLUMN ${ID}\s+TO ${ID}`,
      "g",
    ),
  )) {
    steps.push({
      at: m.index,
      apply: (c) => {
        if (c.delete(`${m[1]}.${m[2]}`)) c.add(`${m[1]}.${m[3]}`)
      },
    })
  }
  for (const m of sql.matchAll(
    new RegExp(
      String.raw`ALTER TABLE(?: ONLY| IF EXISTS)* ${KERNEL}${ID}\s+DROP COLUMN(?: IF EXISTS)? ${ID}`,
      "g",
    ),
  )) {
    steps.push({ at: m.index, apply: (c) => c.delete(`${m[1]}.${m[2]}`) })
  }
  for (const m of sql.matchAll(new RegExp(`DROP TABLE(?: IF EXISTS)? ${KERNEL}${ID}`, "g"))) {
    steps.push({
      at: m.index,
      apply: (c) => {
        for (const key of [...c]) if (key.startsWith(`${m[1]}.`)) c.delete(key)
      },
    })
  }
  const cols = new Set<string>()
  for (const step of steps.sort((a, b) => a.at - b.at)) step.apply(cols)
  return [...cols].sort()
}

describe("KERNEL_USER_COLUMN_DISPOSITION", () => {
  it("rules every kernel user column the migrations create", () => {
    const columns = kernelUserColumns()
    expect(columns.length).toBeGreaterThan(50)
    expect(columns).toContain("secret_requests.completed_by")
    expect(columns).toContain("app_activation_events.actor_id")
    expect(columns.filter((c) => !(c in KERNEL_USER_COLUMN_DISPOSITION))).toEqual([])
  })
})

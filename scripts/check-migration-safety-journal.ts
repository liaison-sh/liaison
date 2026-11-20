// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The drizzle journal's numbering, checked as the migrator reads it.
//
// Drizzle applies a journal entry only when the newest `created_at` already in
// `drizzle.__drizzle_migrations` is below the entry's `when`. Two consequences:
//   - inside one journal, `when` must climb strictly, or an entry is skipped;
//   - when a long-lived branch merges the default branch, every migration the
//     branch adds must carry a `when` above the newest `when` the default branch
//     ships. An instance that already ran the default branch's newest migration
//     would otherwise skip the branch's entry in silence, even when the file
//     name sorts after it.
// File names follow the journal: from the migration-safety baseline on, the
// number prefix climbs with `idx`, so two branches that both took the next free
// number are caught here rather than on a live database. Older entries keep the
// numbers they were applied under (two early merges reused numbers, and applied
// migrations are never renamed).
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface JournalEntry {
  idx: number
  when: number
  tag: string
}

const TAG = /^(\d{4})_[a-z0-9_]+$/

/**
 * Every way the journal and the migration folder disagree: `when` not strictly
 * increasing, `idx` not climbing by one, a tag off the `NNNN_name` form, a
 * number prefix reused or out of order after `numberedAfterIdx`, a listed tag
 * with no `.sql`, a `.sql` the journal does not list, and a paired
 * `NNNN_name.test.ts` naming no tag.
 */
export function journalOrderProblems(
  entries: JournalEntry[],
  files: string[],
  numberedAfterIdx = -1,
): string[] {
  const out: string[] = []
  const tags = new Set(entries.map((e) => e.tag))
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const m = TAG.exec(e.tag)
    if (!m) out.push(`${e.tag}: the tag is not of the form NNNN_name`)
    if (i === 0) continue
    const prev = entries[i - 1]
    if (e.when <= prev.when)
      out.push(`${e.tag}: when ${e.when} is not above ${prev.tag}'s ${prev.when}`)
    if (e.idx !== prev.idx + 1) out.push(`${e.tag}: idx ${e.idx} follows idx ${prev.idx}`)
    const pm = TAG.exec(prev.tag)
    if (m && pm && prev.idx >= numberedAfterIdx && Number(m[1]) <= Number(pm[1]))
      out.push(`${e.tag}: its number does not climb after ${prev.tag}`)
  }
  const sql = new Set(files.filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4)))
  for (const t of tags) if (!sql.has(t)) out.push(`${t}: the journal lists it but no .sql exists`)
  for (const f of [...sql].sort()) if (!tags.has(f)) out.push(`${f}.sql: no journal entry lists it`)
  for (const f of files.sort()) {
    const paired = /^(\d{4}_[a-z0-9_]+)\.test\.ts$/.exec(f)
    if (paired && !tags.has(paired[1]))
      out.push(`${f}: names a migration the journal does not list`)
  }
  return out
}

/**
 * The entries this journal adds over `main`'s whose `when` is not above the
 * newest `when` on `main`, and any `main` entry this journal dropped or
 * re-dated. Empty when the branch carries nothing of its own.
 */
export function branchWhenProblems(branch: JournalEntry[], main: JournalEntry[]): string[] {
  const out: string[] = []
  const mainByTag = new Map(main.map((e) => [e.tag, e]))
  const branchByTag = new Map(branch.map((e) => [e.tag, e]))
  for (const e of main) {
    const b = branchByTag.get(e.tag)
    if (!b) out.push(`${e.tag}: on main but missing here`)
    else if (b.when !== e.when) out.push(`${e.tag}: when ${b.when} here, ${e.when} on main`)
  }
  const newestMain = Math.max(...main.map((e) => e.when))
  for (const e of branch)
    if (!mainByTag.has(e.tag) && e.when <= newestMain)
      out.push(`${e.tag}: when ${e.when} is not above main's newest ${newestMain}`)
  return out
}

export const MIGRATIONS_DIR = "apps/api/src/db/migrations"
const JOURNAL = `${MIGRATIONS_DIR}/meta/_journal.json`

/** The journal idx the migration-safety check starts after (`scripts/migration-safety-baseline.json`). */
export function safetyBaselineIdx(root: string): number {
  return (
    JSON.parse(readFileSync(join(root, "scripts/migration-safety-baseline.json"), "utf8")) as {
      afterIdx: number
    }
  ).afterIdx
}

export function readJournal(root: string): JournalEntry[] {
  return (JSON.parse(readFileSync(join(root, JOURNAL), "utf8")) as { entries: JournalEntry[] })
    .entries
}

export function migrationFiles(root: string): string[] {
  return readdirSync(join(root, MIGRATIONS_DIR))
}

/** `main`'s journal from git (`ref` defaults to origin/main), or null when the ref is absent. */
export function readMainJournal(root: string, ref = "origin/main"): JournalEntry[] | null {
  try {
    const raw = execFileSync("git", ["show", `${ref}:${JOURNAL}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
    return (JSON.parse(raw) as { entries: JournalEntry[] }).entries
  } catch {
    return null
  }
}

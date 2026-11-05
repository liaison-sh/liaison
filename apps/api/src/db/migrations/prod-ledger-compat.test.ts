// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Production compatibility of the journal's numbering.
//
// Drizzle's migrator reads ONE highwater row from drizzle.__drizzle_migrations
// (`order by created_at desc limit 1`) and then applies a journal entry only
// when `Number(lastDbMigration.created_at) < migration.folderMillis`. The
// highwater is captured BEFORE the loop, so every entry whose `when` sits at or
// below the highest `when` already applied is skipped SILENTLY.
//
// The agents epic was developed on a long-lived branch while main kept
// appending to the same incremental `when` band, so the two lines of work
// handed out the SAME slots to DIFFERENT SQL. A production database that had
// run main's entries carried a ledger highwater that swallowed the head of the
// epic's block: the migrator reported nothing to do for those tags and then
// died on the first entry above the highwater, whose SQL referenced tables the
// skipped entries were supposed to create.
//
// The fix is numbering, not SQL: the epic's entries live in a far-future block
// that the incremental band cannot reach. Since the delivery merge the journal
// is one line again, so the production ledger this test models is the journal
// itself below the block floor: every entry a production database has run sits
// under the floor, and every epic entry sits above it. The agents-migration
// runbook checks the real ledger's row count and highwater against the same
// two numbers before a run.
import { describe, expect, it } from "bun:test"
import journal from "./meta/_journal.json"

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

/**
 * The epic's own entries, in journal order: the block runs from
 * `EPIC_FIRST_TAG` to the journal's last entry. Every migration since the
 * delivery merge is appended to the block, so its end is read from the
 * journal rather than written here: a hand-written end went stale with each
 * migration that landed after it, and left that tail of the journal outside
 * the checks below until someone moved it.
 */
const EPIC_FIRST_TAG = "0045_kernel_agents"

/**
 * The floor of the far-future block this epic's entries must live in. main's
 * incremental band runs at 19000000xx000 and gains one 1000-wide slot per
 * migration; it would need ~970 more migrations to reach this floor.
 */
const EPIC_BLOCK_FLOOR = 1_900_001_000_000

const entries = journal.entries as JournalEntry[]

/** The journal's last entry: where the epic block ends. */
const EPIC_LAST_TAG = (entries[entries.length - 1] as JournalEntry).tag

/**
 * The entries a production database has run: everything in the incremental
 * band under the block floor. The runbook checks the real ledger against this
 * set's size and highwater before every migration run.
 */
function preEpicEntries(): JournalEntry[] {
  return entries.filter((e) => e.when < EPIC_BLOCK_FLOOR)
}

/**
 * Drizzle's own rule, reproduced: given the ledger's highwater `created_at`,
 * the entries the migrator will actually apply, in journal order.
 */
function pendingTags(ledgerHighwater: number): string[] {
  return entries.filter((e) => ledgerHighwater < e.when).map((e) => e.tag)
}

function epicTags(): string[] {
  const first = entries.findIndex((e) => e.tag === EPIC_FIRST_TAG)
  const last = entries.findIndex((e) => e.tag === EPIC_LAST_TAG)
  expect(first).toBeGreaterThan(-1)
  expect(last).toBeGreaterThan(-1)
  return entries.slice(first, last + 1).map((e) => e.tag)
}

describe("journal vs a production ledger that has run the incremental band", () => {
  it("finds a ledger highwater inside the incremental band, with every pre-epic entry under it", () => {
    const main = preEpicEntries()
    expect(main.length).toBeGreaterThan(40)
    const highwater = Math.max(...main.map((e) => e.when))
    expect(highwater).toBeLessThan(EPIC_BLOCK_FLOOR)
    // Nothing outside the epic block may sit above the floor: an entry added
    // there by a later branch would be skipped by every database that has
    // already run the block.
    const epic = new Set(epicTags())
    const strays = entries.filter((e) => !epic.has(e.tag) && e.when >= EPIC_BLOCK_FLOOR)
    expect(strays.map((e) => e.tag)).toEqual([])
  })

  it("runs the epic block from kernel_agents to the end of the journal, so no later entry goes unchecked", () => {
    // Every entry from the block's first to the journal's last is in the
    // block: the checks on the block (above the floor, pending against the
    // ledger) see every migration that lands after it.
    const first = entries.findIndex((e) => e.tag === EPIC_FIRST_TAG)
    expect(epicTags()).toEqual(entries.slice(first).map((e) => e.tag))
  })

  it("keeps when strictly increasing in journal order, so a later entry is never under the highwater", () => {
    // A database that has run the whole block holds the block's last when as
    // its highwater. An entry appended with a smaller when would pass every
    // other check here and still be skipped by that database, silently.
    const regressions = entries
      .slice(1)
      .filter((e, i) => e.when <= (entries[i] as JournalEntry).when)
      .map((e) => `${e.tag}@${e.when}`)
    expect(regressions).toEqual([])
  })

  it("leaves every epic migration pending against that ledger, in order", () => {
    const main = preEpicEntries()
    const highwater = Math.max(...main.map((e) => e.when))
    expect(pendingTags(highwater)).toEqual(epicTags())
  })

  it("keeps kernel_agents pending, so the tables the rest of the epic needs get created", () => {
    const main = preEpicEntries()
    const highwater = Math.max(...main.map((e) => e.when))
    expect(pendingTags(highwater)).toContain(EPIC_FIRST_TAG)
  })

  it("gives the epic a when block main's incremental slots cannot collide with", () => {
    const epic = new Set(epicTags())
    const below = entries.filter((e) => epic.has(e.tag) && e.when < EPIC_BLOCK_FLOOR)
    expect(below.map((e) => `${e.tag}@${e.when}`)).toEqual([])
  })

  it("hands out every when value once, so no entry can shadow another", () => {
    const byWhen = new Map<number, string>()
    const collisions: string[] = []
    for (const e of entries) {
      const other = byWhen.get(e.when)
      if (other) collisions.push(`${e.tag}@${e.when} collides with ${other}`)
      byWhen.set(e.when, e.tag)
    }
    expect(collisions).toEqual([])
  })
})

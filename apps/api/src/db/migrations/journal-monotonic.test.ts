// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Drizzle's migrator reads ONE highwater row from drizzle.__drizzle_migrations
// (`order by created_at desc limit 1`) and then applies a migration only when
// `Number(lastDbMigration.created_at) < migration.folderMillis`. That single
// comparison is made against the highwater captured BEFORE the loop, so any
// journal entry whose `when` is at or below the highest `when` already applied
// on a live database is skipped SILENTLY: no error, no log, and the app boots
// believing its schema is current.
//
// A branch that lands migrations with `when` values below an already-deployed
// entry therefore ships a database that is missing tables while every code
// path assumes they exist. This test makes that unshippable: `when` must be
// strictly increasing along the journal's own order, which is also the order
// the migrator applies them in.

import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import journal from "./meta/_journal.json"

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

const entries = journal.entries as JournalEntry[]

// The epic's migrations live in a block far above the incremental band `main`
// keeps appending to, so a production ledger holding main's rows can never
// carry a highwater that swallows one of them.
const EPIC_BLOCK_FLOOR = 1_900_001_000_000

function entry(idx: number, when: number, tag: string): JournalEntry {
  return { idx, version: "7", when, tag, breakpoints: true }
}

// Every offending entry in a journal, derived from the journal itself: the epic
// block is the tail from `0045_kernel_agents` to the end, so nothing in it may
// sit below the floor, and nothing before it may sit at or above the floor.
// Deriving the end of the block, rather than anchoring it to whichever tag was
// last when the guard was written, is what keeps a newly appended entry covered.
function epicBlockOffenders(all: JournalEntry[]): string[] {
  const first = all.findIndex((e) => e.tag === "0045_kernel_agents")
  if (first < 0) return ["0045_kernel_agents is missing from the journal"]
  const describeEntry = (e: JournalEntry) => `${e.tag}@${e.when}`
  return [
    ...all
      .slice(0, first)
      .filter((e) => e.when >= EPIC_BLOCK_FLOOR)
      .map(describeEntry),
    ...all
      .slice(first)
      .filter((e) => e.when < EPIC_BLOCK_FLOOR)
      .map(describeEntry),
  ]
}

/**
 * WHAT NEITHER NEIGHBOUR CHECK SEES: AN ENTRY INSERTED INSIDE THE BLOCK.
 *
 * Strictly increasing `when` is a statement about NEIGHBOURS, so an entry
 * hand placed between two existing ones with a `when` strictly between theirs
 * satisfies it, keeps `idx` contiguous once the file is renumbered, and sits
 * inside the epic block, above the floor. Every rule above passes. On a
 * database whose ledger highwater is already the block's last entry, drizzle's
 * one row comparison (`created_at < folderMillis`) then skips it in silence,
 * which is the whole hazard this file exists to make unshippable.
 *
 * The file alone cannot tell an inserted entry from one that was always there,
 * so the rule needs a BASELINE: the entries as reviewed at this commit, frozen
 * as a digest, plus the highest `when` among them. Anything already in the
 * baseline must still be there, at the same idx and the same `when`; anything
 * new must sort strictly above every baseline entry, which is what "append"
 * means. A legitimate new migration touches the digest not at all, only the
 * count, so keeping this current is one constant per landed migration.
 */
export interface JournalBaseline {
  /** How many entries the baseline covers, from the head of the journal. */
  count: number
  /** sha256 of `idx:when:tag` for those entries, in file order. */
  digest: string
  /** The highest `when` among them: every later entry must sort above it. */
  highwater: number
}

/** The journal as reviewed on this branch. Bump `count` when a migration lands. */
export const REVIEWED_BASELINE: JournalBaseline = {
  count: 97,
  digest: "111710a9047ba91a8816b3d1cb9eafa3fd679da3807bb191a2e67ee57e9148f6",
  highwater: 1_900_001_048_000,
}

export function baselineDigest(all: JournalEntry[]): string {
  return createHash("sha256")
    .update(all.map((e) => `${e.idx}:${e.when}:${e.tag}`).join("\n"))
    .digest("hex")
}

/** Every way `all` departs from `baseline`, in words an operator can act on. */
export function baselineOffenders(all: JournalEntry[], baseline: JournalBaseline): string[] {
  const out: string[] = []
  if (all.length < baseline.count) {
    out.push(`the journal lost entries: ${all.length} of a reviewed ${baseline.count}`)
    return out
  }
  const head = all.slice(0, baseline.count)
  if (baselineDigest(head) !== baseline.digest) {
    out.push(
      "the reviewed entries changed: one was inserted, renumbered or re dated. A migration is appended at the end of the journal with a `when` above every entry already there, never placed among them",
    )
  }
  for (const e of all.slice(baseline.count)) {
    if (e.when <= baseline.highwater) {
      out.push(`${e.tag}@${e.when} does not sort above the reviewed highwater`)
    }
  }
  return out
}

describe("migration journal", () => {
  it("has at least the mailbox encryption migrations", () => {
    expect(entries.length).toBeGreaterThan(40)
  })

  it("orders entries by idx", () => {
    const idxs = entries.map((e) => e.idx)
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b))
  })

  it("has strictly increasing when values in journal order", () => {
    const offenders: string[] = []
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]
      const cur = entries[i]
      if (!(cur.when > prev.when)) {
        offenders.push(
          `${cur.tag} (when=${cur.when}) does not sort after ${prev.tag} (when=${prev.when})`,
        )
      }
    }
    expect(offenders).toEqual([])
  })

  it("keeps every mailbox migration above the last shipped non-mailbox migration", () => {
    // 0038_home_card_layout shipped in b769c529 and is deployed. Anything the
    // mailbox encryption work adds must sort strictly after it or the migrator
    // will skip it on every database that already ran 0038.
    const shipped = entries.find((e) => e.tag === "0038_home_card_layout")
    expect(shipped).toBeDefined()
    const mailboxTags = entries.filter(
      (e) =>
        e.tag.includes("mailbox") ||
        e.tag === "0035_drafts_plaintext_nullable" ||
        e.tag === "0039_files_encryption_columns",
    )
    expect(mailboxTags.length).toBeGreaterThan(0)
    const below = mailboxTags.filter((e) => e.when <= (shipped as JournalEntry).when)
    expect(below.map((e) => e.tag)).toEqual([])
  })

  it("keeps the agents epic out of the incremental band main keeps appending to", () => {
    // `main` hands out the next 19000000xx000 slot to each migration it lands.
    // This branch forked from that band, so any epic entry left inside it is a
    // slot main can (and did) reuse for different SQL: on a production ledger
    // carrying main's rows, the migrator skips the epic entry as already
    // applied. The epic's block starts here instead, far above anything main's
    // one-slot-per-migration counter can reach.
    //
    // The range is DERIVED, never anchored to a tag. An earlier revision of this
    // test pinned the end of the block at `0083_agent_memory_path_backfill`,
    // which was the last epic tag on the day it was written; every entry landed
    // after that one went unchecked. The block is the journal's tail from
    // `0045_kernel_agents` onward, so a new entry appended in the wrong band is
    // covered the moment it lands.
    expect(epicBlockOffenders(entries)).toEqual([])
  })

  it("reports an entry appended to the epic block in the wrong band", () => {
    // The falsifiable half of the rule above, on a synthetic journal shaped
    // like the real one: main's incremental band, then the epic block, then one
    // more epic entry that slipped back into main's band. A tag anchored range
    // cannot see this entry, because it sits after the anchor; the derived
    // range does.
    const drifted: JournalEntry[] = [
      entry(0, 1_900_000_028_000, "0044_shared_with_main"),
      entry(1, 1_900_000_029_000, "0045_mains_own_slot"),
      entry(2, EPIC_BLOCK_FLOOR, "0045_kernel_agents"),
      entry(3, EPIC_BLOCK_FLOOR + 1000, "0083_agent_memory_path_backfill"),
      entry(4, 1_900_000_030_000, "0091_agent_local_claim_holder"),
    ]
    expect(epicBlockOffenders(drifted)).toEqual(["0091_agent_local_claim_holder@1900000030000"])
  })

  it("reports an epic band value used before the block starts", () => {
    // The other direction: the block has to be a contiguous tail. A far future
    // `when` handed to an entry that sorts before `0045_kernel_agents` puts a
    // migration above the floor where main's counter cannot follow it, and
    // leaves the entries between it and the block unreachable.
    const early: JournalEntry[] = [
      entry(0, EPIC_BLOCK_FLOOR - 1000, "0044_shared_with_main"),
      entry(1, EPIC_BLOCK_FLOOR + 500, "0045_mains_own_slot"),
      entry(2, EPIC_BLOCK_FLOOR + 1000, "0045_kernel_agents"),
    ]
    expect(epicBlockOffenders(early)).toEqual(["0045_mains_own_slot@1900001000500"])
  })

  it("carries main's two merged slots below the epic block floor", () => {
    // Section 0 of the agents-migration runbook: main's post fork entries
    // are concatenated at their own idx and their own `when`, never renumbered
    // and never lifted into the far future block.
    const merged = entries.filter(
      (e) =>
        e.tag === "0045_invoicing_po_number" || e.tag === "0046_tickets_inboxes_default_invariant",
    )
    expect(merged.map((e) => e.tag)).toEqual([
      "0045_invoicing_po_number",
      "0046_tickets_inboxes_default_invariant",
    ])
    expect(merged.filter((e) => e.when >= EPIC_BLOCK_FLOOR)).toEqual([])
    const epicStart = entries.findIndex((e) => e.tag === "0045_kernel_agents")
    expect(merged.every((e) => entries.indexOf(e) < epicStart)).toBe(true)
  })

  it("increases idx by one along the file, so nothing was renumbered around an insert", () => {
    const offenders: string[] = []
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].idx !== entries[i - 1].idx + 1) {
        offenders.push(`${entries[i].tag} has idx ${entries[i].idx} after ${entries[i - 1].idx}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("starts the epic block above every when main handed out before it", () => {
    const first = entries.findIndex((e) => e.tag === "0045_kernel_agents")
    expect(first).toBeGreaterThan(0)
    const lastMainWhen = Math.max(...entries.slice(0, first).map((e) => e.when))
    const firstEpicWhen = Math.min(...entries.slice(first).map((e) => e.when))
    expect(firstEpicWhen).toBeGreaterThan(lastMainWhen)
  })

  it("holds the reviewed entries unchanged and appends anything new above them", () => {
    expect(baselineOffenders(entries, REVIEWED_BASELINE)).toEqual([])
  })

  it("reports an entry inserted between two entries of the block", () => {
    // The case every neighbour rule above passes: `when` strictly between its
    // two neighbours, idx contiguous, inside the block and above the floor.
    const reviewed: JournalEntry[] = [
      entry(0, EPIC_BLOCK_FLOOR, "0045_kernel_agents"),
      entry(1, EPIC_BLOCK_FLOOR + 2000, "0046_agent_memory"),
      entry(2, EPIC_BLOCK_FLOOR + 4000, "0047_agent_local_claims"),
    ]
    const baseline: JournalBaseline = {
      count: reviewed.length,
      digest: baselineDigest(reviewed),
      highwater: EPIC_BLOCK_FLOOR + 4000,
    }
    const inserted: JournalEntry[] = [
      reviewed[0],
      entry(1, EPIC_BLOCK_FLOOR + 1000, "0046_wedged_between"),
      entry(2, reviewed[1].when, reviewed[1].tag),
      entry(3, reviewed[2].when, reviewed[2].tag),
    ]
    // Neither neighbour rule sees it: `when` still climbs, idx still climbs.
    expect(inserted.every((e, i) => i === 0 || e.when > inserted[i - 1].when)).toBe(true)
    expect(epicBlockOffenders(inserted)).toEqual([])
    // The insertion shifts the block's own tail past the reviewed count, so the
    // rule names both what it sees: the head no longer matches, and an entry the
    // baseline already carried now reads as a new one that fails to sort above
    // the highwater. Either line alone is a refusal.
    expect(baselineOffenders(inserted, baseline)).toEqual([
      "the reviewed entries changed: one was inserted, renumbered or re dated. A migration is appended at the end of the journal with a `when` above every entry already there, never placed among them",
      `0047_agent_local_claims@${EPIC_BLOCK_FLOOR + 4000} does not sort above the reviewed highwater`,
    ])
  })

  it("accepts a migration appended above the reviewed highwater", () => {
    const reviewed: JournalEntry[] = [
      entry(0, EPIC_BLOCK_FLOOR, "0045_kernel_agents"),
      entry(1, EPIC_BLOCK_FLOOR + 2000, "0046_agent_memory"),
    ]
    const baseline: JournalBaseline = {
      count: reviewed.length,
      digest: baselineDigest(reviewed),
      highwater: EPIC_BLOCK_FLOOR + 2000,
    }
    const appended = [...reviewed, entry(2, EPIC_BLOCK_FLOOR + 3000, "0047_landed_today")]
    expect(baselineOffenders(appended, baseline)).toEqual([])
    // And the same entry given a slot inside the block is refused.
    const backdated = [...reviewed, entry(2, EPIC_BLOCK_FLOOR + 1000, "0047_landed_today")]
    expect(baselineOffenders(backdated, baseline)).toEqual([
      `0047_landed_today@${EPIC_BLOCK_FLOOR + 1000} does not sort above the reviewed highwater`,
    ])
  })

  // A journal that ends mid line makes every later diff on it read as two
  // changes rather than one: the entry that was added, and the line that was
  // never terminated.
  it("ends with a newline, so appending one entry is a one line diff", async () => {
    const raw = await Bun.file(new URL("./meta/_journal.json", import.meta.url).pathname).text()
    expect(raw.endsWith("\n")).toBe(true)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// Which closed tasks of invoiced periods are late work, from the cards alone.
import { describe, expect, it } from "bun:test"
import {
  type BilledCard,
  claimMonth,
  coveredByCard,
  inRetainerMonth,
  lateClosedTasks,
} from "./late-work"

const card = (over: Partial<BilledCard> = {}): BilledCard => ({
  id: "c1",
  basis: "daily",
  from: "2026-09-01",
  to: "2026-09-30",
  draftedOn: "2026-09-05",
  draftedAt: "2026-09-05 09:00:00+00",
  lateOnly: false,
  listed: new Set(),
  excluded: new Set(),
  excludedUnknown: false,
  ...over,
})
const task = (id: string, on: string | null, archived = false) => ({
  id,
  archived,
  completed_on: on,
  completed_at: on ? `${on} 10:00:00+00` : null,
})
const late = (cards: BilledCard[], tasks: ReturnType<typeof task>[], claimed: string[] = []) =>
  lateClosedTasks(cards, tasks, new Set(claimed), "2026-11-01")

describe("late closed tasks", () => {
  it("are the closed tasks of invoiced periods, and of the days between two of them, nothing holds", () => {
    const cards = [card(), card({ id: "c2", from: "2026-10-10", to: "2026-10-31" })]
    expect(
      late(
        cards,
        [
          task("in", "2026-09-20"),
          task("between", "2026-10-03"),
          task("before", "2026-08-31"),
          task("after", "2026-11-01"),
          task("open", null),
          task("archived", "2026-09-20", true),
          task("claimed", "2026-09-20"),
        ],
        ["claimed"],
      ),
    ).toEqual(["in", "between"])
    expect(late([], [task("in", "2026-09-20")])).toEqual([])
  })

  it("are not the tasks the period's card lists or left out", () => {
    const c = card({ listed: new Set(["l"]), excluded: new Set(["x"]) })
    expect(late([c], [task("l", "2026-09-20"), task("x", "2026-09-20")])).toEqual([])
  })

  it("of a card that kept only a count of what it left out are the ones closed after it", () => {
    const c = card({ excludedUnknown: true })
    expect(late([c], [task("old", "2026-09-04"), task("new", "2026-09-06")])).toEqual(["new"])
  })

  it("are not what any card left out, its own period's or a later one's", () => {
    const own = card()
    const later = card({
      id: "c2",
      from: "2026-10-01",
      to: "2026-10-31",
      excluded: new Set(["x"]),
    })
    expect(late([own, later], [task("x", "2026-09-20"), task("y", "2026-09-20")])).toEqual(["y"])
  })

  it("are never inside a month a retainer was invoiced for", () => {
    const fee = card({ basis: "retainer" })
    expect(late([fee], [task("in", "2026-09-20")])).toEqual([])
    const around = [
      card({ id: "a", from: "2026-08-01", to: "2026-08-31" }),
      fee,
      card({ id: "b", from: "2026-10-01", to: "2026-10-31", basis: "hourly" }),
    ]
    expect(
      late(around, [
        task("fee", "2026-09-20"),
        task("aug", "2026-08-20"),
        task("oct", "2026-10-20"),
      ]),
    ).toEqual(["aug", "oct"])
    // A retainer's card that billed an earlier month's hours alone bills no month of its own.
    const alone = card({ basis: "retainer", lateOnly: true })
    expect(inRetainerMonth([alone], "2026-09-20")).toBe(false)
    expect(inRetainerMonth([fee], "2026-09-30")).toBe(true)
    expect(inRetainerMonth([fee], "2026-10-01")).toBe(false)
  })

  it("of a fixed price, or of no basis, are none", () => {
    for (const basis of ["fixed", "none"])
      expect(late([card({ basis })], [task("in", "2026-09-20")])).toEqual([])
  })

  it("are covered by a card of their day, or on days no card covers", () => {
    const cards = [card(), card({ id: "c2", from: "2026-10-10", to: "2026-10-31" })]
    expect(["2026-09-01", "2026-09-30", "2026-10-03"].map((d) => coveredByCard(cards, d))).toEqual([
      true,
      true,
      false,
    ])
  })

  it("a later claim of a month is that month's", () => {
    expect([claimMonth("2026-09"), claimMonth("2026-09+2")]).toEqual(["2026-09", "2026-09"])
  })
})

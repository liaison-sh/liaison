// SPDX-License-Identifier: FSL-1.1-ALv2
// Which closed tasks of invoiced periods are late work, from the cards alone.
import { describe, expect, it } from "bun:test"
import { type BilledCard, claimMonth, lateClosedTasks } from "./late-work"

const card = (over: Partial<BilledCard> = {}): BilledCard => ({
  id: "c1",
  basis: "daily",
  from: "2026-09-01",
  to: "2026-09-30",
  draftedOn: "2026-09-05",
  draftedAt: "2026-09-05 09:00:00+00",
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

  it("a later claim of a month is that month's", () => {
    expect([claimMonth("2026-09"), claimMonth("2026-09+2")]).toEqual(["2026-09", "2026-09"])
  })
})

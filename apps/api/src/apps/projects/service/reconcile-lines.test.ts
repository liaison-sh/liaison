// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pure rules of a reconcile: the period an ask means, a line that carries no figure, the
// default bill, the estimate rule, proof labels and links, and what a line may not say.

import { describe, expect, it } from "bun:test"
import type { BudgetTask } from "./coverage"
import {
  computeLines,
  defaultBill,
  keptProofUrl,
  lateNote,
  NO_PLAN_TAG,
  namedMember,
  OTHER_LINE_NAME,
  proofLabel,
  RECONCILE_LINES_MAX,
  readProposedLines,
  repoHostsOf,
  resolvePeriod,
} from "./reconcile-lines"
import { ProjectsServiceError } from "./statuses"

const HPD = 420
const day = (d: number) => d * HPD

function task(id: string, timebox: number | null, parentId: string | null = null): BudgetTask {
  return {
    id,
    parentId,
    name: id,
    position: 0,
    number: 0,
    timebox,
    isMilestone: false,
    archived: false,
    closed: true,
    started: true,
  }
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (err) {
    return err instanceof ProjectsServiceError ? err.code : String(err)
  }
}

describe("the period an ask means", () => {
  it("a month reads from its first to its last day, February of a leap year included", () => {
    expect(resolvePeriod({ month: "2026-10" }, "2026-11-10")).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-31",
      label: "October 2026",
      month: "2026-10",
    })
    expect(resolvePeriod({ month: "2028-02" }, "2028-03-01").to).toBe("2028-02-29")
  })

  it("no month reads the month of today, on both sides of a year end", () => {
    expect(resolvePeriod({}, "2026-12-31").month).toBe("2026-12")
    expect(resolvePeriod({}, "2027-01-01").month).toBe("2027-01")
  })

  it("from and to give their own range, a whole month reads as that month", () => {
    expect(resolvePeriod({ from: "2026-10-05", to: "2026-10-20" }, "2026-11-10").label).toBe(
      "5 Oct 2026 to 20 Oct 2026",
    )
    expect(resolvePeriod({ from: "2026-11-01", to: "2026-11-30" }, "2026-12-01").month).toBe(
      "2026-11",
    )
  })

  it("a wrong or mixed form is refused", () => {
    expect(codeOf(() => resolvePeriod({ month: "2026-13" }, "2026-11-10"))).toBe("invalid_period")
    expect(codeOf(() => resolvePeriod({ from: "2026-10-05" }, "2026-11-10"))).toBe("invalid_period")
    expect(
      codeOf(() => resolvePeriod({ month: "2026-10", from: "2026-10-01", to: "2026-10-02" }, "x")),
    ).toBe("invalid_period")
    expect(codeOf(() => resolvePeriod({ from: "2026-10-20", to: "2026-10-05" }, "x"))).toBe(
      "invalid_period",
    )
  })

  it("a late ask says when the invoice should have issued", () => {
    expect(lateNote(resolvePeriod({ month: "2026-10" }, "2026-11-10"))).toBe(
      "October's invoice should have issued by 31 Oct. It issues with today's date, since invoice dates in a series never go back. Ask your accountant whether anything else is needed.",
    )
  })
})

describe("what a line may carry", () => {
  it("a line carrying a planned, real or bill figure is refused whole", () => {
    for (const figure of ["planned", "real", "bill", "plannedMinutes", "amount"]) {
      expect(
        codeOf(() =>
          readProposedLines([{ name: "Export", kind: "planned", taskIds: [], [figure]: 100 }]),
        ),
      ).toBe("invalid_params")
    }
    expect(
      readProposedLines([{ name: "Export", kind: "planned", taskIds: ["A-1"], proofs: [] }]),
    ).toEqual([{ name: "Export", kind: "planned", taskIds: ["A-1"], proofs: [] }])
  })

  it("a proof is a reference: a body or any other key is refused", () => {
    expect(
      codeOf(() =>
        readProposedLines([
          { name: "Export", kind: "planned", proofs: [{ kind: "commit", ref: "a1", body: "x" }] },
        ]),
      ),
    ).toBe("invalid_params")
  })

  it("wording naming a member is caught, a client contact is kept", () => {
    const members = [
      { name: "Paul Garnier", email: "paul@studio.example" },
      { name: "Emma", email: "emma@studio.example" },
    ]
    expect(namedMember("Fixed by Paul Garnier on Tuesday", members)).toBe("Paul Garnier")
    expect(namedMember("Asked by paul@studio.example", members)).toBe("paul@studio.example")
    expect(namedMember("Nadia Perrin asked for it", members)).toBeNull()
    // A single first name is not a full name: "Emma" on its own matches nothing.
    expect(namedMember("Emma's export", members)).toBeNull()
  })

  it("a meeting or a mail proof gets the server's label from its date, whatever it was sent", () => {
    expect(
      proofLabel({
        kind: "calendar_event",
        ref: "e1",
        label: "Paul's call",
        occurredOn: "2026-10-08",
      }),
    ).toBe("Meeting, 8 Oct")
    expect(
      proofLabel({ kind: "mail", ref: "m1", label: "anything", occurredOn: "2026-10-21" }),
    ).toBe("Mail, 21 Oct")
    expect(proofLabel({ kind: "pull_request", ref: "212", label: "PR #212" })).toBe("PR #212")
    expect(proofLabel({ kind: "note", ref: "n", label: "x".repeat(80) })).toHaveLength(60)
  })

  it("a proof keeps its link only on the host of the project's repositories", () => {
    const hosts = repoHostsOf([
      { provider: "github", repo: "studio/atlas" },
      { provider: "gitlab", repo: "https://git.studio.example/atlas/api" },
    ])
    const pr = (url: string) => keptProofUrl({ kind: "pull_request", ref: "1", url }, hosts)
    expect(pr("https://github.com/studio/atlas/pull/212")).toBe(
      "https://github.com/studio/atlas/pull/212",
    )
    expect(pr("https://git.studio.example/atlas/api/-/merge_requests/4")).toBeDefined()
    expect(pr("https://evil.example/pull/212")).toBeUndefined()
    expect(pr("http://github.com/studio/atlas/pull/212")).toBeUndefined()
    expect(
      keptProofUrl({ kind: "calendar_event", ref: "e", url: "https://github.com/x" }, hosts),
    ).toBeUndefined()
  })
})

describe("the default bill", () => {
  it("default bill follows the plan, never the overage", () => {
    expect(defaultBill("daily", "planned", day(3), day(3.5))).toEqual({ bill: day(3) })
    expect(defaultBill("daily", "planned", day(4), day(2))).toEqual({ bill: day(4) })
    expect(defaultBill("daily", "unplanned", null, day(1))).toEqual({ bill: 0 })
    expect(defaultBill("retainer", "planned", day(2), day(3))).toEqual({ bill: day(3) })
    expect(defaultBill("hourly", "planned", null, 90)).toEqual({ bill: 90 })
    expect(defaultBill("hourly", "planned", null, 0)).toEqual({ bill: 0, tag: NO_PLAN_TAG })
  })

  it("a trace estimate is refused where real time exists and never reaches real or bill", () => {
    const tasks = [task("a", null), task("b", null)]
    const base = {
      basis: "daily" as const,
      hoursPerDayMinutes: HPD,
      projectTasks: tasks,
      unlisted: [],
    }
    const line = (ids: string[], proofs: number) => ({
      name: "Report",
      kind: "planned" as const,
      taskIds: ids,
      resolvedTaskIds: ids,
      traceEstimate: "1 day",
      proofs: [],
      proofsOut: Array.from({ length: proofs }, () => ({
        kind: "note" as const,
        ref: "n",
        label: "Notes",
      })),
    })
    expect(
      codeOf(() =>
        computeLines({ ...base, ownReal: new Map([["a", 60]]), lines: [line(["a"], 1)] }),
      ),
    ).toBe("trace_estimate_with_real")
    expect(
      codeOf(() => computeLines({ ...base, ownReal: new Map(), lines: [line(["b"], 0)] })),
    ).toBe("trace_estimate_needs_proof")
    const [out] = computeLines({ ...base, ownReal: new Map(), lines: [line(["b"], 1)] })
    expect(out?.traceEstimateMinutes).toBe(HPD)
    expect(out?.realMinutes).toBe(0)
    expect(out?.billMinutes).toBe(0)
  })

  it("a parent and its child on one line count once, and unlisted tasks make the other line", () => {
    const tasks = [task("p", day(2)), task("c", day(1), "p"), task("x", null)]
    const lines = computeLines({
      basis: "daily",
      hoursPerDayMinutes: HPD,
      projectTasks: tasks,
      ownReal: new Map([
        ["c", day(1)],
        ["x", 60],
      ]),
      lines: [
        {
          name: "Feature",
          kind: "planned",
          taskIds: ["p", "c"],
          resolvedTaskIds: ["p", "c"],
          proofs: [],
          proofsOut: [],
        },
      ],
      unlisted: ["x"],
    })
    expect(lines.map((l) => [l.name, l.plannedMinutes, l.realMinutes, l.billMinutes])).toEqual([
      ["Feature", day(2), day(1), day(2)],
      [OTHER_LINE_NAME, null, 60, 0],
    ])
  })

  it("past the card's bound the last lines fold into the other line", () => {
    const tasks = Array.from({ length: 45 }, (_, i) => task(`t${i}`, 60))
    const lines = computeLines({
      basis: "hourly",
      hoursPerDayMinutes: HPD,
      projectTasks: tasks,
      ownReal: new Map(),
      lines: tasks.map((t) => ({
        name: t.id,
        kind: "planned" as const,
        taskIds: [t.id],
        resolvedTaskIds: [t.id],
        proofs: [],
        proofsOut: [],
      })),
      unlisted: [],
    })
    expect(lines).toHaveLength(RECONCILE_LINES_MAX)
    expect(lines.at(-1)?.name).toBe(OTHER_LINE_NAME)
    expect(lines.at(-1)?.taskIds).toHaveLength(45 - (RECONCILE_LINES_MAX - 1))
  })
})

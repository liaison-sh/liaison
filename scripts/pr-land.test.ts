// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  type CheckEntry,
  decideCiKick,
  decideQueue,
  failedQueueRun,
  judgePrChecks,
  KICK_AFTER_MS,
  MAX_KICKS,
  type QueueRun,
  runIdFromUrl,
} from "./pr-land"

const check = (name: string, conclusion: string, status = "COMPLETED"): CheckEntry => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/o/r/actions/runs/7${name.length}/job/1`,
})

const GREEN = ["checks", "CLAAssistant", "gitleaks"].map((n) => check(n, "SUCCESS"))

describe("decideQueue", () => {
  test("a merged PR is merged", () => {
    expect(decideQueue({ state: "MERGED", mergeQueueEntry: null })).toBe("merged")
  })

  test("an open PR with a queue entry is still queued", () => {
    const entry = { state: "AWAITING_CHECKS", position: 2 }
    expect(decideQueue({ state: "OPEN", mergeQueueEntry: entry })).toBe("queued")
  })

  test("an open PR that left the queue without merging was ejected", () => {
    expect(decideQueue({ state: "OPEN", mergeQueueEntry: null })).toBe("ejected")
  })

  test("a closed PR is closed", () => {
    expect(decideQueue({ state: "CLOSED", mergeQueueEntry: null })).toBe("closed")
  })
})

describe("failedQueueRun", () => {
  const qrun = (id: number, headBranch: string, conclusion: string): QueueRun => ({
    databaseId: id,
    headBranch,
    conclusion,
    url: `https://example.invalid/runs/${id}`,
  })

  test("picks the newest failed merge-group run of that PR only", () => {
    const runs = [
      qrun(5, "gh-readonly-queue/main/pr-12-abc123", "failure"),
      qrun(4, "gh-readonly-queue/main/pr-7-def456", "success"),
      qrun(3, "gh-readonly-queue/main/pr-7-0a1b2c", "failure"),
      qrun(2, "gh-readonly-queue/main/pr-70-0a1b2c", "failure"),
    ]
    expect(failedQueueRun(runs, "7")?.databaseId).toBe(3)
    expect(failedQueueRun(runs, "12")?.databaseId).toBe(5)
    expect(failedQueueRun(runs, "9")).toBeUndefined()
  })

  test("a cancelled group (rebuilt after a PR ahead failed) is not the PR's failure", () => {
    expect(
      failedQueueRun([qrun(1, "gh-readonly-queue/main/pr-7-abc", "cancelled")], "7"),
    ).toBeUndefined()
  })
})

describe("judgePrChecks", () => {
  test("every required check green is green", () => {
    expect(judgePrChecks(GREEN).state).toBe("green")
  })

  test("a PR without a gitleaks result cannot land", () => {
    const j = judgePrChecks(
      GREEN.filter((c) => c.__typename === "CheckRun" && c.name !== "gitleaks"),
    )
    expect(j.state).toBe("pending")
    expect(j.missing).toEqual(["gitleaks"])
  })

  test("a skipped gitleaks run is red: only a pass counts, unlike other checks", () => {
    const others = GREEN.filter((c) => c.__typename === "CheckRun" && c.name !== "gitleaks")
    for (const conclusion of ["SKIPPED", "NEUTRAL", "FAILURE"]) {
      const j = judgePrChecks([...others, check("gitleaks", conclusion)])
      expect(j.state).toBe("red")
      expect(j.failing.map((c) => c.name)).toEqual(["gitleaks"])
    }
    expect(judgePrChecks([...GREEN, check("lint-extra", "SKIPPED")]).state).toBe("green")
  })

  test("a failed check is red and names it", () => {
    const j = judgePrChecks([...GREEN.slice(1), check("checks", "FAILURE")])
    expect(j.state).toBe("red")
    expect(j.failing.map((c) => c.name)).toEqual(["checks"])
  })

  test("a running check is pending", () => {
    expect(judgePrChecks([...GREEN.slice(1), check("checks", "", "IN_PROGRESS")]).state).toBe(
      "pending",
    )
  })

  test("a required check that never reported is pending, not green", () => {
    const j = judgePrChecks(GREEN.filter((c) => c.name !== "checks"))
    expect(j.state).toBe("pending")
    expect(j.missing).toEqual(["checks"])
  })

  test("skipped and neutral checks do not block", () => {
    expect(
      judgePrChecks([...GREEN, check("optional", "SKIPPED"), check("info", "NEUTRAL")]).state,
    ).toBe("green")
  })

  test("a superseded cancelled run does not keep a re-run green check red", () => {
    const cancelled = { ...check("checks", "CANCELLED"), startedAt: "2026-10-25T20:40:37Z" }
    const rerun = { ...check("checks", "SUCCESS"), startedAt: "2026-10-25T20:41:43Z" }
    const j = judgePrChecks([...GREEN.filter((c) => c.name !== "checks"), cancelled, rerun])
    expect(j.state).toBe("green")
  })

  test("a newer failed run of a check is red even after an older green one", () => {
    const green = { ...check("checks", "SUCCESS"), startedAt: "2026-10-25T20:40:00Z" }
    const red = { ...check("checks", "FAILURE"), startedAt: "2026-10-25T20:45:00Z" }
    const j = judgePrChecks([...GREEN.filter((c) => c.name !== "checks"), green, red])
    expect(j.state).toBe("red")
  })

  test("a failed commit status is red", () => {
    const status: CheckEntry = { __typename: "StatusContext", context: "ext", state: "FAILURE" }
    expect(judgePrChecks([...GREEN, status]).state).toBe("red")
  })
})

describe("parsing", () => {
  test("run id from a check's details URL", () => {
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/38977868410/job/117231532457")).toBe(
      "38977868410",
    )
    expect(runIdFromUrl("https://example.invalid/status")).toBeNull()
  })
})

describe("decideCiKick", () => {
  const t0 = 1_000_000
  test("a head with no check at all past the delay is re-triggered", () => {
    expect(decideCiKick([], t0, 0, t0 + KICK_AFTER_MS)).toBe("kick")
  })

  test("a head with no check yet, inside the delay, waits", () => {
    expect(decideCiKick([], t0, 0, t0 + KICK_AFTER_MS - 1)).toBe("wait")
  })

  test("a head whose checks are running is never re-triggered", () => {
    expect(decideCiKick([check("checks", "", "IN_PROGRESS")], t0, 0, t0 + 10 * KICK_AFTER_MS)).toBe(
      "wait",
    )
  })

  test("once the re-triggers are spent it gives up instead of waiting out the deadline", () => {
    expect(decideCiKick([], t0, MAX_KICKS, t0 + KICK_AFTER_MS)).toBe("give_up")
  })
})

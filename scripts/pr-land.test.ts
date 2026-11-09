// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  type CheckEntry,
  type CiRun,
  decideCiKick,
  decideMainGate,
  KICK_AFTER_MS,
  MAX_KICKS,
  judgePrChecks,
  parseFixesCi,
  runIdFromUrl,
} from "./pr-land"

const run = (id: number, conclusion: string, status = "completed"): CiRun => ({
  databaseId: id,
  status,
  conclusion,
  headSha: `sha${id}`,
  url: `https://example.invalid/runs/${id}`,
})

const check = (name: string, conclusion: string, status = "COMPLETED"): CheckEntry => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/o/r/actions/runs/7${name.length}/job/1`,
})

const GREEN = ["checks", "CLAAssistant", "gitleaks"].map((n) => check(n, "SUCCESS"))

describe("decideMainGate", () => {
  test("a green main lets the merge through", () => {
    expect(decideMainGate([run(3, "success"), run(2, "failure")], []).allow).toBe(true)
  })

  test("a red main refuses a PR that does not claim the fix", () => {
    const d = decideMainGate([run(3, "failure"), run(2, "success")], [])
    expect(d.allow).toBe(false)
    expect(d.redRun?.databaseId).toBe(3)
  })

  test("in-progress and cancelled runs do not decide: the newest finished run does", () => {
    const runs = [
      run(5, "", "in_progress"),
      run(4, "cancelled"),
      run(3, "failure"),
      run(2, "success"),
    ]
    expect(decideMainGate(runs, []).redRun?.databaseId).toBe(3)
  })

  test("a PR naming any red run since the last green is the fix and passes", () => {
    const runs = [run(4, "failure"), run(3, "failure"), run(2, "success")]
    expect(decideMainGate(runs, ["3"]).allow).toBe(true)
    expect(decideMainGate(runs, ["4"]).allow).toBe(true)
  })

  test("naming a run from before the last green does not unlock it", () => {
    const runs = [run(4, "failure"), run(3, "success"), run(2, "failure")]
    expect(decideMainGate(runs, ["2"]).allow).toBe(false)
  })

  test("no finished run at all lets the merge through", () => {
    expect(decideMainGate([run(1, "", "queued")], []).allow).toBe(true)
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
  test("Fixes-CI ids from a PR body and commit trailers, bare or as run URLs", () => {
    expect(
      parseFixesCi(
        "Repairs lint.\n\nFixes-CI: 123\nfixes-ci: https://github.com/o/r/actions/runs/456\n",
      ),
    ).toEqual(["123", "456"])
  })

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

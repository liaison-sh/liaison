// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wake-up contract, for every bundled app and in-tree sandboxed app: each
// declared entry point runs twice in one reused QuickJS isolate on recorded
// egress under its production limits (harness.ts), and the app's sources pass
// the wait lint (wait-lint.ts). The failures must be exactly the expected
// ones (expected-failures.json): a new failure is red, and so is an expected
// one that no longer fails (take it off the list; the list only shrinks).
//
// After fixing entries, `CONTRACT_WRITE_EXPECTED=1` rewrites the list from
// this run; the guard (expected-failures.guard.test.ts) refuses any row the
// baseline does not hold.
import { describe, expect, it } from "bun:test"
import { appsUnderContract, loadAppUnderContract } from "./apps"
import {
  EXPECTED_FAILURES_PATH,
  type ExpectedFailure,
  failuresOf,
  keyOf,
  readFailures,
  writeFailures,
} from "./expected"
import { runAppContract } from "./harness"
import { quickJsContractExecutor } from "./quickjs-isolate"
import { lintAppWaits } from "./wait-lint"

const expected = readFailures(EXPECTED_FAILURES_PATH)
const actualAll: ExpectedFailure[] = []
const apps = appsUnderContract()

describe("app wake-up contract", () => {
  for (const app of apps) {
    it(`${app}: only the expected failures`, async () => {
      const loaded = await loadAppUnderContract(app)
      expect(loaded.entries.length).toBeGreaterThan(0)
      const verdicts = await runAppContract(loaded, quickJsContractExecutor)
      const actual = failuresOf(app, verdicts, lintAppWaits(loaded.dir))
      actualAll.push(...actual)
      const want = new Set(expected.filter((f) => f.app === app).map(keyOf))
      const got = new Set(actual.map(keyOf))
      const detail = new Map(verdicts.map((v) => [v.entry, v.detail ?? ""]))
      const added = actual
        .filter((f) => !want.has(keyOf(f)))
        .map((f) => `${keyOf(f)}  (${detail.get(f.entry) ?? "wait lint"})`)
      const fixed = [...want].filter((k) => !got.has(k))
      expect({ newFailures: added, fixedTakeOffTheList: fixed }).toEqual({
        newFailures: [],
        fixedTakeOffTheList: [],
      })
    }, 120_000)
  }

  it("covers every app the list names", () => {
    const unknown = [...new Set(expected.map((f) => f.app))].filter((a) => !apps.includes(a))
    expect(unknown).toEqual([])
    if (process.env.CONTRACT_WRITE_EXPECTED === "1")
      writeFailures(EXPECTED_FAILURES_PATH, actualAll)
  })
})

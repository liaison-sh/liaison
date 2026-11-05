// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The matrix report (lib/report.ts) and the case catalogue (lib/cases.ts):
// the pass rule, the markdown rows, the dry-run plan, and that the catalogue
// holds what spec-push.md S7 + A6/A9/A13 ask for.
import { describe, expect, it } from "bun:test"
import { buildCases, computerTarget, controllersNeeded } from "./lib/cases"
import { buildReport, caseStatus, renderMarkdown, renderPlan } from "./lib/report"
import type { CaseResult, CellResult } from "./lib/types"

const cell = (status: CellResult["status"], over: Partial<CellResult> = {}): CellResult => ({
  caseId: "C",
  phase: "dm",
  cell: "ios",
  expected: "shown",
  observed: status === "match" ? "shown" : "none",
  status,
  evidence: ["notification:n1", "receipt:r1:shown"],
  ...over,
})

const result = (id: string, cells: CellResult[], error?: string): CaseResult => ({
  id,
  group: "M2",
  title: id,
  status: caseStatus({ cells, ...(error ? { error } : {}) }),
  cells,
  startedAt: "2026-10-07T12:00:00Z",
  durationMs: 1,
  ...(error ? { error } : {}),
})

const meta = {
  runId: "run",
  target: "http://localhost",
  startedAt: "a",
  finishedAt: "b",
  surfaces: ["ios", "desktop", "web"] as const,
  run: 1,
  runs: 2,
}

describe("the pass rule", () => {
  it("passes only when every cell matches", () => {
    const r = buildReport({
      ...meta,
      surfaces: [...meta.surfaces],
      cases: [result("A", [cell("match")])],
    })
    expect(r.pass).toBe(true)
    expect(r.complete).toBe(true)
    expect(r.totals.match).toBe(1)
  })

  it("one mismatch fails the run", () => {
    const r = buildReport({
      ...meta,
      surfaces: [...meta.surfaces],
      cases: [result("A", [cell("match")]), result("B", [cell("mismatch")])],
    })
    expect(r.pass).toBe(false)
    expect(r.totals.mismatch).toBe(1)
  })

  it("skipped or human-pending cells make the run incomplete, so not a pass", () => {
    for (const s of ["skipped", "human-pending"] as const) {
      const r = buildReport({
        ...meta,
        surfaces: [...meta.surfaces],
        cases: [result("A", [cell("match")]), result("B", [cell(s)])],
      })
      expect(r.complete).toBe(false)
      expect(r.pass).toBe(false)
    }
  })

  it("a case that errored before any cell counts against the run", () => {
    const r = buildReport({
      ...meta,
      surfaces: [...meta.surfaces],
      cases: [result("A", [cell("match")]), result("B", [], "login failed")],
    })
    expect(r.totals.error).toBe(1)
    expect(r.pass).toBe(false)
  })

  it("a run without every surface is incomplete", () => {
    const r = buildReport({ ...meta, surfaces: ["web"], cases: [result("A", [cell("match")])] })
    expect(r.complete).toBe(false)
    expect(r.pass).toBe(false)
  })
})

// H-1 and the TF cells on demo, 2026-10-12: every cell matched, yet the run
// read a bare "FAIL" because a human run covers one or two surfaces. The pass
// rule stands; the verdict now says why such a run is not a pass.
describe("the verdict", () => {
  it("an all-match run missing surfaces is INCOMPLETE with the reason, not a bare FAIL", () => {
    const r = buildReport({
      ...meta,
      surfaces: ["desktop", "web"],
      cases: [result("H-1", [cell("match"), cell("match", { cell: "browser_push" })])],
    })
    expect(r.pass).toBe(false)
    expect(r.verdict).toBe(
      "INCOMPLETE: surfaces ios,desktop,web not all in this run (ran desktop,web)",
    )
    expect(renderMarkdown(r)).toContain("# Push matrix run 1/2: INCOMPLETE: surfaces")
  })

  it("names skipped and human-pending cells", () => {
    const r = buildReport({
      ...meta,
      surfaces: [...meta.surfaces],
      cases: [result("A", [cell("match"), cell("skipped"), cell("human-pending")])],
    })
    expect(r.verdict).toBe("INCOMPLETE: 1 skipped, 1 human-pending")
  })

  it("a mismatch or an error is FAIL; a full matching run is PASS", () => {
    const fail = buildReport({
      ...meta,
      surfaces: ["ios"],
      cases: [result("A", [cell("mismatch")])],
    })
    expect(fail.verdict).toBe("FAIL")
    const pass = buildReport({
      ...meta,
      surfaces: [...meta.surfaces],
      cases: [result("A", [cell("match")])],
    })
    expect(pass.verdict).toBe("PASS")
  })
})

describe("the markdown", () => {
  it("has one row per cell with expected, observed, status and evidence ids", () => {
    const r = buildReport({
      ...meta,
      surfaces: [...meta.surfaces],
      cases: [
        result("M2-ios-background", [
          cell("match", { note: "received + OS presentation counts as shown (A3)" }),
          cell("mismatch", { cell: "desktop", expected: "none", observed: "shown | none" }),
        ]),
      ],
    })
    const md = renderMarkdown(r)
    expect(md).toContain("# Push matrix run 1/2: FAIL")
    expect(md).toContain(
      "| M2-ios-background | dm | ios | shown | shown (received + OS presentation counts as shown (A3)) | match | `notification:n1` `receipt:r1:shown` |",
    )
    // A pipe inside a value does not break the table.
    expect(md).toContain("| desktop | none | shown \\| none | mismatch |")
  })
})

describe("the case catalogue", () => {
  const all = buildCases(["ios", "desktop", "web"])
  const by = (g: string) => all.filter((c) => c.group === g)

  it("holds M1 (28), M2, M3, M4, M5, A6, A13 and the human cells", () => {
    expect(by("M1")).toHaveLength(28)
    expect(by("M2")).toHaveLength(11)
    expect(by("M3")).toHaveLength(6)
    expect(by("M4")).toHaveLength(4)
    expect(by("M5")).toHaveLength(3)
    expect(by("A6")).toHaveLength(2)
    expect(by("A13")).toHaveLength(1)
    expect(by("H")).toHaveLength(1)
    expect(by("TF")).toHaveLength(6)
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
  })

  it("A9: every case sets the grid cells it depends on, explicitly", () => {
    for (const c of all) {
      const cells = Object.values(c.setup.grid).flatMap((row) => Object.keys(row ?? {}))
      expect(cells.length, c.id).toBeGreaterThan(0)
    }
    const muted = all.find((c) => c.id === "M3-muted-reply")!
    expect(muted.setup.grid.replies).toEqual({ push: true, desktop: true })
  })

  it("M1 off cells expect none plus a grid_off router row, the other channel still delivering", () => {
    const off = all.find((c) => c.id === "M1-work-push-off")!
    expect(off.setup.grid).toEqual({ work: { push: false, desktop: true } })
    const p = off.phases[0]!
    expect(p.expect.ios).toEqual({ kind: "none" })
    expect(p.expect.desktop).toEqual({ kind: "shown" })
    expect(p.router).toEqual([{ channel: "push", result: "suppressed", reason: "grid_off" }])
  })

  it("M1 picks the computer surface by the server's precedence for the surfaces in the run", () => {
    const web = buildCases(["web"]).find((c) => c.id === "M1-direct-computer-on")!
    expect(web.phases[0]!.expect).toEqual({
      browser_tab: { kind: "shown" },
      browser_push: { kind: "none" },
    })
    expect(computerTarget(["desktop", "web"], { desktop: "elsewhere", browser: "on_thread" })).toBe(
      "desktop",
    )
    expect(
      computerTarget(["desktop", "web"], { desktop: "permission_denied", browser: "no_tab" }),
    ).toBe("browser_push")
    expect(computerTarget(["web"], { browser: "unregistered" })).toBeNull()
  })

  it("A6 and A13 additions are there", () => {
    const killed = all.find((c) => c.id === "A6-desktop-killed")!
    expect(killed.phases[0]!.windowMs).toBe(15_000)
    const tab = all.find((c) => c.id === "A6-tab-on-thread")!
    expect(tab.phases[0]!.expect).toEqual({
      browser_tab: { kind: "suppressed", reason: "on_screen" },
      browser_push: { kind: "none" },
    })
    expect(all.find((c) => c.id === "A13-tray-3min")!.phases[0]!.holdMs).toBe(180_000)
  })

  it("H-1 and the 6 TestFlight cells are human cells; TestFlight needs no simulator", () => {
    const humans = all.filter((c) => c.human)
    expect(humans.map((c) => c.id).sort()).toEqual(
      [
        "H-1",
        "TF-dm-background",
        "TF-dm-foreground",
        "TF-dm-killed",
        "TF-mention-background",
        "TF-muted-reply",
        "TF-test-button",
      ].sort(),
    )
    for (const c of humans.filter((h) => h.group === "TF")) {
      expect(controllersNeeded(c)).not.toContain("ios")
    }
    expect(controllersNeeded(all.find((c) => c.id === "H-1")!).sort()).toEqual(["desktop", "web"])
  })

  it("the dry-run plan lists every case with its setup, trigger and expectations", () => {
    const plan = renderPlan(all, ["ios", "desktop", "web"])
    expect(plan.split("\n")[0]).toContain(`${all.length} cases`)
    expect(plan).toContain("M1-direct-push-on [M1]")
    expect(plan).toContain("setup: direct.push=on direct.desktop=off")
    expect(plan).toContain("router push:suppressed/grid_off")
    expect(plan).toContain("(judges phase 1's notifications)")
    expect(plan).toContain("human: On the Minimac: System Settings")
  })
})

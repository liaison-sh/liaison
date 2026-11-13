// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reconcile card as the kernel draws it: the projects manifest's own template resolved from
// card fixtures, with no app bundle loaded. Seven situations, the largest card under its bound,
// and nothing on it a person has to tick before anything else.

import { describe, expect, it } from "bun:test"
import {
  type CardTemplate,
  type ResolvedCard,
  TOOL_CARD_GROUPS_MAX_BYTES,
  TOOL_CARD_GROUPS_MAX_ROWS,
} from "@liaison/shared"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { resolveToolCard } from "~/modules/apps/result-card"
import { resultCardErrors } from "~/modules/apps/result-card-schema"
import { type CardInput, type CardLine, reconcileCardFields } from "./reconcile-card"
import { NOT_EVERYTHING_SEEN } from "./reconcile-lines"

const HPD = 420
const d = (n: number) => Math.round(n * HPD)
const tools = (projectsAppManifest as unknown as { tools: Record<string, Record<string, unknown>> })
  .tools
const template = tools.reconcile_propose?.resultCard as CardTemplate

function line(id: string, over: Partial<CardLine> = {}): CardLine {
  return {
    id,
    position: 0,
    name: id,
    kind: "planned",
    plannedMinutes: d(3),
    realMinutes: d(3),
    traceEstimateMinutes: null,
    billMinutes: d(3),
    proofs: [{ label: "ORBIT-14" }],
    ...over,
  }
}

const base: CardInput = {
  state: "proposed",
  basis: "daily",
  hoursPerDayMinutes: HPD,
  projectName: "Maison Delorme platform",
  periodLabel: "October 2026",
  lines: [],
  rateMinor: 93_000,
  currency: "EUR",
  coverage: { withEntries: 9, total: 11 },
  notSeen: [],
  excludedCount: 0,
  late: null,
}

function draw(input: Partial<CardInput>): ResolvedCard {
  const fields = reconcileCardFields({ ...base, ...input })
  const result = {
    reconciliationId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    state: input.state ?? "proposed",
    ...fields,
    cardNotes: fields.notes,
  }
  const card = resolveToolCard(template, result)
  if (!card) throw new Error("the card fell back to the plain tool row")
  return card
}

const rows = (c: ResolvedCard) => (c.groups ?? []).flatMap((g) => g.rows)

describe("the reconcile card", () => {
  it("each of the seven card states renders from its fixture", () => {
    expect(resultCardErrors(projectsAppManifest as never)).toEqual([])

    // Fits: planned, time spent and billed agree; the money total is excluding VAT.
    const fits = draw({
      lines: [
        line("export", { name: "Data export" }),
        line("monitoring", {
          name: "Monitoring",
          plannedMinutes: d(4),
          realMinutes: d(4),
          billMinutes: d(4),
        }),
      ],
    })
    expect(fits.status?.label.label).toBe("Fits the plan")
    expect(
      rows(fits).map((r) => [r.name, r.cells.planned, r.cells.realNote, r.cells.bill]),
    ).toEqual([
      ["Data export", "3 d", "3 d", "3 d"],
      ["Monitoring", "4 d", "4 d", "4 d"],
    ])
    expect(fits.tot).toEqual([
      { k: "Excl. VAT", v: { t: "money", minor: 651_000, currency: "EUR" } },
    ])
    expect(fits.edit?.tool).toBe("reconcile_line_update")
    expect(fits.latestKey).toBe("reconcile:11111111-1111-4111-8111-111111111111")
    expect(fits.supersededLabel?.label).toBe("First version")

    // Over: time spent above the plan never raises the bill.
    const over = draw({ lines: [line("export", { realMinutes: d(3.5) })] })
    expect(over.status?.label.label).toBe("Over the plan")
    expect(rows(over)[0]?.cells.bill).toBe("3 d")
    expect(over.sub).toContain("Billed stays at what was planned")

    // Little time spent: an estimate reads with ~, and the cover says it is partial.
    const estimated = draw({
      coverage: { withEntries: 2, total: 9 },
      lines: [line("signin", { realMinutes: 0, traceEstimateMinutes: d(3) })],
    })
    expect(estimated.status?.label.label).toBe("Time spent mostly estimated")
    expect(rows(estimated)[0]?.cells.realNote).toBe("~3 d")
    expect(estimated.cover).toContain("partial")
    expect(estimated.edit).toBeDefined()

    // Fixed price: no Billed or Amount column, no total, nothing to change.
    const fixed = draw({
      basis: "fixed",
      lines: [line("design", { plannedMinutes: 78 * 60, realMinutes: 81 * 60, billMinutes: 0 })],
    })
    expect(fixed.status?.label.label).toBe("Fixed price")
    expect(fixed.columns?.map((c) => c.key)).toEqual(["planned", "realNote"])
    expect(fixed.tot).toEqual([])
    expect(fixed.edit).toBeUndefined()

    // Unplanned lines: their own group, each says why, none billed by default.
    const unplanned = draw({
      lines: [
        line("export"),
        line("outage", {
          name: "Staging outage",
          kind: "unplanned",
          plannedMinutes: null,
          realMinutes: d(0.5),
          billMinutes: 0,
          why: "Our deploy took staging down.",
        }),
      ],
    })
    const extra = unplanned.groups?.find((g) => g.label === "Not in the plan")
    expect(extra?.rows.map((r) => [r.name, r.why, r.cells.bill])).toEqual([
      ["Staging outage", "Our deploy took staging down.", "0 d"],
    ])
    expect(unplanned.notes?.[0]?.text).toContain("left off the bill. None needs an answer.")

    // Nothing found: no row, nothing to change, and the sentence about what was read.
    const nothing = draw({ lines: [], coverage: { withEntries: 0, total: 0 } })
    expect(nothing.status?.label.label).toBe("Nothing to check")
    expect(rows(nothing)).toEqual([])
    expect(nothing.edit).toBeUndefined()
    expect(nothing.actions).toBeUndefined()
    expect(nothing.notes?.map((n) => n.text)).toContain(NOT_EVERYTHING_SEEN)

    // GitHub not connected: the card still draws, with a notice and Connect GitHub.
    const partial = draw({
      lines: [line("export")],
      notSeen: [{ source: "GitHub", why: "not connected" }],
    })
    expect(partial.notice?.title).toBe("GitHub was not seen")
    expect(partial.actions?.map((a) => [a.kind, a.label.label])).toEqual([
      ["open", "Connect GitHub"],
    ])
    expect(rows(partial)[0]?.cells.bill).toBe("3 d")
  })

  it("the card has no checkbox and no per-line confirm", () => {
    const card = draw({
      lines: [
        line("export"),
        line("extra", {
          kind: "unplanned",
          plannedMinutes: null,
          billMinutes: 0,
          why: "Asked for.",
        }),
      ],
    })
    const text = JSON.stringify(card)
    expect(text).not.toMatch(/checkbox|"confirm"/i)
    for (const r of rows(card)) expect(r.act).toBeUndefined()
    // Every edit field writes one value of one line, with no tick to give first.
    expect(card.edit?.fields.map((f) => [f.param, f.kind])).toEqual([
      ["bill", "quantity"],
      ["realNote", "quantity"],
    ])
  })

  it("the reconcile card resolves without the app bundle and the largest fixture of forty lines stays under the byte bound", () => {
    for (const name of ["reconcile_propose", "reconcile_line_update", "reconcile_get"]) {
      expect(tools[name]?.resultCard).toEqual(template)
      // Every value the card reads is one the tool says it returns.
      const returned = Object.keys(
        (tools[name]?.returns as { schema?: Record<string, string> } | undefined)?.schema ?? {},
      )
      for (const path of JSON.stringify(template).match(/result\.[A-Za-z]+/g) ?? []) {
        expect(returned).toContain(path.slice("result.".length))
      }
    }
    const lines = Array.from({ length: TOOL_CARD_GROUPS_MAX_ROWS }, (_, i) =>
      line(`10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, {
        position: i,
        name: `Supplier connector part ${i + 1}, with its export and monitoring`,
        kind: i < 20 ? "planned" : "unplanned",
        why: "Agreed with the client at the weekly review, then shipped and checked in production.",
        proofs: Array.from({ length: 6 }, (_, k) => ({
          label: `PR #${1000 + i * 6 + k}`,
          url: `https://github.com/maison-delorme/platform/pull/${1000 + i * 6 + k}`,
        })),
      }),
    )
    const card = draw({ lines, notSeen: [{ source: "Calendar", why: "no access" }], late: "Late." })
    expect(rows(card)).toHaveLength(TOOL_CARD_GROUPS_MAX_ROWS)
    const bytes = new TextEncoder().encode(JSON.stringify(card)).length
    expect(bytes).toBeLessThan(TOOL_CARD_GROUPS_MAX_BYTES)
    // Every line is still on it, each with its own bill and something of its proof.
    expect(rows(card).every((r) => r.cells.bill === "3 d" && r.edit?.bill?.value === 3)).toBe(true)
    // A shorter month keeps its links.
    const short = draw({ lines: lines.slice(0, 5) })
    expect(rows(short)[0]?.links).toHaveLength(3)
  })
})

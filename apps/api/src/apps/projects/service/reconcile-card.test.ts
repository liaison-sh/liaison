// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reconcile card as the kernel draws it: the projects manifest's own template resolved from
// card fixtures, with no app bundle loaded. Seven situations, the largest card under its bound,
// and nothing on it a person has to tick before anything else.

import { describe, expect, it } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type CardTemplate,
  type ResolvedCard,
  TOOL_CARD_GROUPS_MAX_BYTES,
  TOOL_CARD_GROUPS_MAX_ROWS,
} from "@liaison/shared"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { resolveToolCard } from "~/modules/apps/result-card"
import { resultCardErrors } from "~/modules/apps/result-card-schema"
import {
  type CardInput,
  type CardLine,
  linesForViewer,
  reconcileCardFields,
  shownProof,
} from "./reconcile-card"
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

    // Billed above the period's plan reads over, however the lines are grouped.
    const billedOver = draw({
      lines: [
        line("export"),
        line("review", { kind: "unplanned", plannedMinutes: null, billMinutes: d(1) }),
      ],
    })
    expect(billedOver.status?.label.label).toBe("Over the plan")
    expect(billedOver.sub).toBe("Planned 3 d. Billed 4 d, more than planned. Time spent 6 d.")

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
    // The note never says "none needs an answer": a line's own why may ask for one before billing.
    expect(unplanned.notes?.[0]?.text).toBe(
      "1 line not in the plan is left off the bill. Nothing is asked of you about it; to bill one, change its line.",
    )

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
    for (const name of [
      "reconcile_propose",
      "reconcile_line_update",
      "reconcile_get",
      "reconcile_create_invoice",
      "reconcile_undo",
    ]) {
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
    // A shorter month keeps its links, the last one counting the proof left out.
    const short = draw({ lines: lines.slice(0, 5) })
    expect(rows(short)[0]?.links).toHaveLength(3)
    expect(rows(short)[0]?.links?.[2]?.label).toBe("+4")
  })

  it("forty lines with very long names still draw under the byte bound, each name shortened", () => {
    for (const length of [500, 680]) {
      const lines = Array.from({ length: TOOL_CARD_GROUPS_MAX_ROWS }, (_, i) =>
        line(`20000000-0000-4000-8000-${String(i).padStart(12, "0")}`, {
          position: i,
          name: `Line ${i + 1} ${"export and monitoring of the supplier connector ".repeat(20)}`.slice(
            0,
            length,
          ),
          why: "Agreed with the client at the weekly review, then shipped and checked in production.",
          proofs: Array.from({ length: 6 }, (_, k) => ({
            label: `PR #${1000 + i * 6 + k}`,
            url: `https://github.com/maison-delorme/platform/pull/${1000 + i * 6 + k}`,
          })),
        }),
      )
      // The fields alone, before any shortening, are past the bound: the case that used to vanish.
      const raw = lines.map((l) => ({ name: l.name, why: l.why, proof: l.proofs }))
      expect(new TextEncoder().encode(JSON.stringify(raw)).length).toBeGreaterThan(
        TOOL_CARD_GROUPS_MAX_BYTES,
      )
      const card = draw({ lines })
      expect(rows(card)).toHaveLength(TOOL_CARD_GROUPS_MAX_ROWS)
      expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThan(
        TOOL_CARD_GROUPS_MAX_BYTES,
      )
      for (const [i, r] of rows(card).entries()) {
        expect(r.name).toContain(`Line ${i + 1} `)
      }
    }
  })
})

/** The web renderer's own fixture: the card this resolver draws for the largest month. */
const WEB_FIXTURE = join(
  import.meta.dir,
  "../../../../../web/src/modules/agent/__fixtures__/reconcile-forty-lines.json",
)

describe("the reconcile card the web draws", () => {
  it("the forty-line card with six proofs a line, the web renderer's fixture, is the resolver's own output under the byte bound", () => {
    const label = (n: number) =>
      `Pull request ${n}: supplier connector export and monitoring`.padEnd(60, ".").slice(0, 60)
    const lines = Array.from({ length: TOOL_CARD_GROUPS_MAX_ROWS }, (_, i) =>
      line(`20000000-0000-4000-8000-${String(i).padStart(12, "0")}`, {
        position: i,
        name: `Supplier connector part ${i + 1}, with its export and monitoring`,
        kind: i < 24 ? "planned" : "unplanned",
        why: "Agreed with the client at the weekly review, then shipped and checked in production.",
        proofs: Array.from({ length: 6 }, (_, k) => ({
          label: label(1000 + i * 6 + k),
          url: `https://github.com/maison-delorme/platform/pull/${1000 + i * 6 + k}`,
        })),
        ...(i >= 24
          ? {
              taskIds: [`30000000-0000-4000-8000-${String(i).padStart(12, "0")}`],
              moveTo: { projectId: "40000000-0000-4000-8000-000000000001", key: "NORD" },
            }
          : {}),
      }),
    )
    const card = draw({
      lines,
      notSeen: [{ source: "GitHub", why: "not connected" }],
      late: "Late.",
    })
    expect(rows(card)).toHaveLength(TOOL_CARD_GROUPS_MAX_ROWS)
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThan(
      TOOL_CARD_GROUPS_MAX_BYTES,
    )
    expect(rows(card).filter((r) => r.act?.label.label === "Move it to NORD")).toHaveLength(16)
    const text = `${JSON.stringify(card, null, 2)}\n`
    // Rewritten only on purpose (UPDATE_CARD_FIXTURES=1); otherwise a drift fails here.
    if (process.env.UPDATE_CARD_FIXTURES === "1") {
      writeFileSync(WEB_FIXTURE, text)
    }
    // Compared as data: the file is formatted like any other JSON in the repo.
    expect(JSON.parse(readFileSync(WEB_FIXTURE, "utf8"))).toEqual(card)
  })
})

describe("a line's proof chips", () => {
  it("four tasks on a line show two chips and a count, never three of four as if complete", () => {
    const four = ["DATA-15", "DATA-11", "DATA-13", "DATA-14"].map((label) => ({ label }))
    expect(shownProof(four, 3).map((p) => p.label)).toEqual(["DATA-15", "DATA-11", "+2"])
    expect(shownProof(four.slice(0, 3), 3).map((p) => p.label)).toEqual([
      "DATA-15",
      "DATA-11",
      "DATA-13",
    ])
    expect(shownProof(four, 1).map((p) => p.label)).toEqual(["DATA-15"])
    expect(shownProof(four, 0)).toEqual([])
  })
})

describe("the card's money states", () => {
  const priced = (extra: Record<string, unknown>, input: Partial<CardInput> = {}) => {
    const fields = reconcileCardFields({ ...base, lines: [line("a"), line("b")], ...input })
    return resolveToolCard(template, {
      reconciliationId: "11111111-1111-4111-8111-111111111111",
      revision: 2,
      state: input.state ?? "proposed",
      ...fields,
      cardNotes: fields.notes,
      createInvoice: null,
      summary: null,
      undo: null,
      ...extra,
    })
  }

  it("Create invoice is enabled on the first render", () => {
    const card = priced({ createInvoice: "yes" })
    const create = (card?.actions ?? []).find((a) => a.kind === "tool")
    expect(create).toMatchObject({
      kind: "tool",
      tool: "reconcile_create_invoice",
      primary: true,
      params: { reconciliationId: "11111111-1111-4111-8111-111111111111", revision: 2 },
    })
    expect(JSON.stringify(create)).not.toMatch(/confirm|disabled/)
    // Not offered while invoicing has not priced the card.
    expect((priced({})?.actions ?? []).some((a) => a.kind === "tool")).toBe(false)
  })

  it("a retainer month above its hours also offers Create without this month's overage", () => {
    const card = priced({ createInvoice: "yes", waiveOverage: true })
    const offered = (card?.actions ?? []).filter((a) => a.kind === "tool")
    expect(offered).toHaveLength(2)
    expect(offered[1]).toMatchObject({
      kind: "tool",
      tool: "reconcile_create_invoice",
      label: { label: "Create invoice without this month's overage" },
      params: {
        reconciliationId: "11111111-1111-4111-8111-111111111111",
        revision: 2,
        waiveOverage: true,
      },
    })
    expect(offered[1]).not.toHaveProperty("primary")
    // Under its hours, or not a retainer: only Create.
    const plain = priced({ createInvoice: "yes" })
    expect((plain?.actions ?? []).filter((a) => a.kind === "tool")).toHaveLength(1)
    // Every card the reconcile tools draw offers it the same way.
    for (const name of [
      "reconcile_propose",
      "reconcile_line_update",
      "reconcile_get",
      "reconcile_create_invoice",
      "reconcile_undo",
    ]) {
      const t = tools[name]?.resultCard as CardTemplate
      const acts = JSON.stringify(t.actions)
      expect(acts).toContain('"waiveOverage":"result.waiveOverage"')
    }
  })

  it("Create replaces the stored card by its summary line and Undo brings it back", () => {
    const created = priced(
      { summary: "Created and approved, €7,812.00 incl. VAT", undo: "yes" },
      { state: "drafted" },
    )
    expect(created?.summary?.text).toBe("Created and approved, €7,812.00 incl. VAT")
    expect(created?.summary?.actions).toEqual([
      expect.objectContaining({
        kind: "tool",
        tool: "reconcile_undo",
        params: { reconciliationId: "11111111-1111-4111-8111-111111111111" },
      }),
    ])
    expect(created?.latestKey).toBe("reconcile:11111111-1111-4111-8111-111111111111")
    const back = priced({ createInvoice: "yes" })
    expect(back?.summary).toBeUndefined()
    expect(back?.latestKey).toBe(created?.latestKey)
    expect(rows(back as ResolvedCard)).toHaveLength(2)
  })

  it("the largest card with VAT rows stays under the byte bound", () => {
    const lines = Array.from({ length: TOOL_CARD_GROUPS_MAX_ROWS }, (_, i) =>
      line(`20000000-0000-4000-8000-${String(i).padStart(12, "0")}`, {
        position: i,
        name: `Supplier connector part ${i + 1}, with its export and monitoring`,
        why: "Agreed with the client at the weekly review, then shipped and checked in production.",
        proofs: Array.from({ length: 6 }, (_, k) => ({
          label: `PR #${2000 + i * 6 + k}`,
          url: `https://github.com/maison-delorme/platform/pull/${2000 + i * 6 + k}`,
        })),
      }),
    )
    const card = priced(
      {
        createInvoice: "yes",
        tot: [
          { k: "Excl. VAT", v: { minor: 99_999_999, currency: "EUR" } },
          { k: "VAT", v: { minor: 19_999_999, currency: "EUR" } },
          { k: "Incl. VAT", v: { minor: 119_999_998, currency: "EUR" } },
        ],
        notice: {
          title: "Before Create invoice",
          text: "To create the invoice from this card, set the project's company, the project's rate.",
        },
      },
      { lines, notSeen: [{ source: "Calendar", why: "no access" }], late: "Late." },
    )
    if (!card) throw new Error("the card fell back to the plain tool row")
    expect(card.tot).toHaveLength(3)
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThan(
      TOOL_CARD_GROUPS_MAX_BYTES,
    )
  })

  it("a note on time spent is shown to its author only once the card is drafted", () => {
    const noted = [line("a", { realNoteMinutes: d(5) })]
    expect(linesForViewer(noted, "proposed", "reader", "author")[0]?.realNoteMinutes).toBe(d(5))
    expect(linesForViewer(noted, "drafted", "author", "author")[0]?.realNoteMinutes).toBe(d(5))
    for (const state of ["drafted", "invoiced", "credited"] as const) {
      const seen = linesForViewer(noted, state, "reader", "author")
      expect(seen[0]).not.toHaveProperty("realNoteMinutes")
      const card = reconcileCardFields({ ...base, state, lines: seen })
      expect(JSON.stringify(card)).not.toContain("5 d")
    }
  })
})

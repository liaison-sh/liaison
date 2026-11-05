// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Presentation-logic oracles. The formatAge suite is the temporal-sanity
// standing oracle (gestalt contract): no raw hours figure above 72, no raw
// minute figure above 59, no raw day figure above 60, never a negative or
// absurd magnitude for any input in a 5-year sweep.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  activityAuthorLabel,
  commentErrorText,
  formatAge,
  formatStamp,
  INCIDENT_COLUMNS,
  incidentPath,
  isLongText,
  openIncidentsLabel,
  phoneCellClass,
  severityMeta,
  statusMeta,
} from "./format"

const NOW = Date.parse("2026-07-11T12:00:00.000Z")

describe("formatAge", () => {
  it("formats the canonical buckets", () => {
    expect(formatAge(new Date(NOW - 20_000).toISOString(), NOW)).toBe("just now")
    expect(formatAge(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe("4m ago")
    expect(formatAge(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h ago")
    expect(formatAge(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2d ago")
    expect(formatAge(new Date(NOW - 90 * 86_400_000).toISOString(), NOW)).toBe("3mo ago")
    expect(formatAge(new Date(NOW - 400 * 86_400_000).toISOString(), NOW)).toBe("1y ago")
  })

  it("degrades to a dash for null, garbage, and far-future timestamps", () => {
    expect(formatAge(null, NOW)).toBe("-")
    expect(formatAge(undefined, NOW)).toBe("-")
    expect(formatAge("not-a-date", NOW)).toBe("-")
    expect(formatAge(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBe("-")
  })

  it("treats small clock skew (slightly-future timestamps) as just now", () => {
    expect(formatAge(new Date(NOW + 30_000).toISOString(), NOW)).toBe("just now")
    expect(formatAge(new Date(NOW + 100_000).toISOString(), NOW)).toBe("just now")
  })

  it("temporal sanity: never emits an absurd magnitude across a 5-year sweep", () => {
    // Sweep every 7h step over 5 years; assert unit-bounded figures.
    for (let ageMs = 0; ageMs < 5 * 365 * 86_400_000; ageMs += 7 * 3_600_000) {
      const out = formatAge(new Date(NOW - ageMs).toISOString(), NOW)
      const m = /^(\d+)(m|h|d|mo|y) ago$/.exec(out)
      if (out === "just now") continue
      expect(m).not.toBeNull()
      const n = Number(m?.[1])
      const unit = m?.[2]
      if (unit === "m") expect(n).toBeLessThanOrEqual(59)
      if (unit === "h") expect(n).toBeLessThanOrEqual(23) // rolls to days at 24h — never a raw 72h+
      if (unit === "d") expect(n).toBeLessThanOrEqual(60)
      if (unit === "mo") expect(n).toBeLessThanOrEqual(12)
      expect(n).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("severity/status meta", () => {
  it("maps severities to tinted tones, never raw enum text", () => {
    expect(severityMeta("critical")).toEqual({ tone: "error", label: "Critical" })
    expect(severityMeta("warning")).toEqual({ tone: "warning", label: "Warning" })
    expect(severityMeta("info")).toEqual({ tone: "accent", label: "Info" })
    expect(severityMeta("weird")).toEqual({ tone: "muted", label: "-" })
    expect(severityMeta(null)).toEqual({ tone: "muted", label: "-" })
  })
  it("maps statuses", () => {
    expect(statusMeta("open").label).toBe("Open")
    expect(statusMeta("acknowledged").label).toBe("Acknowledged")
    expect(statusMeta("resolved").label).toBe("Resolved")
    expect(statusMeta("x").label).toBe("-")
  })
})

describe("incidentPath", () => {
  it("builds the tab URL and encodes hostile ids", () => {
    expect(incidentPath("abc-123")).toBe("/monitoring/incident/abc-123")
    expect(incidentPath("a/b:c")).toBe("/monitoring/incident/a%2Fb%3Ac")
  })
})

describe("formatStamp", () => {
  it("renders a compact stamp and dashes for garbage", () => {
    expect(formatStamp("2026-07-11T09:05:00.000Z")).toMatch(/^2026-07-11 \d{2}:\d{2}$/)
    expect(formatStamp(null)).toBe("-")
    expect(formatStamp("nope")).toBe("-")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Phone width (spec-responsive.md): the incident table is a comparison
// table, so it declares which columns survive 390 px and moves the rest
// behind the row's own expand instead of collapsing into cards.
// ─────────────────────────────────────────────────────────────────────────
describe("incident phone columns", () => {
  // The cross-source incident table (Acknowledged / Resolved lists); the
  // Overview is lanes by source, whose rows drop columns at phone width.
  const source = readFileSync(join(import.meta.dir, "StatusList.tsx"), "utf8")

  it("declares the surviving incident columns explicitly", () => {
    expect(INCIDENT_COLUMNS.map((c) => c.key)).toEqual([
      "severity",
      "incident",
      "source",
      "count",
      "last_seen",
      "status",
      "actions",
    ])
    expect(INCIDENT_COLUMNS.filter((c) => c.survivesPhone).map((c) => c.key)).toEqual([
      "severity",
      "incident",
      "actions",
    ])
  })

  it("paints a survivor at every width and hides the rest until the row expands", () => {
    expect(phoneCellClass("severity", INCIDENT_COLUMNS, false)).toBe("")
    expect(phoneCellClass("source", INCIDENT_COLUMNS, false)).toBe("hidden md:table-cell")
    expect(phoneCellClass("source", INCIDENT_COLUMNS, true)).toBe("block md:table-cell")
  })

  it("renders the incident board through the shared CardTable, which handles the phone card story itself", () => {
    expect(source).toContain('import { CardTable } from "@liaison/app-ui/card-table"')
    expect(source).toContain("<CardTable")
  })
})

describe("openIncidentsLabel", () => {
  it("agrees in number in English and French", () => {
    try {
      ;(globalThis as { __liaisonHost?: unknown }).__liaisonHost = { locale: () => "en" }
      expect(openIncidentsLabel(1)).toBe("1 open incident")
      expect(openIncidentsLabel(3)).toBe("3 open incidents")
      ;(globalThis as { __liaisonHost?: unknown }).__liaisonHost = { locale: () => "fr" }
      expect(openIncidentsLabel(1)).toBe("1 incident ouvert")
      expect(openIncidentsLabel(3)).toBe("3 incidents ouverts")
    } finally {
      ;(globalThis as { __liaisonHost?: unknown }).__liaisonHost = undefined
    }
  })
})

describe("activity helpers", () => {
  it("names the author of a comment", () => {
    const names = new Map([["u-1", "Alice Chen"]])
    expect(activityAuthorLabel(null, names)).toBe("System")
    expect(activityAuthorLabel("u-1", names)).toBe("Alice Chen")
    expect(activityAuthorLabel("u-2", names)).toBe("a teammate")
    expect(activityAuthorLabel("u-1", undefined)).toBe("a teammate")
  })

  it("flags long text at more than 300 characters or more than 4 lines", () => {
    expect(isLongText("a".repeat(300))).toBe(false)
    expect(isLongText("a".repeat(301))).toBe(true)
    expect(isLongText("1\n2\n3\n4")).toBe(false)
    expect(isLongText("1\n2\n3\n4\n5")).toBe(true)
    expect(isLongText(null)).toBe(false)
    expect(isLongText(undefined)).toBe(false)
    expect(isLongText("")).toBe(false)
  })

  it("maps the comment error codes to sentences and passes other errors through", () => {
    expect(commentErrorText("empty_comment: the comment is empty")).toBe("Write a comment before adding it.")
    expect(commentErrorText("comment_too_long: at most 4000 characters")).toBe(
      "The comment is too long (4000 characters at most).",
    )
    expect(commentErrorText("incident_not_found: INC-9")).toBe("incident_not_found: INC-9")
  })
})

// The components have no render harness: these source checks pin the wiring the helpers rely on.
describe("incident ref and activity wiring", () => {
  const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8")
  const detail = read("IncidentDetail.tsx")
  const row = read("incident-row.tsx")

  it("acts on the fetched row's UUID, never on the route id, once the incident is loaded", () => {
    expect(detail).toContain("const currentId = () => incident()?.id ?? incidentId()")
    expect(detail).toContain("const params: Record<string, unknown> = { incidentId: currentId() }")
    expect(detail).toContain('app.invokeTool("incidents_comment", { incidentId: currentId(), body })')
    expect(detail).not.toContain("incidentId: incidentId()")
  })

  it("wires the comment box, its submit and the truncation line, and hides a null ref", () => {
    for (const testid of [
      'data-testid="monitoring-detail-comment"',
      'testid="monitoring-detail-comment-submit"',
      'data-testid="monitoring-activity-truncated"',
      'testid="monitoring-detail-ref"',
    ]) {
      expect(detail).toContain(testid)
    }
    expect(detail).toContain("<Show when={inc().commentsTruncated}>")
    expect(read("ref-tag.tsx")).toContain("<Show when={props.value}>")
  })

  it("keeps the row actions in a fixed 208px column whose labels and status tag never wrap", () => {
    expect(row).toContain("md:grid-cols-[16px_minmax(0,1fr)_96px_52px_84px_208px]")
    expect(row.match(/whitespace-nowrap/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(read("StatusList.tsx")).toContain('cx("whitespace-nowrap rounded-[5px]')
  })
})

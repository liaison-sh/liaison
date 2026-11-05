// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Oracles for the by-source monitoring views (spec S9): display order,
// unprofiled alphabetical, lane collapse, callout iff urgent live > 0, the
// generic critical default without urgent profiles, deterministic hue (urgent
// never hued), auto-resolved detection and link safety.
import { describe, expect, it } from "bun:test"
import { appHue } from "@liaison/app-ui/hue"
import { SOURCES_CONFIG_KEY } from "../lib/profiles"
import type { SourceHealth } from "../lib/summarize"
import {
  badgeKind,
  buildSourceViews,
  decodeSourceId,
  draftFromSummary,
  groupBySource,
  type IncidentLike,
  isAutoResolved,
  monogram,
  moveRow,
  profilesFromDraft,
  safeHttpUrl,
  SOURCES_KEY,
  sourceHue,
  sourcePath,
  sourceStats,
  type SummaryForSources,
  urgentCallouts,
} from "./sources"
import { liveIncidentsLabel } from "./format"

const health = (source: string, open: number, worst: SourceHealth["worstSeverity"], last = "2026-10-15T10:00:00.000Z"): SourceHealth => ({
  source,
  open,
  worstSeverity: worst,
  lastSeenAt: last,
})

let n = 0
const inc = (source: string, severity: string, status = "open", extra: Partial<IncidentLike> = {}): IncidentLike => ({
  id: `i${++n}`,
  source,
  severity,
  title: `${source} ${severity}`,
  status,
  count: 1,
  lastSeenAt: `2026-10-15T10:${String(n % 60).padStart(2, "0")}:00.000Z`,
  ...extra,
})

const profiled: SummaryForSources = {
  sources: [health("watchdog-prod", 2, "warning"), health("aws-security", 2, "critical"), health("backup-cron", 0, null)],
  profiles: [
    { source: "aws-security", label: "AWS Security", rank: 1, urgent: true },
    { source: "watchdog-prod", label: "Watchdog prod", rank: 2 },
    { source: "aws-cloudwatch", label: "CloudWatch", rank: 3, hue: 66 },
  ],
  sourceOrder: ["aws-security", "watchdog-prod", "aws-cloudwatch", "backup-cron"],
}

const unprofiled: SummaryForSources = {
  sources: [health("zeta", 1, "warning"), health("alpha", 1, "critical"), health("mid", 0, null)],
  profiles: [],
  sourceOrder: ["alpha", "mid", "zeta"],
}

describe("buildSourceViews", () => {
  it("follows the server order, profiled first, and keeps sources never seen", () => {
    const views = buildSourceViews(profiled)
    expect(views.map((v) => v.source)).toEqual(["aws-security", "watchdog-prod", "aws-cloudwatch", "backup-cron"])
    expect(views.map((v) => v.label)).toEqual(["AWS Security", "Watchdog prod", "CloudWatch", "backup-cron"])
    expect(views.find((v) => v.source === "aws-cloudwatch")?.live).toBe(0)
  })

  it("appends sources only seen in incidents alphabetically, after the ordered ones", () => {
    const views = buildSourceViews(unprofiled, ["yak", "beta", "alpha"])
    expect(views.map((v) => v.source)).toEqual(["alpha", "mid", "zeta", "beta", "yak"])
  })

  it("derives tone and badge from live count and worst severity", () => {
    const views = buildSourceViews(profiled)
    expect(views.map((v) => badgeKind(v))).toEqual(["critical", "warning", "clear", "clear"])
    expect(views[0]?.urgent).toBe(true)
    expect(views[1]?.urgent).toBe(false)
  })
})

describe("hue", () => {
  it("is the app-colour hash of the id unless the profile sets one", () => {
    expect(sourceHue("backup-cron")).toBe(appHue("backup-cron"))
    expect(sourceHue("backup-cron")).toBe(sourceHue("backup-cron"))
    expect(sourceHue("aws-cloudwatch", { source: "aws-cloudwatch", hue: 66 })).toBe(66)
    const views = buildSourceViews(profiled)
    expect(views.find((v) => v.source === "aws-cloudwatch")?.hue).toBe(66)
    expect(views.find((v) => v.source === "backup-cron")?.hue).toBe(appHue("backup-cron"))
  })

  it("matches the shell formula on a known value", () => {
    // hash = (hash*31 + code) % 360 over "ab": (0*31+97)%360 = 97, (97*31+98)%360 = 3105 % 360 = 225
    expect(appHue("ab")).toBe(225)
  })
})

describe("monogram", () => {
  it("takes the initials of two words or two letters of one", () => {
    expect(monogram("Watchdog prod")).toBe("WP")
    expect(monogram("backup-cron")).toBe("BC")
    expect(monogram("CloudWatch")).toBe("CW")
    expect(monogram("grafana")).toBe("GR")
    expect(monogram("--")).toBe("?")
  })
})

describe("groupBySource", () => {
  it("gives one lane per source in order and collapses quiet lanes", () => {
    const views = buildSourceViews(profiled)
    const lanes = groupBySource(views, [
      inc("aws-security", "critical"),
      inc("watchdog-prod", "warning"),
      inc("watchdog-prod", "warning", "acknowledged"),
      inc("backup-cron", "warning", "resolved"),
    ])
    expect(lanes.map((l) => [l.source.source, l.incidents.length, l.collapsed])).toEqual([
      ["aws-security", 1, false],
      ["watchdog-prod", 2, false],
      ["aws-cloudwatch", 0, true],
      ["backup-cron", 0, true],
    ])
  })

  it("applies the severity filter to every lane", () => {
    const views = buildSourceViews(profiled)
    const lanes = groupBySource(views, [inc("aws-security", "critical"), inc("watchdog-prod", "warning")], "critical")
    expect(lanes.map((l) => l.incidents.length)).toEqual([1, 0, 0, 0])
    expect(lanes[1]?.collapsed).toBe(true)
  })

  it("sorts a lane newest first", () => {
    const views = buildSourceViews(unprofiled)
    const a = inc("zeta", "warning", "open", { lastSeenAt: "2026-10-15T08:00:00.000Z" })
    const b = inc("zeta", "warning", "open", { lastSeenAt: "2026-10-15T09:00:00.000Z" })
    const lane = groupBySource(views, [a, b]).find((l) => l.source.source === "zeta")
    expect(lane?.incidents.map((i) => i.id)).toEqual([b.id, a.id])
  })
})

describe("urgentCallouts", () => {
  it("calls out an urgent source with live incidents, with its newest incident", () => {
    const views = buildSourceViews(profiled)
    const older = inc("aws-security", "critical", "open", { lastSeenAt: "2026-10-15T08:00:00.000Z" })
    const newer = inc("aws-security", "warning", "acknowledged", { lastSeenAt: "2026-10-15T09:00:00.000Z" })
    const callouts = urgentCallouts(views, [older, newer, inc("watchdog-prod", "critical")])
    expect(callouts.map((c) => [c.source.source, c.live, c.newest?.id])).toEqual([["aws-security", 2, newer.id]])
    // The acknowledged one is someone's already: it is not counted as open.
    expect(callouts.map((c) => [c.open, c.acknowledged])).toEqual([[1, 1]])
  })

  it("an urgent source whose live incidents are all acknowledged says so, never 'open'", () => {
    const views = buildSourceViews({
      ...profiled,
      sources: [health("aws-security", 1, "critical"), health("watchdog-prod", 0, null)],
    })
    const acked = inc("aws-security", "critical", "acknowledged")
    const [c] = urgentCallouts(views, [acked])
    expect(c && [c.open, c.acknowledged]).toEqual([0, 1])
    expect(liveIncidentsLabel(c!.open, c!.acknowledged)).toBe("1 acknowledged incident")
    expect(liveIncidentsLabel(2, 0)).toBe("2 open incidents")
    expect(liveIncidentsLabel(1, 2)).toBe("1 open, 2 acknowledged")
  })

  it("is empty when the urgent source has nothing live, even if another source is critical", () => {
    const summary: SummaryForSources = {
      ...profiled,
      sources: [health("aws-security", 0, null), health("watchdog-prod", 3, "critical")],
    }
    expect(urgentCallouts(buildSourceViews(summary), [inc("watchdog-prod", "critical")])).toEqual([])
  })

  it("without urgent profiles, calls out any source with a live critical", () => {
    const views = buildSourceViews(unprofiled)
    expect(urgentCallouts(views, []).map((c) => c.source.source)).toEqual(["alpha"])
    const quiet: SummaryForSources = { ...unprofiled, sources: [health("zeta", 1, "warning")] }
    expect(urgentCallouts(buildSourceViews(quiet), [])).toEqual([])
  })
})

describe("isAutoResolved", () => {
  it("is a resolve with no resolver whose note the source wrote", () => {
    expect(isAutoResolved({ status: "resolved", resolvedBy: null, resolutionNote: "cleared by aws at 2026-10-15T09:12:00.000Z" })).toBe(true)
    expect(isAutoResolved({ status: "resolved", resolvedBy: "u1", resolutionNote: "cleared by aws at x" })).toBe(false)
    expect(isAutoResolved({ status: "resolved", resolvedBy: null, resolutionNote: "closed in sg-0a1" })).toBe(false)
    expect(isAutoResolved({ status: "resolved", resolvedBy: null, resolutionNote: null })).toBe(false)
    expect(isAutoResolved({ status: "open", resolvedBy: null, resolutionNote: "cleared by aws" })).toBe(false)
  })
})

describe("safeHttpUrl", () => {
  it("keeps http(s) links only", () => {
    expect(safeHttpUrl("https://grafana.example.com/d/1")).toBe("https://grafana.example.com/d/1")
    expect(safeHttpUrl("http://10.0.0.1:3000")).toBe("http://10.0.0.1:3000")
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull()
    expect(safeHttpUrl("data:text/html,x")).toBeNull()
    expect(safeHttpUrl("//evil.example")).toBeNull()
    expect(safeHttpUrl("ftp://x")).toBeNull()
    expect(safeHttpUrl("https://")).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
  })
})

describe("paths", () => {
  it("encodes the source id and decodes it back", () => {
    const id = "grafana/prod eu#1"
    const path = sourcePath(id)
    expect(path).toBe("/monitoring/source/grafana%2Fprod%20eu%231")
    expect(decodeSourceId(path.slice("/monitoring/source/".length))).toBe(id)
    expect(decodeSourceId("100%")).toBe("100%")
  })
})

describe("sourceStats", () => {
  it("counts open by severity, resolved in 24 h and auto resolved in 7 days", () => {
    const now = Date.parse("2026-10-15T12:00:00.000Z")
    const stats = sourceStats(
      [
        inc("s", "critical"),
        inc("s", "warning"),
        inc("s", "critical", "acknowledged"),
        inc("s", "warning", "resolved", { resolvedAt: "2026-10-15T09:00:00.000Z", resolvedBy: "u1", resolutionNote: "fixed" }),
        inc("s", "warning", "resolved", { resolvedAt: "2026-10-12T09:00:00.000Z", resolvedBy: null, resolutionNote: "cleared by s at x" }),
        inc("s", "warning", "resolved", { resolvedAt: "2026-10-01T09:00:00.000Z", resolvedBy: null, resolutionNote: "cleared by s at y" }),
      ],
      now,
    )
    expect(stats).toEqual({ openCritical: 1, openWarning: 1, resolved24h: 1, autoResolved7d: 1 })
  })
})

describe("Sources settings draft", () => {
  it("writes the keys the server reads", () => {
    expect(SOURCES_KEY).toBe(SOURCES_CONFIG_KEY)
  })


  it("lists every seen and profiled source and saves the order as ranks", () => {
    const rows = draftFromSummary(profiled)
    expect(rows.map((r) => r.source)).toEqual(["aws-security", "watchdog-prod", "aws-cloudwatch", "backup-cron"])
    const moved = moveRow(rows, 3, -1)
    expect(moved.map((r) => r.source)).toEqual(["aws-security", "watchdog-prod", "backup-cron", "aws-cloudwatch"])
    expect(moveRow(rows, 0, -1)).toBe(rows)
    const edited = moved.map((r) => (r.source === "backup-cron" ? { ...r, label: " Backups ", hue: 400 } : r))
    expect(profilesFromDraft(edited)).toEqual([
      { source: "aws-security", rank: 1, label: "AWS Security", urgent: true },
      { source: "watchdog-prod", rank: 2, label: "Watchdog prod" },
      { source: "backup-cron", rank: 3, label: "Backups", hue: 359 },
      { source: "aws-cloudwatch", rank: 4, label: "CloudWatch", hue: 66 },
    ])
  })
})

describe("source tab label", () => {
  it("is the raw id until a profile label is known, then the label", async () => {
    const { rememberSourceLabels, resolveSourceTabLabel } = await import("./tab-labels")
    expect(resolveSourceTabLabel(encodeURIComponent("grafana/prod"))).toBe("grafana/prod")
    rememberSourceLabels([{ source: "grafana/prod", label: "Grafana production" }])
    expect(resolveSourceTabLabel(encodeURIComponent("grafana/prod"))).toBe("Grafana production")
    expect(resolveSourceTabLabel("grafana/prod")).toBe("Grafana production")
    expect(resolveSourceTabLabel("")).toBeUndefined()
  })
})

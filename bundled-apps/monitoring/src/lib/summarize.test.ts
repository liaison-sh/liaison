// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { IncidentView } from "../incidents"
import { summarize } from "./summarize"

const NOW = Date.parse("2026-07-11T12:00:00.000Z")

function inc(over: Partial<IncidentView>): IncidentView {
  return {
    id: over.id ?? "i1",
    ref: over.ref ?? null,
    source: over.source ?? "watchdog-prod",
    severity: over.severity ?? "critical",
    title: over.title ?? "t",
    body: null,
    dedupKey: null,
    url: null,
    status: over.status ?? "open",
    count: over.count ?? 1,
    firstSeenAt: over.firstSeenAt ?? null,
    lastSeenAt: over.lastSeenAt ?? null,
    alertTs: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: over.resolvedAt ?? null,
    resolvedBy: null,
    reopenedAt: null,
    resolutionNote: null,
  }
}

describe("summarize", () => {
  it("counts open by severity, acknowledged separately", () => {
    const s = summarize(
      [
        inc({ id: "1", severity: "critical" }),
        inc({ id: "2", severity: "critical" }),
        inc({ id: "3", severity: "warning" }),
        inc({ id: "4", severity: "info" }),
        inc({ id: "5", severity: "critical", status: "acknowledged" }),
      ],
      [],
      NOW,
    )
    expect(s.open).toEqual({ critical: 2, warning: 1, info: 1, total: 4 })
    expect(s.acknowledged).toBe(1)
  })

  it("resolved24h counts only the trailing window", () => {
    const s = summarize(
      [],
      [
        inc({ id: "1", status: "resolved", resolvedAt: new Date(NOW - 3_600_000).toISOString() }),
        inc({ id: "2", status: "resolved", resolvedAt: new Date(NOW - 30 * 3_600_000).toISOString() }),
        inc({ id: "3", status: "resolved", resolvedAt: null }),
      ],
      NOW,
    )
    expect(s.resolved24h).toBe(1)
  })

  it("per-source health: live count, worst severity ratchet, last-seen across all statuses", () => {
    const s = summarize(
      [
        inc({ id: "1", source: "a", severity: "warning", lastSeenAt: "2026-07-11T10:00:00.000Z" }),
        inc({ id: "2", source: "a", severity: "critical", lastSeenAt: "2026-07-11T09:00:00.000Z" }),
        inc({ id: "3", source: "b", severity: "info", lastSeenAt: "2026-07-11T11:00:00.000Z" }),
      ],
      [
        inc({
          id: "4",
          source: "c",
          status: "resolved",
          resolvedAt: new Date(NOW - 1000).toISOString(),
          lastSeenAt: "2026-07-11T11:30:00.000Z",
        }),
      ],
      NOW,
    )
    const a = s.sources.find((x) => x.source === "a")
    expect(a).toEqual({
      source: "a",
      open: 2,
      worstSeverity: "critical",
      lastSeenAt: "2026-07-11T10:00:00.000Z",
    })
    // Quiet source (only resolved history) shows open 0, null severity, but keeps recency.
    const c = s.sources.find((x) => x.source === "c")
    expect(c).toEqual({ source: "c", open: 0, worstSeverity: null, lastSeenAt: "2026-07-11T11:30:00.000Z" })
    // Loudest first.
    expect(s.sources[0]?.source).toBe("a")
  })

  it("is deterministic for the injected clock", () => {
    const s = summarize([], [], NOW)
    expect(s.generatedAt).toBe("2026-07-11T12:00:00.000Z")
  })
})

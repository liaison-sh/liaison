// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Source profiles (`monitoringSources` app config): parsing drops invalid
// entries with a warning each, and the source order is profiled-by-rank then
// unprofiled alphabetical.
import { describe, expect, it } from "bun:test"
import { orderSources, parseMonitoringUrl, parseSourceProfiles } from "./profiles"

describe("parseSourceProfiles", () => {
  it("returns no profiles and no warning when the key is unset", () => {
    expect(parseSourceProfiles(null)).toEqual({ profiles: [], warnings: [] })
    expect(parseSourceProfiles(undefined)).toEqual({ profiles: [], warnings: [] })
  })

  it("keeps valid entries with only their known fields", () => {
    const { profiles, warnings } = parseSourceProfiles([
      { source: "watchdog-prod", label: "Production", rank: 1, urgent: true, hue: 210, extra: "x" },
      { source: "cron" },
    ])
    expect(warnings).toEqual([])
    expect(profiles).toEqual([
      { source: "watchdog-prod", label: "Production", rank: 1, urgent: true, hue: 210 },
      { source: "cron" },
    ])
  })

  it("accepts the value stored as a JSON string", () => {
    expect(parseSourceProfiles('[{"source":"a","rank":2}]').profiles).toEqual([{ source: "a", rank: 2 }])
  })

  it("drops each invalid entry and reports it", () => {
    const { profiles, warnings } = parseSourceProfiles([
      { source: "ok" },
      { label: "no source" },
      { source: "" },
      { source: "badhue", hue: 360 },
      { source: "fraction", hue: 12.5 },
      { source: "badrank", rank: "first" },
      { source: "badurgent", urgent: "yes" },
      "not an object",
      { source: "ok", label: "duplicate" },
    ])
    expect(profiles).toEqual([{ source: "ok" }])
    expect(warnings.length).toBe(8)
    expect(warnings[0]).toContain("monitoringSources[1]")
    expect(warnings[7]).toContain("duplicate")
  })

  it("reports a value that is not an array", () => {
    expect(parseSourceProfiles({ source: "a" })).toEqual({ profiles: [], warnings: ["monitoringSources is not a list"] })
    expect(parseSourceProfiles("{oops").warnings).toEqual(["monitoringSources is not valid JSON"])
  })
})

describe("orderSources", () => {
  it("puts profiled sources first by rank, then unprofiled seen sources alphabetically", () => {
    const profiles = [{ source: "b", rank: 2 }, { source: "z", rank: 1 }, { source: "m" }]
    expect(orderSources(["y", "a", "b", "x"], profiles)).toEqual(["z", "b", "m", "a", "x", "y"])
  })

  it("is alphabetical without profiles", () => {
    expect(orderSources(["c", "a", "b", "a"], [])).toEqual(["a", "b", "c"])
  })
})

describe("parseMonitoringUrl", () => {
  it("keeps http and https only", () => {
    expect(parseMonitoringUrl("https://grafana.example.com/d/1")).toBe("https://grafana.example.com/d/1")
    expect(parseMonitoringUrl("http://grafana.internal")).toBe("http://grafana.internal")
    expect(parseMonitoringUrl("javascript:alert(1)")).toBeNull()
    expect(parseMonitoringUrl("grafana.example.com")).toBeNull()
    expect(parseMonitoringUrl("")).toBeNull()
    expect(parseMonitoringUrl(42)).toBeNull()
    expect(parseMonitoringUrl(null)).toBeNull()
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"

// The module caches its result at module scope (`_cached`), so each scenario
// needs a fresh module instance to observe the uncached path.
async function freshModule() {
  vi.resetModules()
  return import("~/lib/timezones")
}

describe("getTimezones", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("always includes UTC, even when the platform list omits the short alias", async () => {
    vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(["America/New_York", "Europe/Paris"])
    const { getTimezones } = await freshModule()
    expect(getTimezones()).toContain("UTC")
  })

  it("does not duplicate UTC when the platform list already has it", async () => {
    vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(["UTC", "Europe/Paris"])
    const { getTimezones } = await freshModule()
    expect(getTimezones().filter((tz) => tz === "UTC")).toHaveLength(1)
  })

  it("caches the result: a second call returns the same list without recomputing", async () => {
    const supportedValuesOf = vi
      .spyOn(Intl, "supportedValuesOf")
      .mockReturnValue(["America/New_York"])
    const { getTimezones } = await freshModule()
    const first = getTimezones()
    const second = getTimezones()
    expect(second).toBe(first)
    expect(supportedValuesOf).toHaveBeenCalledTimes(1)
  })

  it("falls back to the hardcoded list (still including UTC) when supportedValuesOf throws", async () => {
    vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
      throw new Error("not supported in this environment")
    })
    const { getTimezones } = await freshModule()
    const list = getTimezones()
    expect(list).toContain("UTC")
    expect(list).toContain("America/New_York")
    expect(list.length).toBeGreaterThan(1)
  })
})

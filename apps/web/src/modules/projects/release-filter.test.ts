// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import {
  effectiveRelease,
  fetchReleases,
  matchesRelease,
  RELEASE_NONE,
  releaseParam,
} from "~/modules/projects/release-filter"

describe("fetchReleases", () => {
  it("reads GET /projects/releases and keeps well-formed rows", async () => {
    const get = vi.fn(async () => [
      { value: "2.1.0", count: 3 },
      { value: "", count: 1 },
      { value: "2.2.0", count: "4" },
      null,
      { count: 2 },
    ])
    const rows = await fetchReleases({ get } as any)
    expect(get).toHaveBeenCalledWith("/projects/releases")
    expect(rows).toEqual([
      { value: "2.1.0", count: 3 },
      { value: "2.2.0", count: 4 },
    ])
  })

  it("returns an empty list when the payload is not a list", async () => {
    expect(await fetchReleases({ get: async () => ({}) } as any)).toEqual([])
  })
})

describe("effective release", () => {
  // Parent 2.1.0, child none, grandchild 2.2.0 (spec edge-case table).
  const parent = { id: "p", parentTaskId: null, release: "2.1.0" }
  const child = { id: "c", parentTaskId: "p", release: null }
  const grandchild = { id: "g", parentTaskId: "c", release: "2.2.0" }
  const orphan = { id: "o", parentTaskId: null }
  const byId = new Map([parent, child, grandchild, orphan].map((t) => [t.id, t]))

  it("inherits the nearest ancestor's release", () => {
    expect(effectiveRelease(child, byId)).toBe("2.1.0")
    expect(effectiveRelease(grandchild, byId)).toBe("2.2.0")
    expect(effectiveRelease(orphan, byId)).toBeNull()
  })

  it("matches case-insensitively, and __none__ selects tasks without one", () => {
    expect(matchesRelease(child, byId, "2.1.0")).toBe(true)
    expect(matchesRelease(grandchild, byId, "2.1.0")).toBe(false)
    expect(matchesRelease({ ...parent, release: "V2" }, byId, "v2")).toBe(true)
    expect(matchesRelease(orphan, byId, RELEASE_NONE)).toBe(true)
    expect(matchesRelease(child, byId, RELEASE_NONE)).toBe(false)
    expect(matchesRelease(orphan, byId, null)).toBe(true)
  })

  it("encodes the list query param", () => {
    expect(releaseParam(null)).toBeNull()
    expect(releaseParam("2.1 beta")).toBe("release=2.1%20beta")
  })
})

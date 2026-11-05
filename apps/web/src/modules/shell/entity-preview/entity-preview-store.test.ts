// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("entity-preview-store", () => {
  beforeEach(async () => {
    const { resetEntityPreviewStore } = await import("./entity-preview-store")
    resetEntityPreviewStore()
  })

  it("caches by app/entity/id key", async () => {
    const api = { getEnvelope: vi.fn().mockResolvedValue({ data: [] }) }
    const fetcher = vi.fn().mockResolvedValue({ id: "abc" })
    const { getCached, loadPreview } = await import("./entity-preview-store")

    expect(getCached("kernel", "contact", "abc")).toBeUndefined()
    await loadPreview(api as any, "kernel", "contact", "abc", fetcher)

    expect(getCached("kernel", "contact", "abc")?.entity).toEqual({ id: "abc" })
    expect(api.getEnvelope).toHaveBeenCalledWith("/timeline/kernel/contact/abc?limit=5")
  })

  it("invalidates the cached preview", async () => {
    const api = { getEnvelope: vi.fn().mockResolvedValue({ data: [] }) }
    const { getCached, invalidatePreview, loadPreview } = await import("./entity-preview-store")

    await loadPreview(
      api as any,
      "kernel",
      "contact",
      "abc",
      vi.fn().mockResolvedValue({ id: "abc" }),
    )
    invalidatePreview("kernel", "contact", "abc")

    expect(getCached("kernel", "contact", "abc")).toBeUndefined()
  })

  it("returns deleted state for entity 404 but keeps timeline when available", async () => {
    const api = {
      getEnvelope: vi.fn().mockResolvedValue({
        data: [
          { actorName: "Alice", action: "updated", createdAt: "2026-01-01" },
          { actorName: null, action: "created", createdAt: "2025-12-31" },
        ],
      }),
    }
    const fetcher = vi.fn().mockRejectedValue({ status: 404 })
    const { getCached, loadPreview } = await import("./entity-preview-store")

    await loadPreview(api as any, "kernel", "contact", "abc", fetcher)
    const cached = getCached("kernel", "contact", "abc")

    expect(cached?.deleted).toBe(true)
    expect(cached?.timeline?.[0]).toEqual({
      actor: "Alice",
      action: "updated",
      occurredAt: "2026-01-01",
    })
    // A system entry has no actor: kept as null for the view, never "Unknown".
    expect(cached?.timeline?.[1]).toEqual({
      actor: null,
      action: "created",
      occurredAt: "2025-12-31",
    })
  })

  it("omits timeline when timeline fetch fails", async () => {
    const api = { getEnvelope: vi.fn().mockRejectedValue(new Error("timeline unavailable")) }
    const { getCached, loadPreview } = await import("./entity-preview-store")

    await loadPreview(
      api as any,
      "kernel",
      "contact",
      "abc",
      vi.fn().mockResolvedValue({ id: "abc" }),
    )

    expect(getCached("kernel", "contact", "abc")?.timeline).toEqual([])
  })
})

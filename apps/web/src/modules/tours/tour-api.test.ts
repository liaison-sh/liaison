// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import type { createApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { createTourApi } from "./tour-api"

type Client = ReturnType<typeof createApiClient>

describe("tour api", () => {
  it("calls the shared routes and unwraps the payloads", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/tours" ? { tours: [{ tourId: "kernel.sample" }] } : { progress: null },
    )
    const post = vi.fn(async () => ({ progress: { tourId: "kernel.sample" } }))
    const api = createTourApi({ get, post } as unknown as Client)
    expect(await api.list()).toEqual([{ tourId: "kernel.sample" }])
    expect(await api.progress("kernel.sample")).toBeNull()
    expect(get).toHaveBeenLastCalledWith("/tours/kernel.sample/progress")
    expect(await api.start("kernel.sample", "help")).toEqual({ tourId: "kernel.sample" })
    expect(post).toHaveBeenCalledWith("/tours/kernel.sample/start", { source: "help" })
  })

  it("a stale compare-and-set (409) resolves to the fresh progress", async () => {
    const patch = vi.fn(async () => {
      throw new ApiError("stale", 409)
    })
    const get = vi.fn(async () => ({ progress: { tourId: "kernel.sample", beatId: "b" } }))
    const api = createTourApi({ get, patch } as unknown as Client)
    expect(await api.update("kernel.sample", { advance: true, fromBeatId: "a" })).toEqual({
      tourId: "kernel.sample",
      beatId: "b",
    })
    expect(patch).toHaveBeenCalledWith(
      "/tours/kernel.sample",
      { advance: true, fromBeatId: "a" },
      { suppressGlobalError: true },
    )
  })

  it("other failures throw", async () => {
    const patch = vi.fn(async () => {
      throw new ApiError("nope", 403)
    })
    const api = createTourApi({ patch } as unknown as Client)
    await expect(api.update("kernel.sample", { status: "paused" })).rejects.toThrow("nope")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// One app's field saves go one at a time: a tool-backed field is written by
// reading the whole object, changing one path and writing it back, so two
// saves in flight together lose the first one (two ship-from fields filled in
// a row kept only the last).
import { describe, expect, it } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { saveSetting } from "./settings-api"

describe("saveSetting", () => {
  it("runs one app's saves one after the other", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const order: string[] = []
    const api = {
      patch: async (_url: string, body: { path: string }) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 10))
        order.push(body.path)
        inFlight--
        return { path: body.path, value: 1 }
      },
    } as unknown as ApiClient
    await Promise.all([
      saveSetting(api, "boxtal", "org", "name", "A"),
      saveSetting(api, "boxtal", "org", "city", "B"),
      saveSetting(api, "boxtal", "org", "phone", "C"),
    ])
    expect(maxInFlight).toBe(1)
    expect(order).toEqual(["name", "city", "phone"])
  })

  it("a refused save does not block the next one", async () => {
    let n = 0
    const api = {
      patch: async () => {
        n++
        if (n === 1) throw new Error("refused")
        return { path: "b", value: 2 }
      },
    } as unknown as ApiClient
    await expect(saveSetting(api, "x", "org", "a", 1)).rejects.toThrow("refused")
    await expect(saveSetting(api, "x", "org", "b", 2)).resolves.toEqual({ kind: "saved", value: 2 })
  })
})

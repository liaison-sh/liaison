// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it, spyOn } from "bun:test"
import { env } from "~/lib/env"

let clientModule: typeof import("./client")

describe("MeiliSearch client", () => {
  beforeAll(async () => {
    clientModule = await import("./client")
    clientModule.MeiliClientTestAccess.reset()
  })

  it("effectiveIndexName returns prefix + canonical name", () => {
    expect(clientModule.effectiveIndexName()).toBe(`${env.MEILI_INDEX_PREFIX ?? ""}liaison_search`)
  })

  it("getMeili returns a singleton", () => {
    expect(clientModule.getMeili()).toBe(clientModule.getMeili())
  })

  it("ensureMeiliVectorStore switches the feature on once, and retries after a failure", async () => {
    clientModule.MeiliClientTestAccess.reset()
    const http = clientModule.getMeili().httpRequest
    const calls: unknown[] = []
    let fail = true
    const spy = spyOn(http, "patch").mockImplementation((async (req: unknown) => {
      calls.push(req)
      if (fail) throw new Error("meili down")
      return {}
    }) as never)
    try {
      await expect(clientModule.ensureMeiliVectorStore()).rejects.toThrow("meili down")
      fail = false
      await clientModule.ensureMeiliVectorStore()
      await clientModule.ensureMeiliVectorStore()
      expect(calls).toEqual([
        { path: "experimental-features", body: { vectorStore: true } },
        { path: "experimental-features", body: { vectorStore: true } },
      ])
    } finally {
      spy.mockRestore()
      clientModule.MeiliClientTestAccess.reset()
    }
  })
})

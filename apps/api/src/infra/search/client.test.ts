// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
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
})

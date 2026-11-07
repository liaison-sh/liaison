// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as client from "~/infra/search/client"
import * as search from "./search"
import { adoptEmbedder, embedderAdoptable, userProvidedDimensions } from "./search"

describe("userProvidedDimensions", () => {
  it("reads the width of a userProvided memory embedder signature", () => {
    expect(userProvidedDimensions("memory:userProvided:3072")).toBe(3072)
  })
  it("is null for none, another source or another embedder name", () => {
    expect(userProvidedDimensions("none")).toBeNull()
    expect(userProvidedDimensions("memory:openAi:3072")).toBeNull()
    expect(userProvidedDimensions("other:userProvided:8")).toBeNull()
    expect(userProvidedDimensions("memory:userProvided:")).toBeNull()
  })
})

describe("embedder fit on a move", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore()
  })

  it("a source declaring none fits any index, without asking it", async () => {
    const sig = spyOn(search, "embedderSignature").mockResolvedValue("memory:userProvided:8")
    spies.push(sig)
    expect(await embedderAdoptable("none")).toBe("same")
    expect(sig).not.toHaveBeenCalled()
  })

  it("adoption refuses once another embedder is declared here, and never writes the settings", async () => {
    spies.push(spyOn(search, "embedderSignature").mockResolvedValue("memory:userProvided:16"))
    const meili = spyOn(client, "getMeili")
    spies.push(meili)
    await expect(adoptEmbedder("memory:userProvided:8")).rejects.toThrow(
      /declares memory:userProvided:16 now/,
    )
    expect(meili).not.toHaveBeenCalled()
  })

  it("adoption refuses when the settings show an embedder declared after the first read", async () => {
    spies.push(spyOn(search, "embedderSignature").mockResolvedValue("none"))
    spies.push(spyOn(client, "ensureMeiliVectorStore").mockResolvedValue())
    let updated = false
    const index = {
      getSettings: async () => ({
        embedders: { memory: { source: "userProvided", dimensions: 16 } },
      }),
      updateEmbedders: async () => {
        updated = true
        return { taskUid: 1 }
      },
    }
    spies.push(spyOn(client, "getMeili").mockReturnValue({ index: () => index } as never))
    await expect(adoptEmbedder("memory:userProvided:8")).rejects.toThrow(/declared here meanwhile/)
    expect(updated).toBe(false)
  })
})

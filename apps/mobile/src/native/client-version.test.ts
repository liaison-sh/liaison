// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createClientVersion } from "./client-version"

const app = (build: string) => ({ getInfo: async () => ({ version: "1.0", build }) })

describe("the phone app's version for its server", () => {
  it("is 1.0.<build> on iOS", async () => {
    const read = createClientVersion({ app: app("36"), platform: () => "ios" })
    expect(await read()).toEqual({ platform: "ios", version: "1.0.36" })
  })

  it("is 1.0.<version code> on Android", async () => {
    const read = createClientVersion({ app: app("7"), platform: () => "android" })
    expect(await read()).toEqual({ platform: "android", version: "1.0.7" })
  })

  it("is nothing on the web, or when the build cannot be read", async () => {
    expect(await createClientVersion({ app: app("36"), platform: () => "web" })()).toBeNull()
    expect(await createClientVersion({ app: app("abc"), platform: () => "ios" })()).toBeNull()
    const broken = {
      getInfo: async (): Promise<{ version: string; build: string }> => {
        throw new Error("not implemented")
      },
    }
    expect(await createClientVersion({ app: broken, platform: () => "ios" })()).toBeNull()
  })
})

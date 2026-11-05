// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shelf publishes the authentication session on the bridge apps/web reads
// (Login.tsx signs in with Google through it on iOS). Off device the plugin is
// not registered, so the published call answers null and the page keeps its
// web navigation.
import { describe, expect, it } from "bun:test"
import { publishedNativeBridge } from "../bridge/native-bridge"
import { installNativeShelf } from "./shelf"

describe("the shelf's authentication session", () => {
  it("is published on the bridge and answers null without the native plugin", async () => {
    const target: Record<string, unknown> = {}
    installNativeShelf(target)
    const authenticate = publishedNativeBridge(target)?.authenticate
    expect(typeof authenticate).toBe("function")
    expect(
      await authenticate!({
        url: "https://liaison.example/api/auth/oauth/g/authorize",
        callbackScheme: "liaison",
      }),
    ).toBeNull()
  })
})

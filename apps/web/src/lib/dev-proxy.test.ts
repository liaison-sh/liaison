// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { devProxyFor } from "./dev-proxy"

describe("dev proxy", () => {
  it("forwards the API's public webhook URLs, so a printed ingest URL works on a dev checkout", () => {
    const proxy = devProxyFor("http://localhost:3000")
    expect(proxy["/webhooks"]).toEqual({ target: "http://localhost:3000", changeOrigin: true })
    expect(proxy["/api"].target).toBe("http://localhost:3000")
  })
})

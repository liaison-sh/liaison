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

  it("forwards the page's own host when asked, so an org-host server sees this origin", () => {
    const proxy = devProxyFor("http://localhost:3000", { preserveHost: true })
    expect(proxy["/api"]).toEqual({ target: "http://localhost:3000", changeOrigin: false })
    expect(proxy["/webhooks"].changeOrigin).toBe(false)
    expect(proxy["/ws"]).toEqual({ target: "http://localhost:3000", ws: true })
  })
})

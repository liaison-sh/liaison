// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { MAX_REDIRECT_HOSTS, redirectHostProblem, validateAdapter } from "./schema"

function adapter(redirectHosts: unknown) {
  return {
    id: "helpdesk",
    name: "Helpdesk",
    version: "1",
    baseUrl: "https://helpdesk.example.com/api",
    auth: { type: "bearer" },
    redirectHosts,
    operations: [
      {
        name: "list",
        description: "List.",
        kind: "read",
        method: "GET",
        path: "/items",
        params: { type: "object", properties: {} },
        fields: ["id"],
      },
    ],
  }
}

describe("adapter redirectHosts", () => {
  it("accepts hostnames under a registrable domain", () => {
    const r = validateAdapter(adapter(["media.example-cdn.com", "files.example.co.uk"]))
    expect(r.ok).toBe(true)
  })

  it("is optional", () => {
    const { redirectHosts: _omit, ...rest } = adapter([])
    expect(validateAdapter(rest).ok).toBe(true)
  })

  it("refuses public suffixes, IP addresses, URLs, wildcards and uppercase", () => {
    for (const host of [
      "com",
      "co.uk",
      "github.io",
      "10.0.0.5",
      "https://cdn.example.com",
      "*.example.com",
      "CDN.example.com",
      "cdn.example.com:8443",
    ]) {
      const r = validateAdapter(adapter([host]))
      expect(r.ok).toBe(false)
    }
    expect(redirectHostProblem("co.uk")).toBe("must not be a public suffix")
    expect(redirectHostProblem("192.168.1.10")).toBe("must be a hostname, not an IP address")
  })

  it("refuses duplicates and more than the maximum", () => {
    expect(validateAdapter(adapter(["a.example.com", "a.example.com"])).ok).toBe(false)
    const many = Array.from({ length: MAX_REDIRECT_HOSTS + 1 }, (_, i) => `h${i}.example.com`)
    expect(validateAdapter(adapter(many)).ok).toBe(false)
  })
})

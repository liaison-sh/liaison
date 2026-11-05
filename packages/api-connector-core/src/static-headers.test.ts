// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { MAX_STATIC_HEADERS, validateAdapter } from "./schema"

function adapter(headers: unknown, auth: Record<string, unknown> = { type: "bearer" }) {
  return {
    id: "servicedesk",
    name: "Service desk",
    version: "1",
    baseUrl: "https://desk.example.com",
    auth,
    headers,
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

describe("adapter static headers", () => {
  it("accepts literal headers such as an API's opt-in flag", () => {
    const r = validateAdapter(
      adapter({ "X-ExperimentalApi": "opt-in", Accept: "application/json" }),
    )
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.adapter.headers).toEqual({
        "X-ExperimentalApi": "opt-in",
        Accept: "application/json",
      })
  })

  it("refuses auth, cookie, hop-by-hop, proxy and forwarding headers, any case", () => {
    for (const name of [
      "Authorization",
      "authorization",
      "Cookie",
      "Host",
      "Content-Length",
      "Transfer-Encoding",
      "Connection",
      "Proxy-Authorization",
      "Proxy-Connection",
      "X-Forwarded-For",
      "X-Forwarded-Host",
      "Forwarded",
    ]) {
      expect(validateAdapter(adapter({ [name]: "x" })).ok).toBe(false)
    }
  })

  it("refuses the header an apiKey auth already sets", () => {
    const r = validateAdapter(
      adapter({ "X-Api-Key": "literal" }, { type: "apiKey", in: "header", name: "X-Api-Key" }),
    )
    expect(r.ok).toBe(false)
  })

  it("refuses values that look like a credential reference, line breaks and bad names", () => {
    for (const value of ["{token}", "Bearer {{secret}}", "${API_KEY}", "a\r\nX-Evil: 1", ""]) {
      expect(validateAdapter(adapter({ "X-Flag": value })).ok).toBe(false)
    }
    expect(validateAdapter(adapter({ "Bad Name": "x" })).ok).toBe(false)
    const many = Object.fromEntries(
      Array.from({ length: MAX_STATIC_HEADERS + 1 }, (_, i) => [`X-H${i}`, "1"]),
    )
    expect(validateAdapter(adapter(many)).ok).toBe(false)
  })
})

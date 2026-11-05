// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression (l445 / sofia-promote): jsonb columns surface EITHER pre-parsed (default postgres.js,
// host tests) OR as a raw JSON STRING (the chaos world DB connection for app_mail.messages.from_address
// /to_addresses). mapMailMessageRow read from_address raw, so in the string case fromEmail came back
// empty → mail:convertToTicket copied an inbound message with an EMPTY from_email → the later gated
// tickets:reply preflight failed "ticket has no customer recipient". coerceJson/jsonObject/jsonArray
// must handle both shapes so the convert→reply chain works regardless of the jsonb return mode.

import { describe, expect, it } from "bun:test"
import { coerceJson, jsonArray, jsonObject } from "~/modules/apps/sandbox/rpc-bridge"

describe("rpc-bridge jsonb coercion (l445 from_address-as-string)", () => {
  it("jsonObject reads an email from a from_address that is a JSON STRING (chaos DB shape)", () => {
    const asString = JSON.stringify({ name: "Daniel Weber", email: "daniel.weber@example.com" })
    expect(jsonObject(asString)?.email).toBe("daniel.weber@example.com")
  })

  it("jsonObject reads an email from a from_address that is already a parsed OBJECT (host shape)", () => {
    const asObject = { name: "Daniel Weber", email: "daniel.weber@example.com" }
    expect(jsonObject(asObject)?.email).toBe("daniel.weber@example.com")
  })

  it("jsonObject returns null for null / arrays / non-JSON strings (never a spurious object)", () => {
    expect(jsonObject(null)).toBeNull()
    expect(jsonObject("[1,2,3]")).toBeNull() // a JSON array is not an address object
    expect(jsonObject("not json")).toBeNull()
    expect(jsonObject(42)).toBeNull()
  })

  it("jsonArray reads to_addresses whether a stringified array or a parsed array", () => {
    const recipients = [{ email: "support@x.com" }]
    expect(jsonArray(JSON.stringify(recipients))).toEqual(recipients)
    expect(jsonArray(recipients)).toEqual(recipients)
    expect(jsonArray("{}")).toEqual([]) // an object is not an array
    expect(jsonArray(null)).toEqual([])
  })

  it("coerceJson leaves already-parsed values untouched and parses strings best-effort", () => {
    const obj = { a: 1 }
    expect(coerceJson(obj)).toBe(obj)
    expect(coerceJson('{"a":1}')).toEqual({ a: 1 })
    expect(coerceJson("garbage{")).toBe("garbage{") // unparseable → returned as-is, never throws
  })
})

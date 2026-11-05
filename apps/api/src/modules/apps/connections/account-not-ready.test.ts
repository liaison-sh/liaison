// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { ConnectionCredentialsMissingError } from "./credentials-missing"
import { isAccountNotReadyError } from "./service"

describe("isAccountNotReadyError", () => {
  it("classifies un-authed / disconnected / re-auth account states as not-ready", () => {
    expect(isAccountNotReadyError(new Error("No access token stored"))).toBe(true)
    expect(isAccountNotReadyError(new Error("Account is disconnected"))).toBe(true)
    expect(
      isAccountNotReadyError(new Error("Account requires re-authorization: token expired")),
    ).toBe(true)
    // A connection with no stored credentials, typed or read back from a sandbox message.
    const missing = new ConnectionCredentialsMissingError()
    expect(isAccountNotReadyError(missing)).toBe(true)
    expect(isAccountNotReadyError(new Error(missing.message))).toBe(true)
    expect(
      ConnectionCredentialsMissingError.fromMessage(`Error: ${missing.message}`),
    ).toBeInstanceOf(ConnectionCredentialsMissingError)
    expect(ConnectionCredentialsMissingError.fromMessage("No access token stored")).toBeNull()
  })

  it("does NOT classify real sync/server faults as not-ready", () => {
    expect(isAccountNotReadyError(new Error("ECONNREFUSED"))).toBe(false)
    expect(isAccountNotReadyError(new Error("Gmail API 500"))).toBe(false)
    expect(isAccountNotReadyError(new Error("unexpected token in JSON"))).toBe(false)
    expect(isAccountNotReadyError(null)).toBe(false)
    expect(isAccountNotReadyError(undefined)).toBe(false)
    expect(isAccountNotReadyError("a string, not an Error")).toBe(false)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  getRefreshTokenFromCookie,
  getRefreshTokenFromHeader,
  refreshCookieSpec,
  refreshTokenDelivery,
} from "~/lib/response"

describe("getRefreshTokenFromCookie", () => {
  test("rejects cookie header exceeding 4096 bytes", () => {
    const cookie = `liaison_rt=${"a".repeat(5000)}`
    expect(getRefreshTokenFromCookie(cookie)).toBeUndefined()
  })

  test("extracts token from valid cookie", () => {
    const cookie = "liaison_rt=mytoken123"
    expect(getRefreshTokenFromCookie(cookie)).toBe("mytoken123")
  })

  test("returns undefined for missing cookie", () => {
    expect(getRefreshTokenFromCookie(undefined)).toBeUndefined()
  })

  // A sibling subdomain can plant a plain cookie (Domain=parent) but never a
  // __Host- one, so production reads only the __Host- name.
  test("production uses a __Host- cookie and never reads a planted plain one", () => {
    const prod = refreshCookieSpec(true)
    expect(prod).toEqual({ name: "__Host-liaison_rt", path: "/" })
    expect(getRefreshTokenFromCookie("liaison_rt=planted", prod.name)).toBeUndefined()
    expect(getRefreshTokenFromCookie("liaison_rt=planted; __Host-liaison_rt=real", prod.name)).toBe(
      "real",
    )
    expect(getRefreshTokenFromCookie("x__Host-liaison_rt=nope", prod.name)).toBeUndefined()
  })
})

// A wrapped shell's page is served from capacitor://localhost or
// tauri://localhost, so EVERY call it makes to the server is cross site and a
// SameSite=Strict cookie is never attached. The refresh token therefore
// travels in the body for those origins, and nowhere else.
describe("refreshTokenDelivery", () => {
  const appOrigins = ["capacitor://localhost", "tauri://localhost"]

  test("an app origin gets the token in the body and no cookie", () => {
    expect(refreshTokenDelivery("capacitor://localhost", appOrigins, false)).toEqual({
      cookie: false,
      body: true,
    })
    expect(refreshTokenDelivery("tauri://localhost", appOrigins, false)).toEqual({
      cookie: false,
      body: true,
    })
  })

  test("a browser origin gets the cookie and no body token", () => {
    expect(refreshTokenDelivery("https://app.example.com", appOrigins, false)).toEqual({
      cookie: true,
      body: false,
    })
  })

  test("a missing origin is a browser, never an app", () => {
    expect(refreshTokenDelivery(undefined, appOrigins, false)).toEqual({
      cookie: true,
      body: false,
    })
  })

  test("a lookalike origin is not an app origin", () => {
    expect(refreshTokenDelivery("capacitor://localhost.evil.com", appOrigins, false)).toEqual({
      cookie: true,
      body: false,
    })
  })

  test("the non-browser escape hatch still adds the body token for browsers", () => {
    expect(refreshTokenDelivery("https://app.example.com", appOrigins, true)).toEqual({
      cookie: true,
      body: true,
    })
  })
})

describe("getRefreshTokenFromHeader", () => {
  test("reads the header value", () => {
    expect(getRefreshTokenFromHeader("  mytoken123 ")).toBe("mytoken123")
  })

  test("refuses an absent, empty or oversized value", () => {
    expect(getRefreshTokenFromHeader(undefined)).toBeUndefined()
    expect(getRefreshTokenFromHeader("   ")).toBeUndefined()
    expect(getRefreshTokenFromHeader("a".repeat(600))).toBeUndefined()
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { generateDeviceUserCode } from "~/modules/auth/device-user-code"

describe("generateDeviceUserCode", () => {
  it("is 8 characters of the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateDeviceUserCode()).toMatch(/^[2-9A-HJ-NP-Z]{8}$/)
    }
  })

  it("reaches the whole alphabet and does not repeat", () => {
    const codes = Array.from({ length: 2000 }, generateDeviceUserCode)
    expect(new Set(codes).size).toBe(codes.length)
    expect(new Set(codes.join("")).size).toBe(32)
  })
})

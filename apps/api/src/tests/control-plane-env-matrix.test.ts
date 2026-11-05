// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { validateControlPlaneEnv } from "~/lib/env"

describe("validateControlPlaneEnv()", () => {
  test("both unset → ok, mode self_hosted", () => {
    const r = validateControlPlaneEnv({
      NODE_ENV: "production",
      CONTROL_PLANE_URL: undefined,
      CONTROL_PLANE_API_KEY: undefined,
    })
    expect(r.mode).toBe("self_hosted")
  })
  test("both set → ok, mode managed", () => {
    const r = validateControlPlaneEnv({
      NODE_ENV: "production",
      CONTROL_PLANE_URL: "https://cp.example/",
      CONTROL_PLANE_API_KEY: "k".repeat(32),
    })
    expect(r.mode).toBe("managed")
  })
  test("exactly one set in production throws and names missing var", () => {
    expect(() =>
      validateControlPlaneEnv({
        NODE_ENV: "production",
        CONTROL_PLANE_URL: "https://cp.example/",
        CONTROL_PLANE_API_KEY: undefined,
      }),
    ).toThrow(/CONTROL_PLANE_API_KEY/)
    expect(() =>
      validateControlPlaneEnv({
        NODE_ENV: "production",
        CONTROL_PLANE_URL: undefined,
        CONTROL_PLANE_API_KEY: "k".repeat(32),
      }),
    ).toThrow(/CONTROL_PLANE_URL/)
  })
  test("exactly one set in dev warns and returns self_hosted", () => {
    let warned: string | undefined
    const r = validateControlPlaneEnv(
      {
        NODE_ENV: "development",
        CONTROL_PLANE_URL: "https://cp.example/",
        CONTROL_PLANE_API_KEY: undefined,
      },
      {
        warn: (m) => {
          warned = m
        },
      },
    )
    expect(r.mode).toBe("self_hosted")
    expect(warned).toMatch(/CONTROL_PLANE_API_KEY/)
  })
})

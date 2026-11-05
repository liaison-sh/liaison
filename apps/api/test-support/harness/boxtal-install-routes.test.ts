// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit coverage for the Phase-3 credential-selection seam on the Boxtal `_test`
// install route. The route now accepts an explicit `credentials` body (chaos
// passes the real sandbox creds) which must win over the env-based mock/live
// resolution the Phase-18 e2e harness relies on. The full install + the new
// `disconnect-for-test` route are exercised end-to-end at the Phase-3 chaos gate
// (live sandbox install/connect + teardown disconnect).
import { describe, expect, it } from "bun:test"
import {
  type BoxtalInstallCredentials,
  resolveBoxtalInstallCredentials,
} from "./boxtal-install-routes"

describe("resolveBoxtalInstallCredentials (credential selection)", () => {
  const override: BoxtalInstallCredentials = {
    v1Key: "rk1",
    v1Secret: "rs1",
    v3Key: "rk3",
    v3Secret: "rs3",
    environment: "sandbox",
  }

  it("returns the explicit body override (chaos real sandbox creds win over env)", () => {
    // Even with BOXTAL_E2E_LIVE + env creds set, the explicit override wins.
    const creds = resolveBoxtalInstallCredentials(
      {
        BOXTAL_E2E_LIVE: "1",
        BOXTAL_V1_KEY: "envk",
        BOXTAL_V1_SECRET: "envs",
        BOXTAL_V3_KEY: "envk3",
        BOXTAL_V3_SECRET: "envs3",
      },
      override,
    )
    expect(creds).toEqual(override)
  })

  it("honors a production override", () => {
    const creds = resolveBoxtalInstallCredentials({}, { ...override, environment: "production" })
    expect(creds.environment).toBe("production")
  })

  it("falls back to mock literals with no override and BOXTAL_E2E_LIVE unset", () => {
    expect(resolveBoxtalInstallCredentials({})).toEqual({
      v1Key: "mock-v1-key",
      v1Secret: "mock-v1-secret",
      v3Key: "mock-v3-key",
      v3Secret: "mock-v3-secret",
      environment: "sandbox",
    })
  })

  it("reads real env creds when BOXTAL_E2E_LIVE=1 and all four are present", () => {
    expect(
      resolveBoxtalInstallCredentials({
        BOXTAL_E2E_LIVE: "1",
        BOXTAL_V1_KEY: "k1",
        BOXTAL_V1_SECRET: "s1",
        BOXTAL_V3_KEY: "k3",
        BOXTAL_V3_SECRET: "s3",
      }),
    ).toEqual({ v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" })
  })

  it("throws a named error when BOXTAL_E2E_LIVE=1 but creds are missing (hard-blocker path)", () => {
    expect(() =>
      resolveBoxtalInstallCredentials({ BOXTAL_E2E_LIVE: "1", BOXTAL_V1_KEY: "k1" }),
    ).toThrow(/missing creds/)
  })
})

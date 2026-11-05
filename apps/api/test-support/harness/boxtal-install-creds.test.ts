// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M0.3 — the install route's credential source. Mock mode uses inert literals
// (the mock ignores auth). Live mode (BOXTAL_E2E_LIVE=1) pulls the real sandbox
// creds from env — the primary BOXTAL_V*_KEY/SECRET names, which M0.1 aliased to
// the sandbox (TEST) values. Environment is always "sandbox" for the e2e harness.
import { describe, expect, it } from "bun:test"
import { resolveBoxtalInstallCredentials } from "./boxtal-install-routes"

describe("M0.3 resolveBoxtalInstallCredentials", () => {
  it("returns inert mock literals when the gate is unset", () => {
    const c = resolveBoxtalInstallCredentials({})
    expect(c).toEqual({
      v1Key: "mock-v1-key",
      v1Secret: "mock-v1-secret",
      v3Key: "mock-v3-key",
      v3Secret: "mock-v3-secret",
      environment: "sandbox",
    })
  })

  it("returns the env creds in live mode", () => {
    const c = resolveBoxtalInstallCredentials({
      BOXTAL_E2E_LIVE: "1",
      BOXTAL_V1_KEY: "real-v1-key",
      BOXTAL_V1_SECRET: "real-v1-secret",
      BOXTAL_V3_KEY: "real-v3-key",
      BOXTAL_V3_SECRET: "real-v3-secret",
    })
    expect(c).toEqual({
      v1Key: "real-v1-key",
      v1Secret: "real-v1-secret",
      v3Key: "real-v3-key",
      v3Secret: "real-v3-secret",
      environment: "sandbox",
    })
  })

  it("throws a clear error in live mode when a cred is missing", () => {
    expect(() =>
      resolveBoxtalInstallCredentials({ BOXTAL_E2E_LIVE: "1", BOXTAL_V1_KEY: "only-one" }),
    ).toThrow(/BOXTAL_E2E_LIVE=1.*missing/)
  })
})

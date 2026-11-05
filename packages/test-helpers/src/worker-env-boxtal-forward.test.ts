// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M0.3 — BOXTAL_* forwarding into the spawned e2e server env. The spawn env is
// an explicit allowlist (worker-env.ts), so any var not named is dropped. This
// proves the Boxtal creds + live gate cross the spawn boundary, and ONLY when
// present (CI without creds forwards nothing → live scenarios self-skip).
import { describe, expect, it } from "bun:test"
import { forwardBoxtalEnv } from "./worker-env"

describe("M0.3 forwardBoxtalEnv", () => {
  it("forwards every present BOXTAL_* var + the live gate", () => {
    const out = forwardBoxtalEnv({
      BOXTAL_E2E_LIVE: "1",
      BOXTAL_V1_KEY: "k1",
      BOXTAL_V1_SECRET: "s1",
      BOXTAL_V3_KEY: "k3",
      BOXTAL_V3_SECRET: "s3",
      BOXTAL_V1_BASE_URL: "https://test.envoimoinscher.com",
      BOXTAL_V3_BASE_URL: "https://api.boxtal.build",
      UNRELATED: "x",
    })
    expect(out).toEqual({
      BOXTAL_E2E_LIVE: "1",
      BOXTAL_V1_KEY: "k1",
      BOXTAL_V1_SECRET: "s1",
      BOXTAL_V3_KEY: "k3",
      BOXTAL_V3_SECRET: "s3",
      BOXTAL_V1_BASE_URL: "https://test.envoimoinscher.com",
      BOXTAL_V3_BASE_URL: "https://api.boxtal.build",
    })
  })

  it("omits absent vars (CI-without-creds → empty)", () => {
    expect(forwardBoxtalEnv({})).toEqual({})
    expect(forwardBoxtalEnv({ BOXTAL_V1_KEY: undefined })).toEqual({})
  })

  it("does not leak unrelated env", () => {
    expect(forwardBoxtalEnv({ FOO: "bar" })).toEqual({})
  })
})

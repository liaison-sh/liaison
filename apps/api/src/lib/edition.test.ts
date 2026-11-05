// SPDX-License-Identifier: FSL-1.1-ALv2
// The edition switch: only LIAISON_EDITION=managed is managed. The legacy
// control-plane pair alone never switches managed on (such a server refuses to
// boot, lib/managed-boot.ts); anything else is self-hosted.
import { afterEach, describe, expect, it } from "bun:test"
import { _setEdition, detectEdition, edition, isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"

const saved = env.LIAISON_EDITION
const setEditionEnv = (v: "managed" | "self_hosted" | undefined) => {
  ;(env as { LIAISON_EDITION?: string }).LIAISON_EDITION = v
}

afterEach(() => {
  setEditionEnv(saved)
  _setEdition(null)
})

describe("detectEdition", () => {
  const base = { NODE_ENV: "production" }
  it.each([
    ["nothing set", {}, "self_hosted"],
    ["LIAISON_EDITION=managed", { LIAISON_EDITION: "managed" }, "managed"],
    ["LIAISON_EDITION=self_hosted", { LIAISON_EDITION: "self_hosted" }, "self_hosted"],
    [
      "the legacy control-plane pair alone",
      { CONTROL_PLANE_URL: "https://cp.example", CONTROL_PLANE_API_KEY: "k" },
      "self_hosted",
    ],
    [
      "an explicit self_hosted wins over the legacy pair",
      {
        LIAISON_EDITION: "self_hosted",
        CONTROL_PLANE_URL: "https://cp.example",
        CONTROL_PLANE_API_KEY: "k",
      },
      "self_hosted",
    ],
    ["half the legacy pair", { CONTROL_PLANE_URL: "https://cp.example" }, "self_hosted"],
  ] as const)("%s -> %s", (_label, vars, expected) => {
    expect(detectEdition({ ...base, ...vars })).toBe(expected)
  })
})

describe("edition()", () => {
  it("follows LIAISON_EDITION at call time", () => {
    _setEdition(null)
    setEditionEnv("managed")
    expect(edition()).toBe("managed")
    expect(isManagedEdition()).toBe(true)
    setEditionEnv("self_hosted")
    expect(isManagedEdition()).toBe(false)
  })

  it("the test override still wins", () => {
    setEditionEnv("managed")
    _setEdition("self_hosted")
    expect(isManagedEdition()).toBe(false)
  })
})

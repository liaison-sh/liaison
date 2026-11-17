// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { env } from "~/lib/env"
import { signingState, signingUnavailable } from "./signing-state"

const was = env.LIAISON_TSA_URL
const set = (url: string | undefined) => {
  ;(env as { LIAISON_TSA_URL?: string }).LIAISON_TSA_URL = url
}

afterEach(() => set(was))

describe("whether this server can ask for a signature", () => {
  it("with no timestamp authority, signatures are off and the refusal names no setting", () => {
    set(undefined)
    expect(signingState()).toEqual({ available: false, reason: "no_timestamp" })
    const refusal = signingUnavailable("sign")
    expect(refusal?.code).toBe("TIMESTAMP_NOT_CONFIGURED")
    expect(refusal?.message).toContain("Signatures are off on this server")
    expect(refusal?.message).not.toMatch(/LIAISON_|TSA|operator/)
    // An approval or an acceptance needs no stamp.
    expect(signingUnavailable("approve")).toBeNull()
    expect(signingUnavailable("accept")).toBeNull()
  })

  it("with an authority, signatures are on", () => {
    set("https://tsa.example.com")
    expect(signingState()).toEqual({ available: true })
    expect(signingUnavailable("sign")).toBeNull()
  })
})

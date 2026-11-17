// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A server with signatures off says so on the first screen, in a person's words.
import { afterEach, describe, expect, it } from "bun:test"
import { loadSigningState, resetSigningState, signingOffText } from "./signing"

function host(answer: unknown) {
  ;(globalThis as any).__liaisonHost = {
    locale: () => "en",
    fetch: async (path: string) => {
      if (path !== "/api/client-actions/signing") throw new Error(`unexpected ${path}`)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
  resetSigningState()
})

describe("signatures off on this server", () => {
  it("with no timestamp service, the screens say signatures are off and who can turn them on, naming no setting", async () => {
    host({ available: false, reason: "no_timestamp" })
    const text = signingOffText(await loadSigningState())
    expect(text).toContain("Signatures are off on this server")
    expect(text).toContain("Ask whoever runs this server")
    expect(text).not.toMatch(/LIAISON_|TSA|operator/)
  })

  it("on a hosted service without signatures, it says they are not offered", async () => {
    host({ available: false, reason: "not_offered" })
    expect(signingOffText(await loadSigningState())).toContain("not offered")
  })

  it("with signatures on, or an answer it cannot read, nothing is shown", async () => {
    host({ available: true })
    expect(signingOffText(await loadSigningState())).toBeNull()
    resetSigningState()
    host(new Error("offline"))
    expect(signingOffText(await loadSigningState())).toBeNull()
  })
})

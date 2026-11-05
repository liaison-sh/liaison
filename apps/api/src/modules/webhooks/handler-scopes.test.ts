// SPDX-License-Identifier: FSL-1.1-ALv2
// The webhook verifier is app code; the scopes it returns are a request, not a grant.
import { describe, expect, it } from "bun:test"
import { resolveHandlerScopes } from "~/modules/webhooks/verification"

const granted = ["acme:items:read", "acme:items:write"]
const thirdParty = { thirdParty: true, grantedScopes: granted }

describe("resolveHandlerScopes", () => {
  it("narrows a third-party verifier's scopes to what the admin granted", () => {
    expect(
      resolveHandlerScopes("acme", ["*", "acme:items:read", "kernel:admin"], thirdParty),
    ).toEqual(["acme:items:read"])
  })

  it("falls back to the app's own namespace when nothing requested is granted", () => {
    expect(resolveHandlerScopes("acme", ["*"], thirdParty)).toEqual(["acme:*"])
    expect(resolveHandlerScopes("acme", [], thirdParty)).toEqual(["acme:*"])
  })

  it("honours a family grant", () => {
    expect(
      resolveHandlerScopes("acme", ["acme:items:read"], {
        thirdParty: true,
        grantedScopes: ["acme:*"],
      }),
    ).toEqual(["acme:items:read"])
  })

  it("does not let a granted scope cover a wider one", () => {
    expect(resolveHandlerScopes("acme", ["acme:*"], thirdParty)).toEqual(["acme:*"])
    expect(resolveHandlerScopes("acme", ["acme:items"], thirdParty)).toEqual(["acme:*"])
  })

  it("leaves a first-party app's verifier scopes alone", () => {
    expect(
      resolveHandlerScopes("calls", ["calls:*", "knowledge:documents:create"], {
        thirdParty: false,
        grantedScopes: [],
      }),
    ).toEqual(["calls:*", "knowledge:documents:create"])
  })
})

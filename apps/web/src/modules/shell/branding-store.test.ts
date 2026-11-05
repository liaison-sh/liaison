// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { teardownSession } from "~/lib/session-lifecycle"
import {
  _resetBranding,
  demoMode,
  ensureBrandingLoaded,
  ensureSignedInOrgNameLoaded,
  orgName,
} from "~/modules/shell/branding-store"

function answer(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response)
}

describe("the deployment's own name", () => {
  afterEach(() => {
    _resetBranding()
  })

  it("reads the public branding route once and exposes the org name", async () => {
    const fetchImpl = answer({ data: { orgName: "Fabrikam" } })
    await ensureBrandingLoaded(fetchImpl as unknown as typeof fetch)
    await ensureBrandingLoaded(fetchImpl as unknown as typeof fetch)
    expect(orgName()).toBe("Fabrikam")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String((fetchImpl.mock.calls as unknown as unknown[][])[0]?.[0])).toContain(
      "/settings/branding",
    )
  })

  it("leaves the bar unnamed when the server has nothing to say", async () => {
    await ensureBrandingLoaded(answer({ data: {} }) as unknown as typeof fetch)
    expect(orgName()).toBeNull()
  })

  it("leaves the bar unnamed when the read fails, and never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline")
    })
    await expect(
      ensureBrandingLoaded(fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined()
    expect(orgName()).toBeNull()
  })

  it("learns demo mode from the server's flags, not from a build flag", async () => {
    expect(demoMode()).toBe(false)
    await ensureBrandingLoaded(
      answer({
        data: { orgName: "Resonant Audio Labs", flags: { demo: true } },
      }) as unknown as typeof fetch,
    )
    expect(demoMode()).toBe(true)
  })

  it("stays off on an ordinary deployment, whose flags object is empty", async () => {
    await ensureBrandingLoaded(
      answer({ data: { orgName: "Fabrikam", flags: {} } }) as unknown as typeof fetch,
    )
    expect(demoMode()).toBe(false)
  })

  it("stays off when the server is unreachable, so a dead box is not a demo", async () => {
    await ensureBrandingLoaded(
      vi.fn(async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch,
    )
    expect(demoMode()).toBe(false)
  })

  // The flags read used to be latched on `orgName() !== null`: a deployment
  // that answers with flags and no usable name re-fetched on every caller.
  it("fetches once even when the server sends no name", async () => {
    const fetchImpl = answer({ data: { flags: { demo: true } } })
    await ensureBrandingLoaded(fetchImpl as unknown as typeof fetch)
    await ensureBrandingLoaded(fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(demoMode()).toBe(true)
  })

  // A visitor who signs out is still on the demo box, and the screen the logout
  // lands on is the entry screen, which is the one that most needs to know.
  it("keeps demo mode through a session teardown", async () => {
    await ensureBrandingLoaded(
      answer({
        data: { orgName: "Resonant Audio Labs", flags: { demo: true } },
      }) as unknown as typeof fetch,
    )
    teardownSession()
    expect(orgName()).toBeNull()
    expect(demoMode()).toBe(true)
  })

  it("forgets the name when the session ends", async () => {
    await ensureBrandingLoaded(answer({ data: { orgName: "Fabrikam" } }) as unknown as typeof fetch)
    teardownSession()
    expect(orgName()).toBeNull()
  })
})

// The public branding read answers for the DEPLOYMENT (Host slug, else the
// oldest org on the box). On a deployment carrying more than one org that is
// not the org the viewer is in, and a signed-in header that printed it named
// somebody else's workspace.
describe("the signed-in org's own name", () => {
  afterEach(() => {
    _resetBranding()
  })

  it("wins over the deployment's public name", async () => {
    await ensureBrandingLoaded(
      answer({ data: { orgName: "Default Organization" } }) as unknown as typeof fetch,
    )
    expect(orgName()).toBe("Default Organization")
    await ensureSignedInOrgNameLoaded(async () => ({ data: { name: "Resonant Audio Labs" } }))
    expect(orgName()).toBe("Resonant Audio Labs")
  })

  it("is read once per session and leaves the public name alone when it fails", async () => {
    await ensureBrandingLoaded(
      answer({ data: { orgName: "Default Organization" } }) as unknown as typeof fetch,
    )
    const readOrg = vi.fn(async () => {
      throw new Error("offline")
    })
    await ensureSignedInOrgNameLoaded(readOrg)
    expect(orgName()).toBe("Default Organization")
    await ensureSignedInOrgNameLoaded(async () => ({ data: { name: "Resonant Audio Labs" } }))
    expect(orgName()).toBe("Resonant Audio Labs")
    await ensureSignedInOrgNameLoaded(async () => ({ data: { name: "Somebody Else" } }))
    expect(orgName()).toBe("Resonant Audio Labs")
  })
})

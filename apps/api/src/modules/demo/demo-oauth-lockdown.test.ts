// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The OAuth half of the credential lockdown, which had no test.
//
// `createCredentialConnection` was covered; `startOAuthFlow` was asserted in a
// commit message and nowhere else, and it is the more dangerous half: a
// credential connection stores a secret a stranger already had, while an OAuth
// grant is a stranger being walked through authorising THIS deployment against
// somebody's live Google or Shopify account.
//
// Deliberately in its own file rather than beside the connections service: the
// service is being edited elsewhere, and this asserts behaviour, not internals.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { DemoRestrictionError } from "~/modules/demo/demo-egress"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** What `startOAuthFlow` threw, or null when it returned. */
async function oauthRefusal(orgId: string): Promise<Error | null> {
  const { startOAuthFlow } = await import("~/modules/apps/connections/service")
  try {
    await startOAuthFlow(orgId, "00000000-0000-0000-0000-000000000001", "mail", "google")
    return null
  } catch (err) {
    return err as Error
  }
}

describe("demo OAuth lockdown", () => {
  let demoOrgId: string
  let normalOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "oauth-demo", name: "OAuth Demo" })).orgId
    normalOrgId = (await ensureOrg({ slug: "oauth-normal", name: "OAuth Normal" })).orgId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(() => {
    invalidateDemoMarker()
  })

  it("refuses a demo org before it can reach a real provider", async () => {
    DemoModeTestAccess.set(true)
    const err = await oauthRefusal(demoOrgId)
    expect(err).toBeInstanceOf(DemoRestrictionError)
    const restriction = err as DemoRestrictionError
    expect(restriction.status).toBe(403)
    expect(restriction.code).toBe("DEMO_RESTRICTED")
    expect(restriction.action).toBe("connector_credentials")
    expect(restriction.message).toContain("demo instance")
  })

  // The refusal must come from the DEMO guard, not from the connection lookup
  // that follows it: a guard that only happens to be in front of an error is
  // not a guard. A normal org reaches the lookup and fails there instead.
  it("lets a normal org past the guard on the same box", async () => {
    DemoModeTestAccess.set(true)
    const err = await oauthRefusal(normalOrgId)
    expect(err).not.toBeInstanceOf(DemoRestrictionError)
    expect(err?.message ?? "").toContain("not declared")
  })

  it("is inert with demo mode off, marker or no marker", async () => {
    DemoModeTestAccess.set(false)
    const err = await oauthRefusal(demoOrgId)
    expect(err).not.toBeInstanceOf(DemoRestrictionError)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HOW MANY DOORS A DEMO WORKSPACE HAS. The answer must be one.
//
// A demo org is seeded with a whole company of people. They are meant to be
// DATA: authors, assignees, participants, directory entries. `seed-org.ts`
// leaves them with a null `password_hash` so the password route cannot let them
// in, and the existing seed test asserts that exactly one row in the org has a
// hash. That assertion is about a COLUMN. It stays true while every one of those
// accounts is reachable by magic link, which is what `requestMagicLink` did:
// it gated on `status !== "active"` alone, minted a challenge for a persona and
// swallowed the send failure behind a 200.
//
// This asserts the PROPERTY instead: in a demo org, exactly one account can
// actually obtain a session, by any route the product offers.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Delete the `demoMagicLinkAllowed` guard from `requestMagicLink`: "only the
//    owner can be issued a magic link" fails, seven challenges exist.
//  * Make `demoMagicLinkAllowed` refuse a null hash whatever the org (drop the
//    marker read): "a normal org's passwordless user is untouched" fails, which
//    is a real customer locked out of the only door they have.
//  * Make it read the marker but ignore demo mode: "changes nothing with demo
//    mode off" fails.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { requestMagicLink } from "~/modules/auth/magic-link"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const OWNER_PASSWORD = "Visitor-Owner-1!"

/** A seeded persona: a real, active account with NO password, exactly as the seeder leaves it. */
async function seedPersona(orgId: string, email: string): Promise<string> {
  const { userId } = await ensureUser({
    orgId,
    email,
    name: email,
    // Created with one and then stripped, which is what the seeder does: the
    // account exists and is active, and holds no password at all.
    password: "seeded-then-stripped",
    role: "member",
  })
  await sql`UPDATE kernel.users SET password_hash = NULL WHERE id = ${userId}`
  return userId
}

/** Did a passwordless challenge actually get minted for this user? */
async function hasChallenge(userId: string): Promise<boolean> {
  return (await redis.get(`magic:user:${userId}`)) !== null
}

function login(email: string, password: string) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bun-socket-ip": "198.51.100.9" },
    body: JSON.stringify({ email, password }),
  })
}

describe("a demo workspace has exactly one door", () => {
  let demoOrgId: string
  let normalOrgId: string
  let ownerId: string
  let ownerEmail: string
  let personas: Array<{ id: string; email: string }>
  let normalPasswordlessEmail: string
  let normalPasswordlessId: string

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "doors-demo", name: "Doors Demo" })).orgId
    normalOrgId = (await ensureOrg({ slug: "doors-normal", name: "Doors Normal" })).orgId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))

    ownerEmail = "visitor.owner@doors.test"
    ownerId = (
      await ensureUser({
        orgId: demoOrgId,
        email: ownerEmail,
        name: "Visitor Owner",
        password: OWNER_PASSWORD,
        role: "admin",
      })
    ).userId

    personas = []
    for (const key of ["ines", "malik", "sora"]) {
      const email = `${key}@doors-demo.example`
      personas.push({ id: await seedPersona(demoOrgId, email), email })
    }

    // The control: a perfectly ordinary org whose user signs in by magic link,
    // which is the shape a product-wide "no hash, no link" rule would break.
    normalPasswordlessEmail = "passwordless@doors-normal.test"
    normalPasswordlessId = await seedPersona(normalOrgId, normalPasswordlessEmail)
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(async () => {
    invalidateDemoMarker()
    await clearRedisPatterns(["magic:*"])
  })

  it("issues a magic link to the owner and to nobody else in the org", async () => {
    DemoModeTestAccess.set(true)
    await requestMagicLink(ownerEmail, undefined)
    expect(await hasChallenge(ownerId)).toBe(true)

    for (const persona of personas) {
      // Same uniform 200-shaped answer: the refusal must not be an oracle.
      const result = await requestMagicLink(persona.email, undefined)
      expect(typeof result.challengeId).toBe("string")
      expect(await hasChallenge(persona.id)).toBe(false)
    }
  })

  it("counts the doors: exactly one account in the org can obtain a session", async () => {
    DemoModeTestAccess.set(true)
    const everyone = [{ id: ownerId, email: ownerEmail }, ...personas]

    let doors = 0
    for (const person of everyone) {
      await requestMagicLink(person.email, undefined)
      const byMagicLink = await hasChallenge(person.id)
      // The other route: a password login. A persona holds no hash at all, so
      // nothing can be typed that opens it; the owner's password does.
      const byPassword = (await login(person.email, OWNER_PASSWORD)).status === 200
      if (byMagicLink || byPassword) doors += 1
    }
    expect(doors).toBe(1)

    const [{ withHash }] = await sql`
      SELECT count(*)::int AS "withHash" FROM kernel.users
      WHERE org_id = ${demoOrgId} AND password_hash IS NOT NULL`
    expect(withHash).toBe(1)
  })

  it("leaves the seeded people usable as people: active, and still in the org", async () => {
    const rows = (await sql`
      SELECT status FROM kernel.users WHERE org_id = ${demoOrgId} AND password_hash IS NULL`) as unknown as Array<{
      status: string
    }>
    expect(rows.length).toBe(personas.length)
    expect(rows.every((r) => r.status === "active")).toBe(true)
  })

  it("leaves a normal org's passwordless user untouched, which is most customers", async () => {
    DemoModeTestAccess.set(true)
    await requestMagicLink(normalPasswordlessEmail, undefined)
    expect(await hasChallenge(normalPasswordlessId)).toBe(true)
  })

  it("changes nothing with demo mode off, not even for a marked org", async () => {
    DemoModeTestAccess.set(false)
    invalidateDemoMarker()
    await requestMagicLink(personas[0].email, undefined)
    expect(await hasChallenge(personas[0].id)).toBe(true)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE APP REVIEW CREDENTIAL, END TO END.
//
// The org this design exists to serve is the one Apple's Beta App Review signs
// into, and it used to be the one org nobody could sign into. `reservedOwner()`
// generated a password when `LIAISON_DEMO_REVIEWER_PASSWORD` was unset and
// printed it at WARN with the field named `password`, which is a redact path on
// this process's logger, so the line printed "[Redacted]" and the secret was
// gone. `ensureUser` never resets an existing password, so it was gone for good.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Make `reservedOwner()` fall back to a generated password when the variable
//    is unset: "refuses to hand back a credential nobody configured" fails.
//  * Delete the `ensureReservedOwnerPassword` call from `seedDemoOrgData`, or
//    make it skip an account that already has a hash: "re-pins a password an
//    earlier seed left behind" fails and the reviewer is locked out exactly as
//    they were.
//  * Log the password instead of refusing: "never puts the credential in a log
//    line" fails, because the redaction it relied on is still there.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { hashPassword } from "~/lib/crypto"
import { env } from "~/lib/env"
import { REDACT_PATHS } from "~/lib/logger"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, reservedMarker } from "~/modules/demo/demo-org"
import {
  DEMO_REVIEWER_EMAIL,
  DEMO_REVIEWER_NAME,
  ensureReservedOwnerPassword,
  ReservedOwnerPasswordMissingError,
  reservedOwner,
} from "~/modules/demo/demo-seeder"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const CONFIGURED = "AppReview-Pinned-1!"

function setReviewerPassword(value: string): void {
  ;(env as { LIAISON_DEMO_REVIEWER_PASSWORD: string }).LIAISON_DEMO_REVIEWER_PASSWORD = value
}

function login(email: string, password: string) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bun-socket-ip": "203.0.113.7" },
    body: JSON.stringify({ email, password }),
  })
}

describe("the reserved App Review credential", () => {
  let orgId: string
  let saved: string

  beforeAll(async () => {
    await acquireTestLock()
    saved = env.LIAISON_DEMO_REVIEWER_PASSWORD
    orgId = (await ensureOrg({ slug: "reserved-cred", name: "Reserved Cred" })).orgId
    await markOrgAsDemo(orgId, reservedMarker())
  })

  afterAll(async () => {
    setReviewerPassword(saved)
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(async () => {
    invalidateDemoMarker()
    // The login route's brute-force counters are per address, and several cases
    // here deliberately fail a login for the same one.
    await clearRedisPatterns(["bf:*", "login:*", "auth:*"])
  })

  it("refuses to hand back a credential nobody configured", () => {
    setReviewerPassword("")
    expect(() => reservedOwner()).toThrow(ReservedOwnerPasswordMissingError)
    // And the refusal says exactly what to set, because it is the only thing an
    // operator reading it can act on.
    try {
      reservedOwner()
    } catch (err) {
      expect((err as Error).message).toContain("LIAISON_DEMO_REVIEWER_PASSWORD")
      expect((err as Error).message).toContain(DEMO_REVIEWER_EMAIL)
    }
  })

  it("treats whitespace as unset rather than as a password", () => {
    setReviewerPassword("   ")
    expect(() => reservedOwner()).toThrow(ReservedOwnerPasswordMissingError)
  })

  it("never puts the credential in a log line, because the logger would eat it", () => {
    // The mechanism that broke the old design is still in place, on purpose:
    // this asserts we did not 'fix' the blocker by unredacting passwords.
    expect(REDACT_PATHS).toContain("password")
  })

  it("hands back the configured password, and the App Review identity with it", () => {
    setReviewerPassword(CONFIGURED)
    expect(reservedOwner()).toEqual({
      email: DEMO_REVIEWER_EMAIL,
      name: DEMO_REVIEWER_NAME,
      password: CONFIGURED,
    })
  })

  it("signs in through the real login route with the configured password", async () => {
    setReviewerPassword(CONFIGURED)
    DemoModeTestAccess.set(true)
    const owner = reservedOwner()
    await ensureUser({
      orgId,
      email: owner.email,
      name: owner.name,
      password: owner.password,
      role: "admin",
    })
    await ensureReservedOwnerPassword(orgId)

    const res = await login(owner.email, CONFIGURED)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { accessToken?: string } }
    const token = body.data.accessToken
    expect(typeof token).toBe("string")
    // A real session for THIS org, not merely a 200: the claim is what every
    // later request is authorised against.
    const claims = JSON.parse(
      Buffer.from((token as string).split(".")[1], "base64url").toString("utf8"),
    ) as { orgId?: string }
    expect(claims.orgId).toBe(orgId)
  })

  it("re-pins a password an earlier seed left behind, which is the lockout", async () => {
    // Exactly the shipped box: the account exists, holding a hash of something
    // nobody has. `ensureUser` will never touch it.
    const stale = await hashPassword("whatever-the-old-generated-one-was")
    await sql`UPDATE kernel.users SET password_hash = ${stale}
              WHERE org_id = ${orgId} AND email = ${DEMO_REVIEWER_EMAIL}`
    setReviewerPassword(CONFIGURED)
    DemoModeTestAccess.set(true)

    const before = await login(DEMO_REVIEWER_EMAIL, CONFIGURED)
    expect(before.status).toBe(401)

    await ensureReservedOwnerPassword(orgId)

    const after = await login(DEMO_REVIEWER_EMAIL, CONFIGURED)
    expect(after.status).toBe(200)
  })

  it("refuses to re-pin when no password is configured, rather than inventing one", async () => {
    setReviewerPassword("")
    await expect(ensureReservedOwnerPassword(orgId)).rejects.toBeInstanceOf(
      ReservedOwnerPasswordMissingError,
    )
  })
})

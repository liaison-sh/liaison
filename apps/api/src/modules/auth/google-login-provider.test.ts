// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { oauthProviders, organizations } from "~/db/schema/kernel"
import {
  ensureGoogleLoginProvider,
  GOOGLE_ISSUER,
  GOOGLE_JWKS_URI,
  isFirstPartyGoogleProvider,
  jwksUriForIssuer,
} from "~/modules/auth/google-login-provider"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const CREDS = {
  clientId: "test-google-client-id.apps.googleusercontent.com",
  clientSecret: "test-google-secret",
}
const NO_CREDS = { clientId: "", clientSecret: "" }

async function googleRows(orgId: string) {
  return withSystemDb("test-google-rows", (db) =>
    db
      .select()
      .from(oauthProviders)
      .where(and(eq(oauthProviders.orgId, orgId), eq(oauthProviders.issuerUrl, GOOGLE_ISSUER))),
  )
}

describe("google login provider", () => {
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "google@test.com", name: "Google Admin" }),
    })
    expect(res.status).toBe(200)
    const [org] = await withSystemDb("test-google-org", (db) =>
      db.select({ id: organizations.id }).from(organizations).limit(1),
    )
    orgId = org.id
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("jwksUriForIssuer special-cases Google's non-conventional path", () => {
    expect(jwksUriForIssuer(GOOGLE_ISSUER)).toBe(GOOGLE_JWKS_URI)
    expect(jwksUriForIssuer("https://id.example.com")).toBe(
      "https://id.example.com/.well-known/jwks.json",
    )
  })

  it("isFirstPartyGoogleProvider matches only the configured Google client", () => {
    expect(
      isFirstPartyGoogleProvider({ issuerUrl: GOOGLE_ISSUER, clientId: CREDS.clientId }, CREDS),
    ).toBe(true)
    // Wrong client id (a different, admin-registered provider).
    expect(isFirstPartyGoogleProvider({ issuerUrl: GOOGLE_ISSUER, clientId: "other" }, CREDS)).toBe(
      false,
    )
    // Non-Google issuer.
    expect(
      isFirstPartyGoogleProvider(
        { issuerUrl: "https://id.example.com", clientId: CREDS.clientId },
        CREDS,
      ),
    ).toBe(false)
    // Google login not configured → never trusted.
    expect(
      isFirstPartyGoogleProvider({ issuerUrl: GOOGLE_ISSUER, clientId: CREDS.clientId }, NO_CREDS),
    ).toBe(false)
  })

  it("is a no-op when Google login creds are absent", async () => {
    await ensureGoogleLoginProvider(orgId, NO_CREDS)
    expect((await googleRows(orgId)).length).toBe(0)
  })

  it("calls at the same moment leave one provider: the login page shows one button", async () => {
    await withSystemDb("test-google-clear", (db) =>
      db
        .delete(oauthProviders)
        .where(and(eq(oauthProviders.orgId, orgId), eq(oauthProviders.issuerUrl, GOOGLE_ISSUER))),
    )
    await Promise.all(Array.from({ length: 6 }, () => ensureGoogleLoginProvider(orgId, CREDS)))
    expect(await googleRows(orgId)).toHaveLength(1)
  })

  it("seeds an invited-only Google provider and is idempotent across rotations", async () => {
    await ensureGoogleLoginProvider(orgId, CREDS)
    let rows = await googleRows(orgId)
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe("Google")
    expect(rows[0].clientId).toBe(CREDS.clientId)
    expect(rows[0].autoProvision).toBe(false) // invited-users-only
    expect(rows[0].tokenEndpoint).toContain("oauth2.googleapis.com")
    expect(rows[0].userinfoEndpoint).toContain("openidconnect.googleapis.com")
    // Secret is stored encrypted, never as plaintext.
    expect(rows[0].clientSecretEncrypted).not.toBe(CREDS.clientSecret)

    // Re-run with rotated creds — still exactly one row, refreshed in place.
    await ensureGoogleLoginProvider(orgId, {
      clientId: "rotated-client",
      clientSecret: "rotated-secret",
    })
    rows = await googleRows(orgId)
    expect(rows.length).toBe(1)
    expect(rows[0].clientId).toBe("rotated-client")

    // The seeded provider surfaces in the public login list for the single-tenant org.
    const listRes = await app.request("/api/auth/oauth/providers")
    const body = (await listRes.json()) as { data: Array<{ name: string }> }
    expect(body.data.some((p) => p.name === "Google")).toBe(true)
  })
})

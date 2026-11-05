// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import * as jose from "jose"
import { signAccessToken, verifyAccessToken } from "~/modules/auth/jwt"

const TEST_SECRET = "test-secret-at-least-32-chars-long!!"

describe("JWT service", () => {
  it("signs and verifies an access token", async () => {
    const token = await signAccessToken(
      {
        userId: "user-123",
        orgId: "org-456",
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
    )
    const payload = await verifyAccessToken(token, TEST_SECRET)
    expect(payload.userId).toBe("user-123")
    expect(payload.orgId).toBe("org-456")
  })

  it("rejects expired token", async () => {
    const token = await signAccessToken(
      {
        userId: "u",
        orgId: "o",
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
      -1,
    )
    expect(verifyAccessToken(token, TEST_SECRET)).rejects.toThrow()
  })

  it("rejects token with wrong secret", async () => {
    const token = await signAccessToken(
      {
        userId: "u",
        orgId: "o",
        name: "Test",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
    )
    expect(verifyAccessToken(token, "wrong-secret-that-is-long-enough!!")).rejects.toThrow()
  })

  it("rejects malformed token", async () => {
    expect(verifyAccessToken("not-a-jwt", TEST_SECRET)).rejects.toThrow()
  })

  it("access token TTL equals 15 minutes (900 seconds)", async () => {
    const token = await signAccessToken(
      {
        userId: "user-ttl",
        orgId: "org-ttl",
        name: "TTL User",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
    )
    const { exp, iat } = jose.decodeJwt(token)
    expect(typeof exp).toBe("number")
    expect(typeof iat).toBe("number")
    expect((exp as number) - (iat as number)).toBe(900)
  })

  it("rejects a token signed with a non-HS256 algorithm (alg pinning)", async () => {
    // Same secret bytes, but HS512 instead of the pinned HS256. Without an
    // `algorithms` pin, jose would accept any HMAC-family alg the header asserts.
    const key = new TextEncoder().encode(TEST_SECRET)
    const forged = await new jose.SignJWT({ userId: "u", orgId: "o", name: "n" })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setAudience("access")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(key)
    expect(verifyAccessToken(forged, TEST_SECRET)).rejects.toThrow()
  })

  // Defense-in-depth payload validation. These tokens are correctly HS256-signed
  // by us — the point is that a malformed/missing claim is rejected at verify
  // rather than silently coerced via a blind cast into RLS / downstream calls.
  // Helper signs an *arbitrary* body with the real secret + correct audience so
  // jose's signature/audience/alg checks all pass and only the payload schema
  // can reject.
  async function signRawAccessBody(body: Record<string, unknown>): Promise<string> {
    const key = new TextEncoder().encode(TEST_SECRET)
    return new jose.SignJWT(body)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setAudience("access")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(key)
  }

  it("rejects a (validly signed) token whose scopes claim is a string, not an array", async () => {
    const token = await signRawAccessBody({
      userId: "u",
      orgId: "o",
      name: "n",
      authVersion: 1,
      permissionVersion: 1,
      scopes: "kernel:threads:read", // wrong type — should be string[]
    })
    expect(verifyAccessToken(token, TEST_SECRET)).rejects.toThrow(/Invalid access token payload/)
  })

  it("rejects a (validly signed) token missing the required userId claim", async () => {
    const token = await signRawAccessBody({
      orgId: "o",
      name: "n",
      authVersion: 1,
      permissionVersion: 1,
    })
    expect(verifyAccessToken(token, TEST_SECRET)).rejects.toThrow(/Invalid access token payload/)
  })

  it("rejects a (validly signed) token whose dimensionGrants is a string, not an object", async () => {
    const token = await signRawAccessBody({
      userId: "u",
      orgId: "o",
      name: "n",
      authVersion: 1,
      permissionVersion: 1,
      dimensionGrants: "not-an-object", // wrong type — should be Record<string, string[]>
    })
    expect(verifyAccessToken(token, TEST_SECRET)).rejects.toThrow(/Invalid access token payload/)
  })

  it("still verifies a well-formed token and returns the full default-populated shape", async () => {
    const token = await signAccessToken(
      {
        userId: "user-shape",
        orgId: "org-shape",
        name: "Shape User",
        authVersion: 2,
        permissionVersion: 3,
        roles: ["admin"],
        scopes: ["kernel:threads:read"],
        dimensionGrants: { sensitivity: ["public"] },
      },
      TEST_SECRET,
    )
    const payload = await verifyAccessToken(token, TEST_SECRET)
    expect(payload).toEqual({
      userId: "user-shape",
      orgId: "org-shape",
      name: "Shape User",
      authVersion: 2,
      permissionVersion: 3,
      roles: ["admin"],
      scopes: ["kernel:threads:read"],
      dimensionGrants: { sensitivity: ["public"] },
    })
  })

  it("applies legacy defaults for optional claims absent from the token", async () => {
    // A minimal valid token (no roles/scopes/dimensionGrants) must still verify
    // and surface the same defaults the previous blind-cast `?? default` gave.
    const token = await signAccessToken(
      { userId: "u", orgId: "o", name: "n", authVersion: 1, permissionVersion: 1 },
      TEST_SECRET,
    )
    const payload = await verifyAccessToken(token, TEST_SECRET)
    expect(payload.roles).toEqual([])
    expect(payload.scopes).toEqual([])
    expect(payload.dimensionGrants).toEqual({})
    expect(payload.mcpConnectionId).toBeUndefined()
  })

  it("round-trips the mcpConnectionId claim (MCP token-class discriminator)", async () => {
    const token = await signAccessToken(
      {
        userId: "u",
        orgId: "o",
        name: "mcp",
        authVersion: 1,
        permissionVersion: 1,
        mcpConnectionId: "conn-abc",
      },
      TEST_SECRET,
      900,
    )
    const payload = await verifyAccessToken(token, TEST_SECRET)
    expect(payload.mcpConnectionId).toBe("conn-abc")
    const web = await signAccessToken(
      { userId: "u", orgId: "o", name: "web", authVersion: 1, permissionVersion: 1 },
      TEST_SECRET,
    )
    expect((await verifyAccessToken(web, TEST_SECRET)).mcpConnectionId).toBeUndefined()
  })

  it("signAccessToken and verifyAccessToken round trip agentId and grantorUserId claims", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111"
    const grantorUserId = "22222222-2222-4222-8222-222222222222"
    const token = await signAccessToken(
      {
        userId: grantorUserId,
        orgId: "o",
        name: "mcp",
        authVersion: 1,
        permissionVersion: 1,
        mcpConnectionId: "conn-agent",
        agentId,
        grantorUserId,
      },
      TEST_SECRET,
      900,
    )
    const payload = await verifyAccessToken(token, TEST_SECRET)
    expect(payload.agentId).toBe(agentId)
    expect(payload.grantorUserId).toBe(grantorUserId)
  })

  it("verifyAccessToken omits agentId when the token was signed without it", async () => {
    const token = await signAccessToken(
      { userId: "u", orgId: "o", name: "web", authVersion: 1, permissionVersion: 1 },
      TEST_SECRET,
    )
    const payload = await verifyAccessToken(token, TEST_SECRET)
    expect(payload.agentId).toBeUndefined()
    expect(payload.grantorUserId).toBeUndefined()
  })

  it("signAccessToken payload for an agent scoped MCP token contains no key material field", async () => {
    // A plausible but wrong implementation of the agent-scoped token ships the
    // agent's BYOK material (or its ciphertext) inside the token so an external
    // runtime can call a provider directly. This pins the payload to identity
    // and scope claims only, so such a field cannot land unnoticed.
    const token = await signAccessToken(
      {
        userId: "22222222-2222-4222-8222-222222222222",
        orgId: "o",
        name: "mcp",
        authVersion: 1,
        permissionVersion: 1,
        roles: ["agent"],
        scopes: ["finance:read"],
        dimensionGrants: { sensitivity: ["public"] },
        mcpConnectionId: "conn-agent",
        agentId: "11111111-1111-4111-8111-111111111111",
        grantorUserId: "22222222-2222-4222-8222-222222222222",
      },
      TEST_SECRET,
      900,
    )
    const raw = jose.decodeJwt(token)
    expect(Object.keys(raw).sort()).toEqual(
      [
        "agentId",
        "aud",
        "authVersion",
        "dimensionGrants",
        "exp",
        "grantorUserId",
        "iat",
        "mcpConnectionId",
        "name",
        "orgId",
        "permissionVersion",
        "roles",
        "scopes",
        "userId",
      ].sort(),
    )
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Device registration. A phone posts its token on every launch, so the route
// has to be an upsert: the alternative is one row per launch and a fanout that
// sends the same notification a dozen times to the same handset.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("push token routes", () => {
  let session: minimal.Session
  let other: minimal.Session
  // A user of another organisation on the same server.
  let stranger: minimal.Session

  const request = (method: string, bearer: string, body: unknown) =>
    app.request("/api/push/tokens", {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  const rows = (userId: string) =>
    sql<Array<{ id: string; token: string; platform: string; environment: string }>>`
      SELECT id, token, platform, environment FROM kernel.push_tokens WHERE user_id = ${userId}`

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    other = await minimal.session(org.id, { role: "member" })
    const elsewhere = await minimal.secondOrg()
    stranger = await minimal.session(elsewhere.orgId, { role: "member" })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${session.orgId}`
    await releaseTestLock()
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${session.orgId}`
  })

  it("registers a new token and returns its id", async () => {
    const response = await request("POST", session.bearer, {
      platform: "ios",
      token: "device-token-1",
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { data: { id: string } }
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/)
    const found = await rows(session.userId)
    expect(found).toHaveLength(1)
    expect(found[0].token).toBe("device-token-1")
    expect(found[0].platform).toBe("ios")
  })

  it("rejects an unknown platform with 400", async () => {
    const response = await request("POST", session.bearer, {
      platform: "windows",
      token: "device-token-1",
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(await rows(session.userId)).toHaveLength(0)
  })

  it("upserts on a repeated registration of the same token", async () => {
    const first = await request("POST", session.bearer, {
      platform: "ios",
      token: "device-token-1",
    })
    const firstId = ((await first.json()) as { data: { id: string } }).data.id
    const second = await request("POST", session.bearer, {
      platform: "ios",
      token: "device-token-1",
    })
    expect(second.status).toBe(201)
    const secondId = ((await second.json()) as { data: { id: string } }).data.id
    expect(secondId).toBe(firstId)
    expect(await rows(session.userId)).toHaveLength(1)
  })

  it("stores environment and updates it on re-register", async () => {
    const first = await request("POST", session.bearer, {
      platform: "ios",
      token: "device-token-env",
      environment: "sandbox",
    })
    expect(first.status).toBe(201)
    expect((await rows(session.userId))[0].environment).toBe("sandbox")
    const second = await request("POST", session.bearer, {
      platform: "ios",
      token: "device-token-env",
      environment: "production",
    })
    expect(second.status).toBe(201)
    const found = await rows(session.userId)
    expect(found).toHaveLength(1)
    expect(found[0].environment).toBe("production")
  })

  it("records whether the phone knows several servers, and follows each re-register", async () => {
    const flag = async () =>
      (
        await sql<Array<{ multi_server: boolean }>>`
          SELECT multi_server FROM kernel.push_tokens
          WHERE user_id = ${session.userId} AND token = 'device-token-multi'`
      )[0]?.multi_server
    await request("POST", session.bearer, { platform: "android", token: "device-token-multi" })
    expect(await flag()).toBe(false)
    await request("POST", session.bearer, {
      platform: "android",
      token: "device-token-multi",
      multiServer: true,
    })
    expect(await flag()).toBe(true)
    await request("POST", session.bearer, {
      platform: "android",
      token: "device-token-multi",
      multiServer: false,
    })
    expect(await flag()).toBe(false)
  })

  it("an old client that sends no environment is recorded as production", async () => {
    await request("POST", session.bearer, { platform: "ios", token: "device-token-old" })
    expect((await rows(session.userId))[0].environment).toBe("production")
  })

  it("rejects an unknown environment with 400", async () => {
    const response = await request("POST", session.bearer, {
      platform: "ios",
      token: "device-token-env",
      environment: "staging",
    })
    expect(response.status).toBe(400)
    expect(await rows(session.userId)).toHaveLength(0)
  })

  // THE HANDSET BELONGS TO WHOEVER IS SIGNED IN ON IT NOW. The phone holds one
  // session per server, so a token registered by a second user means the
  // first one's session on that handset has ended, whether or not its sign-out
  // ever reached the server (a failed logout, a killed app, a rejected
  // refresh). Their row kept every push for that account landing on a phone
  // signed into another (walk 2026-10-19, #17).
  it("a second user registering the handset's token takes it from the first", async () => {
    const first = await request("POST", session.bearer, {
      platform: "ios",
      token: "shared-handset-token",
    })
    const firstId = ((await first.json()) as { data: { id: string } }).data.id
    await request("POST", other.bearer, { platform: "ios", token: "shared-handset-token" })
    expect(await rows(session.userId)).toHaveLength(0)
    expect(await rows(other.userId)).toHaveLength(1)
    const [credential] = await sql<Array<{ revoked_at: Date | null }>>`
      SELECT revoked_at FROM kernel.notification_device_credentials
      WHERE user_id = ${session.userId} AND device_id = ${firstId}
      ORDER BY created_at DESC LIMIT 1`
    expect(credential?.revoked_at).not.toBeNull()
  })

  it("takes the token from a user of another organisation on the same server", async () => {
    await request("POST", stranger.bearer, { platform: "ios", token: "cross-org-handset" })
    await request("POST", session.bearer, { platform: "ios", token: "cross-org-handset" })
    expect(await rows(stranger.userId)).toHaveLength(0)
    expect(await rows(session.userId)).toHaveLength(1)
  })

  it("leaves another handset's token alone", async () => {
    await request("POST", session.bearer, { platform: "ios", token: "handset-a" })
    await request("POST", other.bearer, { platform: "ios", token: "handset-b" })
    expect(await rows(session.userId)).toHaveLength(1)
    expect(await rows(other.userId)).toHaveLength(1)
  })

  it("deletes only the caller's own row on sign out", async () => {
    await request("POST", session.bearer, { platform: "ios", token: "own-token" })
    await request("POST", other.bearer, { platform: "ios", token: "colleague-token" })
    const own = await request("DELETE", session.bearer, { platform: "ios", token: "own-token" })
    expect(own.status).toBe(204)
    // Naming a colleague's token deletes nothing of theirs.
    const theirs = await request("DELETE", session.bearer, {
      platform: "ios",
      token: "colleague-token",
    })
    expect(theirs.status).toBe(204)
    expect(await rows(session.userId)).toHaveLength(0)
    expect(await rows(other.userId)).toHaveLength(1)
  })

  it("refuses an unauthenticated registration", async () => {
    const response = await app.request("/api/push/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "ios", token: "anonymous" }),
    })
    expect(response.status).toBe(401)
  })
})

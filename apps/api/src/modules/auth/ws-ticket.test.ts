// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { consumeWsTicket, isWsAuthStillValid, parseTicketPayload } from "~/modules/auth/ws-ticket"

const ORG_ID = "00000000-0000-0000-0000-a00000000011"
const USER_ID = "00000000-0000-0000-0000-a00000000012"

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'WS Ticket Test Org', 'ws-ticket-test-org')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version, permission_version)
    VALUES (${USER_ID}, ${ORG_ID}, 'ws-ticket-user@test.com', 'WS Ticket User', 'active', 1, 1)
    ON CONFLICT (id) DO NOTHING`
})

afterAll(async () => {
  await redis.del(
    "ws-ticket:test-stale-permission",
    "ws-ticket:test-valid",
    "ws-ticket:test-deleting",
  )
  await sql`DELETE FROM kernel.users WHERE id = ${USER_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("parseTicketPayload", () => {
  it("parses valid ticket payload", () => {
    const raw = JSON.stringify({
      userId: "u1",
      orgId: "o1",
      scopes: ["kernel:threads:read"],
      dimensionGrants: { team: ["alpha"] },
      authVersion: 1,
      permissionVersion: 2,
    })
    const result = parseTicketPayload(raw)
    expect(result).toMatchObject({
      userId: "u1",
      orgId: "o1",
      scopes: ["kernel:threads:read"],
      roles: [],
      dimensionGrants: { team: ["alpha"] },
      authVersion: 1,
      permissionVersion: 2,
    })
  })

  it("returns null for malformed JSON", () => {
    expect(parseTicketPayload("not json")).toBeNull()
  })

  it("returns null for missing userId", () => {
    const raw = JSON.stringify({ orgId: "o1", scopes: [] })
    expect(parseTicketPayload(raw)).toBeNull()
  })

  it("returns null for empty userId", () => {
    const raw = JSON.stringify({ userId: "", orgId: "o1", scopes: [] })
    expect(parseTicketPayload(raw)).toBeNull()
  })

  it("returns null for missing scopes array", () => {
    const raw = JSON.stringify({ userId: "u1", orgId: "o1" })
    expect(parseTicketPayload(raw)).toBeNull()
  })

  it("returns null when auth or permission version is missing", () => {
    expect(parseTicketPayload(JSON.stringify({ userId: "u1", orgId: "o1", scopes: [] }))).toBeNull()
    expect(
      parseTicketPayload(JSON.stringify({ userId: "u1", orgId: "o1", scopes: [], authVersion: 1 })),
    ).toBeNull()
  })

  it("defaults dimensionGrants to empty object when absent", () => {
    const raw = JSON.stringify({
      userId: "u1",
      orgId: "o1",
      scopes: [],
      authVersion: 1,
      permissionVersion: 1,
    })
    const result = parseTicketPayload(raw)
    expect(result?.dimensionGrants).toEqual({})
  })
})

describe("WebSocket auth freshness", () => {
  it("rejects a consumed ticket when permissionVersion is stale", async () => {
    await sql`UPDATE kernel.users SET permission_version = 2, status = 'active' WHERE id = ${USER_ID}`
    await redis.set(
      "ws-ticket:test-stale-permission",
      JSON.stringify({
        userId: USER_ID,
        orgId: ORG_ID,
        scopes: ["kernel:threads:read"],
        roles: [],
        dimensionGrants: {},
        authVersion: 1,
        permissionVersion: 1,
      }),
      "EX",
      30,
    )

    const payload = await consumeWsTicket(redis, "test-stale-permission")
    expect(payload).toBeNull()

    await sql`UPDATE kernel.users SET permission_version = 1 WHERE id = ${USER_ID}`
  })

  it("fails WS auth revalidation when permissionVersion changes", async () => {
    const before = await isWsAuthStillValid({
      userId: USER_ID,
      orgId: ORG_ID,
      authVersion: 1,
      permissionVersion: 1,
    })
    expect(before).toBe(true)

    await sql`UPDATE kernel.users SET permission_version = 2 WHERE id = ${USER_ID}`

    const after = await isWsAuthStillValid({
      userId: USER_ID,
      orgId: ORG_ID,
      authVersion: 1,
      permissionVersion: 1,
    })
    expect(after).toBe(false)

    await sql`UPDATE kernel.users SET permission_version = 1 WHERE id = ${USER_ID}`
  })
})

// An org whose deletion has started serves nothing more (S2.5): a ticket minted
// before the mark opens no socket, and an open socket fails its next
// revalidation (lib/server.ts closes it).
describe("WebSocket auth of an org being deleted", () => {
  it("refuses the upgrade and fails revalidation once deleting_at is set", async () => {
    const ticket = JSON.stringify({
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["kernel:threads:read"],
      roles: [],
      dimensionGrants: {},
      authVersion: 1,
      permissionVersion: 1,
    })
    const auth = { userId: USER_ID, orgId: ORG_ID, authVersion: 1, permissionVersion: 1 }
    await sql`UPDATE kernel.users SET permission_version = 1, auth_version = 1, status = 'active' WHERE id = ${USER_ID}`
    // Live: the ticket opens a socket.
    await redis.set("ws-ticket:test-deleting", ticket, "EX", 30)
    expect(await consumeWsTicket(redis, "test-deleting")).not.toBeNull()
    expect(await isWsAuthStillValid(auth)).toBe(true)

    await sql`UPDATE kernel.organizations SET deleting_at = now() WHERE id = ${ORG_ID}`
    forgetOrgApps(ORG_ID)
    try {
      await redis.set("ws-ticket:test-deleting", ticket, "EX", 30)
      expect(await consumeWsTicket(redis, "test-deleting")).toBeNull()
      expect(await isWsAuthStillValid(auth)).toBe(false)
    } finally {
      await sql`UPDATE kernel.organizations SET deleting_at = NULL WHERE id = ${ORG_ID}`
      forgetOrgApps(ORG_ID)
    }
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// One-time connect links (connect-links.ts) through their routes, and the
// disconnect rule (disconnect-account.ts): a link works only for the member it
// was minted for, signed in as themselves, once, before it expires, and starts
// the browser-bound personal flow; a disconnect is the org admin's for an
// organization connection and the owner's for a personal one (an admin only
// with force, audited).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import {
  connectionDisconnectPreflight,
  connectLinkSendPreflight,
  handleConnectionDisconnect,
  summarizeConnectionDisconnect,
} from "~/modules/agent/tools/connection-tools"
import {
  connectionConfigRegistry,
  manifestRegistry,
  oauthClientResolverRegistry,
} from "~/modules/apps/app-registries"
import {
  CONNECT_LINK_TTL_SECONDS,
  ConnectLinkError,
  claimConnectLink,
  connectLinkKey,
  mintConnectLink,
  peekConnectLink,
  readConnectLinkRefusal,
} from "~/modules/apps/connections/connect-links"
import {
  decideDisconnect,
  findDisconnectTargets,
  performDisconnect,
} from "~/modules/apps/connections/disconnect-account"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "t3link"
const CONN = "oauth"
const ADMIN_SCOPE = `${APP}:accounts:admin`

describe("one-time connect links", () => {
  let orgId: string
  let admin: { id: string; email: string }
  let member: { id: string; email: string }
  let savedStandIn: string | undefined

  const tokenFor = (userId: string, scopes: string[]) =>
    signAccessToken(
      { userId, orgId, name: "T3", authVersion: 1, permissionVersion: 1, scopes },
      env.JWT_SECRET,
    )

  async function post(path: string, body: unknown, bearer?: string) {
    return app.request(`/api/connections${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    })
  }

  const mintForMember = (ttlSeconds?: number) =>
    mintConnectLink({
      orgId,
      email: member.email,
      appName: APP,
      connectionName: CONN,
      minter: { kind: "cli" },
      ...(ttlSeconds ? { ttlSeconds } : {}),
    })

  beforeAll(async () => {
    await acquireTestLock()
    const a = await minimal.orgAdmin((await createTestOrg()).id)
    orgId = a.orgId
    admin = a
    member = await minimal.person(orgId, { role: "member" })
    savedStandIn = process.env.LIAISON_TEST_OAUTH_PROVIDER
    process.env.LIAISON_TEST_OAUTH_PROVIDER = "https://127.0.0.1:9"
    manifestRegistry.set([orgId, APP], { name: APP, uiBundleUrl: null })
    connectionConfigRegistry.set([orgId, APP, CONN], {
      type: "oauth2",
      authorizationUrl: "https://provider.invalid/authorize",
      tokenUrl: "https://provider.invalid/token",
      scopes: ["read"],
    } as never)
    connectionConfigRegistry.set([orgId, APP, "keys"], {
      type: "credentials",
      credentialFields: [],
    } as never)
    oauthClientResolverRegistry.set([orgId, APP, CONN], async () => ({
      clientId: "client-t3",
      clientSecret: "secret-t3",
      source: "deployment" as const,
    }))
  })

  afterAll(async () => {
    if (savedStandIn === undefined) delete process.env.LIAISON_TEST_OAUTH_PROVIDER
    else process.env.LIAISON_TEST_OAUTH_PROVIDER = savedStandIn
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    connectionConfigRegistry.deleteByPrefix([orgId, APP])
    oauthClientResolverRegistry.delete([orgId, APP, CONN])
    manifestRegistry.delete([orgId, APP])
    await releaseTestLock()
  })

  it("expires within 30 minutes and stores only the token's hash", async () => {
    const link = await mintForMember()
    expect(CONNECT_LINK_TTL_SECONDS).toBeLessThanOrEqual(30 * 60)
    expect(link.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000)
    expect(link.url).toContain("/connect/link?token=")
    expect(await redis.get(`connect:link:${link.token}`)).toBeNull()
    const ttl = await redis.ttl(connectLinkKey(link.token))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30 * 60)
  })

  it("is refused without a session", async () => {
    const link = await mintForMember()
    const res = await post("/links/redeem", { token: link.token })
    expect(res.status).toBe(401)
    // Still usable by its member.
    expect(await redis.get(connectLinkKey(link.token))).not.toBeNull()
  })

  it("refuses a signed-in user who is not the member, and stays usable for the member", async () => {
    const link = await mintForMember()
    const asAdmin = await tokenFor(admin.id, [ADMIN_SCOPE, "kernel:apps:admin"])
    const peek = await post("/links/peek", { token: link.token }, asAdmin)
    expect(((await peek.json()) as { data: { status: string } }).data.status).toBe("wrong_user")
    const res = await post("/links/redeem", { token: link.token }, asAdmin)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("CONNECT_LINK_WRONG_USER")
    expect(body.error.message).toContain(`sign in as ${member.email}`)
    expect(res.headers.get("set-cookie") ?? "").not.toContain("connect_state")
    expect(await redis.get(connectLinkKey(link.token))).not.toBeNull()
  })

  it("starts a browser-bound flow owned by the member, then refuses a replay", async () => {
    const link = await mintForMember()
    const asMember = await tokenFor(member.id, [])
    const res = await post("/links/redeem", { token: link.token }, asMember)
    expect(res.status).toBe(200)
    const { redirectUrl } = ((await res.json()) as { data: { redirectUrl: string } }).data
    const state = new URL(redirectUrl).searchParams.get("state")
    expect(state).toBeTruthy()
    const record = JSON.parse((await redis.get(`oauth:state:${state}`)) ?? "{}")
    expect(record.ownerType).toBe("user")
    expect(record.ownerId).toBe(member.id)
    expect(record.userId).toBe(member.id)
    expect(record.browserBound).toBe(env.OAUTH_CONNECT_BROWSER_BINDING)
    if (env.OAUTH_CONNECT_BROWSER_BINDING) {
      expect(res.headers.get("set-cookie") ?? "").toContain("connect_state")
    }

    const again = await post("/links/redeem", { token: link.token }, asMember)
    expect(again.status).toBe(410)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      "CONNECT_LINK_INVALID",
    )
  })

  it("a refused connect lands back on the link's page with the reason, recorded for the CLI's wait", async () => {
    // The account the member signs in as is already the organization's (a
    // connection without `orgAndPersonalCoexist`): the callback refuses it.
    const shared = `shared-${Date.now()}@acme.example`
    await sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
         status, created_by)
      VALUES (${orgId}, ${APP}, ${CONN}, 'org', NULL, 'oauth2', ${shared}, 'active', ${admin.id})`
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const tokenServer = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          access_token: "member-token",
          expires_in: 3600,
          id_token: `${part({ alg: "none" })}.${part({ email: shared })}.sig`,
        }),
    })
    try {
      const link = await mintForMember()
      expect(await readConnectLinkRefusal(link.token)).toBeNull()
      const res = await post("/links/redeem", { token: link.token }, await tokenFor(member.id, []))
      expect(res.status).toBe(200)
      const { redirectUrl } = ((await res.json()) as { data: { redirectUrl: string } }).data
      const state = new URL(redirectUrl).searchParams.get("state") as string
      // The provider's token endpoint is the local stand-in (the state carries it).
      const key = `oauth:state:${state}`
      const record = JSON.parse((await redis.get(key)) ?? "{}")
      record.tokenUrl = `http://127.0.0.1:${tokenServer.port}/token`
      await redis.set(key, JSON.stringify(record), "EX", 900)
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""

      const cb = await app.request(
        `/api/connections/callback?code=c1&state=${encodeURIComponent(state)}`,
        { headers: cookie ? { cookie } : {} },
      )
      expect(cb.status).toBe(302)
      const to = new URL(cb.headers.get("location") ?? "")
      expect(to.pathname).toBe("/connect/link")
      expect(to.searchParams.get("oauth_error")).toBe("connection_held_by_other_owner")
      expect(to.searchParams.get("oauth_error_description")).toContain(
        "already connected for the whole organization",
      )
      expect(await readConnectLinkRefusal(link.token)).toMatchObject({
        reason: "connection_held_by_other_owner",
      })
      // Nothing personal was stored; the org's row is untouched.
      const rows = await sql<
        { owner_type: string }[]
      >`SELECT owner_type FROM kernel.connected_accounts
        WHERE org_id = ${orgId} AND app_name = ${APP} AND identifier = ${shared} AND status = 'active'`
      expect(rows.map((r) => r.owner_type)).toEqual(["org"])
    } finally {
      tokenServer.stop(true)
    }
  })

  it("refuses an expired link", async () => {
    const link = await mintForMember()
    await redis.pexpire(connectLinkKey(link.token), 1)
    await Bun.sleep(20)
    const res = await post("/links/redeem", { token: link.token }, await tokenFor(member.id, []))
    expect(res.status).toBe(410)
  })

  it("is minted for someone else only by an admin of the connection", async () => {
    const asMemberMinter = {
      orgId,
      email: admin.email,
      appName: APP,
      connectionName: CONN,
      minter: { kind: "user" as const, userId: member.id, scopes: [] },
    }
    await expect(mintConnectLink(asMemberMinter)).rejects.toBeInstanceOf(ConnectLinkError)
    const ok = await mintConnectLink({
      ...asMemberMinter,
      email: member.email,
      minter: { kind: "user", userId: admin.id, scopes: [ADMIN_SCOPE] },
    })
    expect(ok.user.id).toBe(member.id)
    await expect(
      mintConnectLink({ ...asMemberMinter, connectionName: "keys", minter: { kind: "cli" } }),
    ).rejects.toThrow(/credentials/)
  })

  it("tells another organization's session nothing about the link, not even whose it is", async () => {
    const link = await mintForMember()
    // A session of another organization (any user id there).
    const stranger = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() }
    expect(await peekConnectLink(link.token, stranger)).toEqual({ status: "invalid" })
    expect(await claimConnectLink(link.token, stranger)).toEqual({ status: "invalid" })
    // Still usable for its member.
    expect((await peekConnectLink(link.token, { orgId, userId: member.id })).status).toBe("ok")
  })

  it("the send-link tool is refused at stage time when it could not be sent", async () => {
    const forOther = (await connectLinkSendPreflight(
      { app: APP, connection: CONN, email: admin.email },
      { orgId, userId: member.id },
    )) as { error?: { code: string } }
    expect(forOther.error?.code).toBe("NOT_ALLOWED")
    const nobody = (await connectLinkSendPreflight(
      { app: APP, connection: CONN, email: `nobody-${crypto.randomUUID()}@x.test` },
      { orgId, userId: admin.id },
    )) as { error?: { code: string } }
    expect(nobody.error?.code).toBe("USER_NOT_FOUND")
  })

  describe("disconnect", () => {
    async function account(ownerType: "org" | "user", ownerId: string | null, identifier: string) {
      const rows = (await sql`
        INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, identifier, owner_type, owner_id, provider_type, status, created_by)
        VALUES (${orgId}, ${APP}, ${CONN}, ${identifier}, ${ownerType}, ${ownerId}, 'oauth2', 'active', ${admin.id})
        RETURNING id`) as Array<{ id: string }>
      const [t] = await findDisconnectTargets(orgId, APP, CONN, identifier)
      if (!t || t.id !== rows[0]?.id) throw new Error("target not found")
      return t
    }
    const asMember = () => ({ kind: "user" as const, userId: member.id, scopes: [] })
    const asAdmin = () => ({ kind: "user" as const, userId: admin.id, scopes: [ADMIN_SCOPE] })

    it("an org connection: the connection's admin and the CLI, never a member", async () => {
      const t = await account("org", null, `org-${crypto.randomUUID()}@x.test`)
      expect(decideDisconnect(orgId, t, asMember())).toMatchObject({
        allowed: false,
        code: "ADMIN_SCOPE_REQUIRED",
      })
      expect(decideDisconnect(orgId, t, asAdmin()).allowed).toBe(true)
      expect(decideDisconnect(orgId, t, { kind: "cli" }).allowed).toBe(true)
    })

    it("a personal connection: its owner; another member never; an admin only with force", async () => {
      const t = await account("user", member.id, `own-${crypto.randomUUID()}@x.test`)
      expect(decideDisconnect(orgId, t, asMember())).toEqual({ allowed: true, forced: false })
      const other = await minimal.person(orgId, { role: "member" })
      expect(
        decideDisconnect(orgId, t, { kind: "user", userId: other.id, scopes: [] }),
      ).toMatchObject({ allowed: false, code: "NOT_OWNER" })
      expect(decideDisconnect(orgId, t, asAdmin())).toMatchObject({
        allowed: false,
        code: "FORCE_REQUIRED",
      })
      expect(decideDisconnect(orgId, t, { kind: "cli" })).toMatchObject({ allowed: false })
      expect(decideDisconnect(orgId, t, { kind: "cli" }, { force: true })).toEqual({
        allowed: true,
        forced: true,
      })
    })

    it("the agent tool: refuses someone else's personal connection even for an admin, the owner's goes", async () => {
      const t = await account("user", member.id, `tool-${crypto.randomUUID()}@x.test`)
      const params = { app: APP, connection: CONN, account: t.identifier }
      const byAdmin = (await connectionDisconnectPreflight(params, {
        orgId,
        userId: admin.id,
      })) as { error?: { code: string } }
      expect(byAdmin.error?.code).toBe("NOT_OWNER")
      // Even with the id pinned (staged by someone else), an admin's approval removes nothing.
      const approvedByAdmin = (await handleConnectionDisconnect(
        { ...params, connectionId: t.id },
        {
          orgId,
          userId: admin.id,
          approverUserId: admin.id,
        },
      )) as { error?: { code: string } }
      expect(approvedByAdmin.error?.code).toBe("NOT_OWNER")
      const staged = (await connectionDisconnectPreflight(params, {
        orgId,
        userId: member.id,
      })) as { ok?: boolean; pinnedParams?: { connectionId: string } }
      expect(staged.pinnedParams?.connectionId).toBe(t.id)
      const own = (await handleConnectionDisconnect(
        { ...params, ...staged.pinnedParams },
        { orgId, userId: member.id, approverUserId: member.id },
      )) as { disconnected?: boolean }
      expect(own.disconnected).toBe(true)
    })

    it("the agent tool: an address matching an org AND a personal connection is refused, both listed by id", async () => {
      // The match is case-insensitive: the same address, written two ways, on two connections.
      const address = `both-${crypto.randomUUID()}@x.test`
      const org = await account("org", null, address)
      const rows = (await sql`
        INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, identifier, owner_type, owner_id, provider_type, status, created_by)
        VALUES (${orgId}, ${APP}, ${CONN}, ${address.toUpperCase()}, 'user', ${admin.id}, 'oauth2', 'active', ${admin.id})
        RETURNING id`) as Array<{ id: string }>
      const personalId = rows[0]?.id as string
      const params = { app: APP, connection: CONN, account: address }
      const staged = (await connectionDisconnectPreflight(params, {
        orgId,
        userId: admin.id,
      })) as { error?: { code: string; message: string } }
      expect(staged.error?.code).toBe("AMBIGUOUS_CONNECTION")
      expect(staged.error?.message).toContain(org.id)
      expect(staged.error?.message).toContain(personalId)
      expect(staged.error?.message).toContain("the organization's connection")
      expect(staged.error?.message).toContain(`personal connection of ${admin.email}`)

      // By id: the card names exactly that one, owner type and id included.
      const byId = (await connectionDisconnectPreflight(
        { ...params, account: org.id },
        { orgId, userId: admin.id },
      )) as { pinnedParams?: { connectionId: string } }
      expect(byId.pinnedParams?.connectionId).toBe(org.id)
      const card = await summarizeConnectionDisconnect(
        { ...params, account: org.id, ...byId.pinnedParams },
        { tx: {} as never, orgId, userId: admin.id },
      )
      const text = card.lines.join(" ")
      expect(text).toContain("the organization's connection")
      expect(text).toContain(org.id)
      expect(text).not.toContain(personalId)

      // The approved call removes the pinned id, whatever the address would resolve to.
      const done = (await handleConnectionDisconnect(
        { ...params, ...byId.pinnedParams },
        { orgId, userId: admin.id, approverUserId: admin.id },
      )) as { disconnected?: boolean; connectionId?: string }
      expect(done).toMatchObject({ disconnected: true, connectionId: org.id })
      const status = (await sql`
        SELECT id, status FROM kernel.connected_accounts
         WHERE id IN (${org.id}, ${personalId})`) as Array<{ id: string; status: string }>
      expect(Object.fromEntries(status.map((r) => [r.id, r.status]))).toEqual({
        [org.id]: "disconnected",
        [personalId]: "active",
      })
    })

    it("the agent tool: a call that was not staged (no pinned id) disconnects nothing", async () => {
      const t = await account("org", null, `unpinned-${crypto.randomUUID()}@x.test`)
      const r = (await handleConnectionDisconnect(
        { app: APP, connection: CONN, account: t.identifier },
        { orgId, userId: admin.id, approverUserId: admin.id },
      )) as { error?: { code: string } }
      expect(r.error?.code).toBe("CONNECTION_NOT_PINNED")
      const [row] = (await sql`
        SELECT status FROM kernel.connected_accounts WHERE id = ${t.id}`) as Array<{
        status: string
      }>
      expect(row?.status).toBe("active")
    })

    it("the agent tool: an org connection needs the connection's admin scope", async () => {
      const t = await account("org", null, `orgtool-${crypto.randomUUID()}@x.test`)
      const params = { app: APP, connection: CONN, account: t.identifier }
      const byMember = (await connectionDisconnectPreflight(params, {
        orgId,
        userId: member.id,
      })) as { error?: { code: string } }
      expect(byMember.error?.code).toBe("ADMIN_SCOPE_REQUIRED")
    })

    it("a forced disconnect clears the connection and writes an audit entry naming the owner", async () => {
      const t = await account("user", member.id, `forced-${crypto.randomUUID()}@x.test`)
      await performDisconnect({
        orgId,
        target: t,
        actor: { kind: "cli" },
        forced: true,
      })
      // The disconnect event names the system (the CLI), not a member who did nothing.
      const events = (await sql`
        SELECT payload FROM kernel.pending_events
         WHERE org_id = ${orgId} AND payload->>'entityId' = ${t.id}
           AND payload->>'action' = 'disconnect'`) as Array<{
        payload: { actorId?: string; actorType?: string }
      }>
      expect(events.map((e) => [e.payload.actorId, e.payload.actorType])).toEqual([
        ["system", "system"],
      ])
      const [row] = (await sql`
        SELECT status FROM kernel.connected_accounts WHERE id = ${t.id}`) as Array<{
        status: string
      }>
      expect(row?.status).toBe("disconnected")
      const audit = (await sql`
        SELECT action, metadata FROM kernel.audit_log
         WHERE org_id = ${orgId} AND entity_id = ${t.id}`) as Array<{
        action: string
        metadata: { ownerId?: string; identifier?: string }
      }>
      const forced = audit.find((a) => a.action === "connection.disconnect.forced")
      expect(forced?.metadata.ownerId).toBe(member.id)
      expect(forced?.metadata.identifier).toBe(t.identifier)
    })
  })
})

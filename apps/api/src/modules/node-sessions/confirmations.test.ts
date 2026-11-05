// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T14 (D24, D38, D41, L14): level confirmations, the only way a node level
// goes up. Minted by the owner's own session (never a node credential, an MCP
// token or a restricted device session), consumed once by its own node, bound
// to its agent or session at exactly its level; an attached profile_raise or
// session_start does not expire by age; no agent or MCP module can mint one.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { decodeJwt } from "jose"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  attachConfirmation,
  claimConfirmations,
  voidProfileConfirmationsAbove,
} from "./confirmations"

describe("level confirmations (P1-T14)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let agentId: string

  const call = (
    p: string,
    method: string,
    bearer: string,
    body?: unknown,
    nodeCredential?: string,
  ) =>
    app.request(p, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(nodeCredential ? { "X-Node-Credential": nodeCredential } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  async function enable(session: minimal.Session) {
    const res = await call("/api/nodes", "POST", session.bearer, {
      deviceId: `d.${crypto.randomUUID()}`,
      os: "macos",
    })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    return { nodeId: d.node.id as string, credential: d.credential as string }
  }

  const confirm = (body: Record<string, unknown>, session = owner, cred?: string) =>
    call("/api/me/node-level-confirmations", "POST", session.bearer, body, cred)

  async function mint(body: Record<string, unknown>): Promise<string> {
    const res = await confirm(body)
    expect(res.status).toBe(201)
    return (await json(res)).data.confirmationId as string
  }

  const consume = (id: string, cred: string, body: Record<string, unknown>) =>
    call(`/api/node/level-confirmations/${id}/consume`, "POST", owner.bearer, body, cred)

  async function seedSession(nodeId: string | null = null): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, node_id, agent_id, source, config_kind, title, prompt, model, level)
      VALUES (${owner.orgId}, ${owner.userId}, ${nodeId}, ${agentId}, 'app', 'owner', 'S', 'p',
              'claude-haiku-4-5', 'open')
      RETURNING id`
    return row.id
  }

  const attach = (input: Parameters<typeof attachConfirmation>[1]) =>
    withPrivilegedDb(owner.orgId, "test-attach", (tx) => attachConfirmation(tx, input))

  /** Age a row past its 5-minute window. */
  const age = (id: string) =>
    sql`UPDATE kernel.node_level_confirmations
          SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
        WHERE id = ${id}`

  const consumedAt = async (id: string) =>
    (
      await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM kernel.node_level_confirmations WHERE id = ${id}`
    )[0].consumed_at

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    other = await minimal.session(owner.orgId)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@cf-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    await releaseTestLock()
  })

  // ── mint ─────────────────────────────────────────────────────────────────

  it("the owner's session gets a 5-minute id", async () => {
    const n = await enable(owner)
    const before = Date.now()
    const res = await confirm({
      nodeId: n.nodeId,
      agentId,
      level: "standard",
      purpose: "profile_raise",
    })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    expect(d.confirmationId).toMatch(/^[0-9a-f-]{36}$/)
    const ttl = new Date(d.expiresAt).getTime() - before
    expect(ttl).toBeGreaterThan(4.5 * 60_000)
    expect(ttl).toBeLessThanOrEqual(5 * 60_000 + 5_000)
  })

  it("a request carrying X-Node-Credential is refused 403", async () => {
    const n = await enable(owner)
    const res = await confirm(
      { nodeId: n.nodeId, agentId, level: "open", purpose: "profile_raise" },
      owner,
      n.credential,
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe("node_credential_refused")
    const [{ n: count }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
    expect(count).toBe(0)
  })

  it("an MCP connection token is refused 401", async () => {
    const n = await enable(owner)
    const claims = decodeJwt(owner.bearer) as Record<string, any>
    const mcpToken = await signAccessToken(
      {
        userId: claims.userId,
        orgId: claims.orgId,
        name: claims.name,
        authVersion: claims.authVersion,
        permissionVersion: claims.permissionVersion,
        roles: claims.roles,
        scopes: claims.scopes,
        mcpConnectionId: crypto.randomUUID(),
        agentId,
      },
      env.JWT_SECRET,
      600,
    )
    const res = await call("/api/me/node-level-confirmations", "POST", mcpToken, {
      nodeId: n.nodeId,
      agentId,
      level: "open",
      purpose: "profile_raise",
    })
    expect(res.status).toBe(401)
  })

  it("a restricted device session is refused", async () => {
    const n = await enable(owner)
    const claims = decodeJwt(owner.bearer) as Record<string, any>
    const restricted = await signAccessToken(
      {
        userId: claims.userId,
        orgId: claims.orgId,
        name: claims.name,
        authVersion: claims.authVersion,
        permissionVersion: claims.permissionVersion,
        roles: claims.roles,
        scopes: claims.scopes,
        restricted: true,
      },
      env.JWT_SECRET,
      600,
    )
    const res = await call("/api/me/node-level-confirmations", "POST", restricted, {
      nodeId: n.nodeId,
      agentId,
      level: "open",
      purpose: "profile_raise",
    })
    expect(res.status).toBe(403)
  })

  it("another user's node, an agent the caller cannot run, or a wrong target shape is refused", async () => {
    const theirs = await enable(other)
    const mine = await enable(owner)
    const foreign = await confirm({
      nodeId: theirs.nodeId,
      agentId,
      level: "open",
      purpose: "profile_raise",
    })
    expect(foreign.status).toBe(404)
    const unknownAgent = await confirm({
      nodeId: mine.nodeId,
      agentId: crypto.randomUUID(),
      level: "open",
      purpose: "profile_raise",
    })
    expect(unknownAgent.status).toBe(404)
    const both = await confirm({
      nodeId: mine.nodeId,
      agentId,
      sessionId: crypto.randomUUID(),
      level: "open",
      purpose: "profile_raise",
    })
    expect(both.status).toBe(400)
    const raiseByAgent = await confirm({
      nodeId: mine.nodeId,
      agentId,
      level: "open",
      purpose: "session_raise",
    })
    expect(raiseByAgent.status).toBe(400)
  })

  // ── consume ──────────────────────────────────────────────────────────────

  it("consume from another node is 403; twice is 409; after 5 minutes unattached is 409; an attached profile_raise consumes after 5 minutes; an attached session_start consumes after 5 minutes for its session", async () => {
    const a = await enable(owner)
    const b = await enable(owner)

    const first = await mint({
      nodeId: a.nodeId,
      agentId,
      level: "standard",
      purpose: "profile_raise",
    })
    const fromB = await consume(first, b.credential, { agentId, level: "standard" })
    expect(fromB.status).toBe(403)
    // P1a skeptic S7 (D41): a profile_raise is consumable only once attached,
    // that is once the profile save that carried it went through.
    const unattached = await consume(first, a.credential, { agentId, level: "standard" })
    expect(unattached.status).toBe(409)
    expect((await json(unattached)).error.code).toBe("confirmation_mismatch")
    expect(await consumedAt(first)).toBeNull()
    expect(
      (
        await attach({
          id: first,
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          nodeId: a.nodeId,
          agentId,
          level: "standard",
          purpose: "profile_raise",
        })
      ).ok,
    ).toBe(true)
    const ok = await consume(first, a.credential, { agentId, level: "standard" })
    expect(ok.status).toBe(200)
    expect((await json(ok)).data).toEqual({ purpose: "profile_raise", level: "standard" })
    const twice = await consume(first, a.credential, { agentId, level: "standard" })
    expect(twice.status).toBe(409)
    expect((await json(twice)).error.code).toBe("confirmation_consumed")

    const stale = await mint({
      nodeId: a.nodeId,
      agentId,
      level: "standard",
      purpose: "profile_raise",
    })
    await age(stale)
    const late = await consume(stale, a.credential, { agentId, level: "standard" })
    expect(late.status).toBe(409)
    expect((await json(late)).error.code).toBe("confirmation_expired")

    const attachedRaise = await mint({
      nodeId: a.nodeId,
      agentId,
      level: "open",
      purpose: "profile_raise",
    })
    const attachedR = await attach({
      id: attachedRaise,
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      nodeId: a.nodeId,
      agentId,
      level: "open",
      purpose: "profile_raise",
    })
    expect(attachedR.ok).toBe(true)
    await age(attachedRaise)
    const raised = await consume(attachedRaise, a.credential, { agentId, level: "open" })
    expect(raised.status).toBe(200)

    const sessionId = await seedSession()
    const start = await mint({ nodeId: a.nodeId, agentId, level: "open", purpose: "session_start" })
    expect(
      (
        await attach({
          id: start,
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          nodeId: a.nodeId,
          agentId,
          level: "open",
          purpose: "session_start",
          attachedSessionId: sessionId,
        })
      ).ok,
    ).toBe(true)
    await age(start)
    const started = await consume(start, a.credential, { sessionId, level: "open" })
    expect(started.status).toBe(200)
    expect((await json(started)).data).toEqual({ purpose: "session_start", level: "open" })
  })

  it("session A's attached session_start cannot be consumed with session B's id (409 confirmation_mismatch), nor picked by B's claim", async () => {
    const n = await enable(owner)
    const sessionA = await seedSession()
    const sessionB = await seedSession()
    const id = await mint({ nodeId: n.nodeId, agentId, level: "open", purpose: "session_start" })
    const attached = await attach({
      id,
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      nodeId: n.nodeId,
      agentId,
      level: "open",
      purpose: "session_start",
      attachedSessionId: sessionA,
    })
    expect(attached.ok).toBe(true)

    const wrong = await consume(id, n.credential, { sessionId: sessionB, level: "open" })
    expect(wrong.status).toBe(409)
    expect((await json(wrong)).error.code).toBe("confirmation_mismatch")

    const claimFor = (sessionId: string) =>
      withPrivilegedDb(owner.orgId, "test-claim", (tx) =>
        claimConfirmations(tx, {
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          nodeId: n.nodeId,
          agentId,
          sessionId,
          profileLevel: "strict",
          sessionLevel: "open",
        }),
      )
    expect(await claimFor(sessionB)).toEqual({})
    expect(await claimFor(sessionA)).toEqual({ sessionConfirmationId: id })
    // Attached once: it cannot be re-attached to B either.
    const again = await attach({
      id,
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      nodeId: n.nodeId,
      agentId,
      level: "open",
      purpose: "session_start",
      attachedSessionId: sessionB,
    })
    expect(again).toEqual({ ok: false, code: "confirmation_mismatch" })
  })

  // P3-T24 (G10): a level raised on a dormant session (no process) is
  // admitted at its next claim: the attached session_raise of THAT session,
  // at the session's level, is answered as its session confirmation, also
  // after the 5-minute window (attached, it waits for the claim).
  it("a dormant session's attached session_raise is answered at claim", async () => {
    const n = await enable(owner)
    const sessionA = await seedSession(n.nodeId)
    const sessionB = await seedSession(n.nodeId)
    const id = await mint({
      nodeId: n.nodeId,
      sessionId: sessionA,
      level: "standard",
      purpose: "session_raise",
    })
    const attached = await attach({
      id,
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      nodeId: n.nodeId,
      sessionId: sessionA,
      level: "standard",
      purpose: "session_raise",
    })
    expect(attached.ok).toBe(true)
    await age(id)
    const claimFor = (sessionId: string, sessionLevel: "standard" | "open") =>
      withPrivilegedDb(owner.orgId, "test-claim", (tx) =>
        claimConfirmations(tx, {
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          nodeId: n.nodeId,
          agentId,
          sessionId,
          profileLevel: "strict",
          sessionLevel,
        }),
      )
    expect(await claimFor(sessionA, "standard")).toEqual({ sessionConfirmationId: id })
    expect(await claimFor(sessionB, "standard")).toEqual({})
    expect(await claimFor(sessionA, "open")).toEqual({})
    // The node consumes it once for that session at that level.
    const used = await consume(id, n.credential, { sessionId: sessionA, level: "standard" })
    expect(used.status).toBe(200)
    expect(await claimFor(sessionA, "standard")).toEqual({})
  })

  it("a confirmation at standard does not admit open, and at open does not admit standard", async () => {
    const n = await enable(owner)
    const standard = await mint({
      nodeId: n.nodeId,
      agentId,
      level: "standard",
      purpose: "profile_raise",
    })
    const up = await consume(standard, n.credential, { agentId, level: "open" })
    expect(up.status).toBe(409)
    expect((await json(up)).error.code).toBe("confirmation_mismatch")
    const open = await mint({ nodeId: n.nodeId, agentId, level: "open", purpose: "profile_raise" })
    const down = await consume(open, n.credential, { agentId, level: "standard" })
    expect(down.status).toBe(409)
    expect((await json(down)).error.code).toBe("confirmation_mismatch")
    // Attach follows the same rule.
    expect(
      await attach({
        id: open,
        orgId: owner.orgId,
        ownerUserId: owner.userId,
        nodeId: n.nodeId,
        agentId,
        level: "standard",
        purpose: "profile_raise",
      }),
    ).toEqual({ ok: false, code: "confirmation_mismatch" })
    // And the claim lookup.
    const attached = await attach({
      id: open,
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      nodeId: n.nodeId,
      agentId,
      level: "open",
      purpose: "profile_raise",
    })
    expect(attached.ok).toBe(true)
    const claimAt = (profileLevel: "standard" | "open") =>
      withPrivilegedDb(owner.orgId, "test-claim", (tx) =>
        claimConfirmations(tx, {
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          nodeId: n.nodeId,
          agentId,
          sessionId: crypto.randomUUID(),
          profileLevel,
          sessionLevel: profileLevel,
        }),
      )
    expect(await claimAt("standard")).toEqual({})
    expect(await claimAt("open")).toEqual({ profileConfirmationId: open })
  })

  it("a second profile_raise attach supersedes the first", async () => {
    const n = await enable(owner)
    const input = (id: string) => ({
      id,
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      nodeId: n.nodeId,
      agentId,
      level: "standard" as const,
      purpose: "profile_raise" as const,
    })
    const first = await mint({
      nodeId: n.nodeId,
      agentId,
      level: "standard",
      purpose: "profile_raise",
    })
    expect((await attach(input(first))).ok).toBe(true)
    const second = await mint({
      nodeId: n.nodeId,
      agentId,
      level: "standard",
      purpose: "profile_raise",
    })
    expect((await attach(input(second))).ok).toBe(true)
    expect(await consumedAt(first)).not.toBeNull()
    expect(await consumedAt(second)).toBeNull()
    const res = await consume(first, n.credential, { agentId, level: "standard" })
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe("confirmation_consumed")
  })

  it("voiding above strict consumes an unconsumed open profile_raise", async () => {
    const n = await enable(owner)
    const open = await mint({ nodeId: n.nodeId, agentId, level: "open", purpose: "profile_raise" })
    const voided = await withPrivilegedDb(owner.orgId, "test-void", (tx) =>
      voidProfileConfirmationsAbove(tx, {
        orgId: owner.orgId,
        ownerUserId: owner.userId,
        agentId,
        level: "strict",
      }),
    )
    expect(voided).toBe(1)
    expect(await consumedAt(open)).not.toBeNull()
    const res = await consume(open, n.credential, { agentId, level: "open" })
    expect(res.status).toBe(409)
  })

  // ── reachability ─────────────────────────────────────────────────────────

  it("no agent tool or MCP tool can mint a confirmation", () => {
    const srcDir = path.resolve(__dirname, "../..")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== "node_modules") walk(full)
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full)
      }
    }
    walk(srcDir)
    const rel = (f: string) => path.relative(srcDir, f).split(path.sep).join("/")
    const minting = files.filter((f) =>
      fs.readFileSync(f, "utf8").includes("insertLevelConfirmation"),
    )
    expect(minting.map(rel).sort()).toEqual([
      "modules/node-sessions/confirmations.ts",
      "modules/node-sessions/routes-confirm.ts",
    ])
    const toolSurface = files.filter((f) => {
      const r = rel(f)
      return r.startsWith("modules/agent/") || r.startsWith("modules/mcp/") || r.startsWith("apps/")
    })
    expect(toolSurface.length).toBeGreaterThan(50)
    const reaching = toolSurface.filter((f) =>
      /node-sessions\/(confirmations|routes-confirm)["']/.test(fs.readFileSync(f, "utf8")),
    )
    expect(reaching.map(rel)).toEqual([])
  })
})

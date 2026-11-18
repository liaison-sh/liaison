// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A member of the org who is a signer signs in their own session: no link is
// mailed to them, they are told on their Home and by a mail with no link, their
// Read and sign makes the link in their session, and the link and code alone
// never sign for them.
import { describe, expect, it } from "bun:test"
import * as jose from "jose"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { createSession } from "~/modules/auth/auth"
import { signAccessToken } from "~/modules/auth/jwt"
import { revokeSessions } from "~/modules/auth/session-revocation"
import {
  actionRow,
  call,
  codeFor,
  k,
  nextIp,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"
import { listTargetClientActions, mintClientAction } from "./mint"

const kit = useClientActionWorld("staffdocs")

async function mintToStaff(over: { waitingTurn?: boolean; signOrder?: number } = {}) {
  const before = kit.capture.sent.length
  const r = await mintClientAction({
    ...over,
    orgId: kit.w.orgId,
    kind: "sign",
    targetApp: kit.targetApp,
    targetType: kit.targetType,
    targetId: crypto.randomUUID(),
    invitedEmail: kit.w.member.email,
    invitedName: kit.w.member.name,
    expiresInDays: 7,
    createdByUserId: kit.w.admin.userId,
  })
  return { r, before }
}

async function myLink(id: string, userId: string) {
  const { accessToken } = await createSession(userId, kit.w.orgId)
  return app.request(`/api/client-actions/${id}/my-link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  })
}

async function bearerOf(userId: string): Promise<string> {
  return `Bearer ${(await createSession(userId, kit.w.orgId)).accessToken}`
}

type Claims = Parameters<typeof signAccessToken>[0]

/** The member's real session token, signed again with `change` applied to its claims. */
async function alteredBearer(userId: string, change: (c: Claims) => Claims): Promise<string> {
  const { accessToken } = await createSession(userId, kit.w.orgId)
  const claims = jose.decodeJwt(accessToken) as unknown as Claims
  return `Bearer ${await signAccessToken(change(claims), env.JWT_SECRET)}`
}

describe("a staff signer", () => {
  it("gets no mailed link: a Home row and a mail with no link instead", async () => {
    const { r, before } = await mintToStaff()
    expect(r.signerIsStaff).toBe(true)
    expect(r.mailQueued).toBe(false)
    let staffMail: (typeof kit.capture.sent)[number] | undefined
    for (let i = 0; i < 100 && !staffMail; i++) {
      staffMail = kit.capture.sent
        .slice(before)
        .find((m) => m.template === "client-action.staff" && m.to === kit.w.member.email)
      if (!staffMail) await new Promise((res) => setTimeout(res, 20))
    }
    expect(staffMail).toBeDefined()
    expect(`${staffMail?.text}${staffMail?.html}`).not.toContain("#t=")
    expect(`${staffMail?.text}`).toContain("Read and sign")
    // The signer may be the sender themselves: the subject never says someone asks them.
    expect(staffMail?.subject).toMatch(/^Your turn to sign "/)
    // The mail says what really follows: a code to confirm comes to this address.
    expect(`${staffMail?.text}`).not.toContain("will send you a code")
    expect(`${staffMail?.text}`).toContain("code")
    expect(
      kit.capture.sent
        .slice(before)
        .filter((m) => m.template === "client-action.link" && m.to === kit.w.member.email),
    ).toEqual([])
    const turns = (await sql`
      SELECT payload FROM ${k("pending_events")}
       WHERE payload->>'entityId' = ${r.id} AND payload->>'action' = 'staff_turn'`) as unknown as Array<{
      payload: { data: { signerUserIds: string[] } }
    }>
    expect(turns).toHaveLength(1)
    const turn = turns[0]?.payload.data as
      | { signerUserIds: string[]; staffTurn?: boolean }
      | undefined
    expect(turn?.signerUserIds).toEqual([kit.w.member.userId])
    expect(turn?.staffTurn).toBe(true)
    expect((await actionRow(r.id)).signer_user_id).toBe(kit.w.member.userId)
  })

  it("the app's list of a target's links names the member who signs, so their screen offers their own Read and sign", async () => {
    const { r } = await mintToStaff()
    const target = (await actionRow(r.id)).target_id as string
    const links = await listTargetClientActions({
      orgId: kit.w.orgId,
      targetApp: kit.targetApp,
      targetType: kit.targetType,
      targetId: target,
    })
    expect(links.map((l) => [l.id, l.signerUserId])).toEqual([[r.id, kit.w.member.userId]])
  })

  it("Read and sign makes the link for the signer only", async () => {
    const { r } = await mintToStaff()
    expect((await myLink(r.id, kit.w.admin.userId)).status).toBe(404)
    const mine = await myLink(r.id, kit.w.member.userId)
    expect(mine.status).toBe(200)
    expect(mine.headers.get("cache-control")).toBe("no-store")
    const { data } = (await mine.json()) as { data: { token: string } }
    expect(data.token.length).toBeGreaterThan(30)
  })

  it("link and code with no session refuse; the same member signed in succeeds; another member's session refuses", async () => {
    const { r } = await mintToStaff()
    const { data } = (await (await myLink(r.id, kit.w.member.userId)).json()) as {
      data: { token: string }
    }
    const token = data.token
    const ip = nextIp()
    const code = await codeFor(kit, token, ip, kit.w.member.email)
    const body = { t: token, code, name: kit.w.member.name }
    const bare = await call("verify", body, { "x-bun-socket-ip": ip })
    expect(bare.status).toBe(401)
    const other = await call("verify", body, {
      "x-bun-socket-ip": ip,
      Authorization: await bearerOf(kit.w.admin.userId),
    })
    expect(other.status).toBe(401)
    const own = await bearerOf(kit.w.member.userId)
    const verified = await call("verify", body, { "x-bun-socket-ip": ip, Authorization: own })
    expect(verified.status).toBe(200)
    const { proof } = (await verified.json()) as { proof: string }
    const decide = { t: token, proof, decision: "sign", typed_name: kit.w.member.name }
    const noSession = await call("decide", decide, { "x-bun-socket-ip": ip })
    expect(noSession.status).toBe(401)
    const wrongSession = await call("decide", decide, {
      "x-bun-socket-ip": ip,
      Authorization: await bearerOf(kit.w.admin.userId),
    })
    expect(wrongSession.status).toBe(401)
    expect((await actionRow(r.id)).decided_at).toBeNull()
    const signed = await call("decide", decide, { "x-bun-socket-ip": ip, Authorization: own })
    expect(signed.status).toBe(200)
    expect((await actionRow(r.id)).decision).toBe("signed")
    // Read and sign again, once answered: it says so, and makes no new link.
    const again = await myLink(r.id, kit.w.member.userId)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("answered")
  })

  it("still waiting for the signer before them, Read and sign gives no link and the turn stays closed", async () => {
    const { r } = await mintToStaff({ waitingTurn: true, signOrder: 2 })
    expect(r.status).toBe("waiting_turn")
    const res = await myLink(r.id, kit.w.member.userId)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string }; data?: unknown }
    expect(body.error.code).toBe("not_your_turn")
    expect(body.data).toBeUndefined()
    const row = await actionRow(r.id)
    expect(row.token_hash).toBeNull()
    expect(row.decided_at).toBeNull()
  })

  it("signs only in a session the member door accepts: an MCP, agent-bound, second-factor-pending, ended or outdated token refuses", async () => {
    const { r } = await mintToStaff()
    const { data } = (await (await myLink(r.id, kit.w.member.userId)).json()) as {
      data: { token: string }
    }
    const token = data.token
    const ip = nextIp()
    const code = await codeFor(kit, token, ip, kit.w.member.email)
    const body = { t: token, code, name: kit.w.member.name }
    const uid = kit.w.member.userId
    const ended = await createSession(uid, kit.w.orgId)
    const endedSid = (jose.decodeJwt(ended.accessToken) as { sid?: string }).sid
    expect(endedSid).toBeTruthy()
    revokeSessions([endedSid as string], "signed out")
    const refused = [
      await alteredBearer(uid, (c) => ({ ...c, mcpConnectionId: crypto.randomUUID() })),
      await alteredBearer(uid, (c) => ({ ...c, agentId: crypto.randomUUID() })),
      await alteredBearer(uid, (c) => ({ ...c, secondFactorRequired: true })),
      await alteredBearer(uid, (c) => ({ ...c, authVersion: c.authVersion + 1 })),
      await alteredBearer(uid, (c) => ({ ...c, permissionVersion: c.permissionVersion + 1 })),
      `Bearer ${ended.accessToken}`,
    ]
    for (const bearer of refused) {
      const res = await call("verify", body, { "x-bun-socket-ip": ip, Authorization: bearer })
      expect(res.status).toBe(401)
    }
    const own = await bearerOf(uid)
    const verified = await call("verify", body, { "x-bun-socket-ip": ip, Authorization: own })
    expect(verified.status).toBe(200)
    const { proof } = (await verified.json()) as { proof: string }
    const decide = { t: token, proof, decision: "sign", typed_name: kit.w.member.name }
    for (const bearer of refused) {
      const res = await call("decide", decide, { "x-bun-socket-ip": ip, Authorization: bearer })
      expect(res.status).toBe(401)
    }
    expect((await actionRow(r.id)).decided_at).toBeNull()
    const signed = await call("decide", decide, { "x-bun-socket-ip": ip, Authorization: own })
    expect(signed.status).toBe(200)
  })
})

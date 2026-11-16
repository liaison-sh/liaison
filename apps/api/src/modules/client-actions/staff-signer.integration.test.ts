// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A member of the org who is a signer signs in their own session: no link is
// mailed to them, they are told on their Home and by a mail with no link, their
// Read and sign makes the link in their session, and the link and code alone
// never sign for them.
import { describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { createSession } from "~/modules/auth/auth"
import {
  actionRow,
  call,
  codeFor,
  k,
  nextIp,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"
import { mintClientAction } from "./mint"

const kit = useClientActionWorld("staffdocs")

async function mintToStaff() {
  const before = kit.capture.sent.length
  const r = await mintClientAction({
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
    expect(turns[0]?.payload.data.signerUserIds).toEqual([kit.w.member.userId])
    expect((await actionRow(r.id)).signer_user_id).toBe(kit.w.member.userId)
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
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Delete my account" (spec S19, S20), through the real app: the real auth
// middleware, the real step-up store in Redis and the real erasure.
//
// Pinned here:
//   * the deletion is confirmed by the emailed code ONLY: a password is refused,
//   * five wrong codes delete the stored code, so the right one no longer works,
//   * the last admin of the org is refused with 409 and a reason,
//   * a success erases the account, deletes its push tokens, cancels the
//     approvals it requested and those where it was the only approver (with a
//     readable reason), leaves the other approvals alone, and the same session
//     is refused on a second call,
//   * the code is returned in the response body only for the reserved App
//     Review org on a demo box, never anywhere else.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { demoProvider } from "~/infra/email"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { stepUpCodeKey } from "~/modules/auth/step-up"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(releaseTestLock)

afterEach(() => {
  DemoModeTestAccess.set(null)
})

function headers(bearer: string): Record<string, string> {
  return { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }
}

async function deleteAccount(bearer: string, body: unknown): Promise<Response> {
  return app.request("/api/auth/account/delete", {
    method: "POST",
    headers: headers(bearer),
    body: JSON.stringify(body),
  })
}

async function requestCode(bearer: string): Promise<Response> {
  return app.request("/api/auth/totp/step-up", {
    method: "POST",
    headers: headers(bearer),
    body: JSON.stringify({ purpose: "account_delete" }),
  })
}

/** A valid emailed code for this user, stored the way the step-up route stores it. */
async function plantCode(userId: string): Promise<string> {
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await redis.set(stepUpCodeKey(userId, "account_delete"), hashToken(code), "EX", 600)
  return code
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000"
}

async function memberSession(): Promise<{ admin: minimal.Person; member: minimal.Session }> {
  const admin = await minimal.orgAdmin((await createTestOrg()).id)
  const member = await minimal.session(admin.orgId, { role: "member" })
  return { admin, member }
}

async function insertApproval(opts: {
  orgId: string
  threadId: string
  requestedBy: string
  resourceOwnerId?: string | null
  notifyUserIds?: string[]
}): Promise<string> {
  return withSystemDb("account-delete-test-approval", async (tx) => {
    const notify = opts.notifyUserIds ?? []
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.approval_requests
          (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
           current_payload, expires_at, requested_by, resource_owner_id, notify_user_ids)
        VALUES (${opts.orgId}::uuid, ${`acct-del-${crypto.randomUUID()}`}, ${opts.threadId}::uuid,
                ${opts.threadId}::uuid, 'tickets:reply', '{}'::jsonb, '{}'::jsonb,
                now() + interval '1 day', ${opts.requestedBy}::uuid,
                ${opts.resourceOwnerId ?? null}::uuid,
                ${`{${notify.join(",")}}`}::uuid[])
        RETURNING id::text AS id`),
    )
    return rows[0].id
  })
}

async function approvalRow(id: string): Promise<{ status: string; reason: string | null }> {
  return withSystemDb("account-delete-test-read-approval", async (tx) => {
    const rows = extractRows<{ status: string; reason: string | null }>(
      await tx.execute(
        drizzleSql`SELECT status, reason FROM kernel.approval_requests WHERE id = ${id}::uuid`,
      ),
    )
    return rows[0]
  })
}

describe("POST /api/auth/account/delete", () => {
  test("a password does not confirm the deletion; only the emailed code does", async () => {
    const { member } = await memberSession()
    const res = await deleteAccount(member.bearer, { currentPassword: "Passw0rd!" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { message?: string } }
    expect(JSON.stringify(body)).toMatch(/emailed code/i)
    // Still a live account: the session works.
    const me = await app.request("/api/auth/totp/status", { headers: headers(member.bearer) })
    expect(me.status).toBe(200)
  })

  test("five wrong codes delete the stored code; the right code then fails", async () => {
    const { member } = await memberSession()
    const code = await plantCode(member.userId)
    for (let i = 0; i < 5; i++) {
      const res = await deleteAccount(member.bearer, { stepUpCode: wrongCode(code) })
      // 422, not 401: a 401 would read as a dead session to the web client.
      expect(res.status).toBe(422)
    }
    expect(await redis.get(stepUpCodeKey(member.userId, "account_delete"))).toBeNull()
    const sixth = await deleteAccount(member.bearer, { stepUpCode: code })
    expect(sixth.status).toBe(422)
  })

  test("a fresh code resets the wrong-code count", async () => {
    const { member } = await memberSession()
    const first = await plantCode(member.userId)
    for (let i = 0; i < 4; i++) {
      await deleteAccount(member.bearer, { stepUpCode: wrongCode(first) })
    }
    expect((await requestCode(member.bearer)).status).toBe(200)
    const code = await plantCode(member.userId)
    await deleteAccount(member.bearer, { stepUpCode: wrongCode(code) })
    // One wrong code on the new code: still stored.
    expect(await redis.get(stepUpCodeKey(member.userId, "account_delete"))).not.toBeNull()
  })

  test("the last admin is refused with 409 and told what to do", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const bearer = admin.bearer
    const code = await plantCode(admin.userId)
    const res = await deleteAccount(bearer, { stepUpCode: code })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toMatch(/only admin/i)
    // Refused before the code was spent and before anything was erased.
    expect(await redis.get(stepUpCodeKey(admin.userId, "account_delete"))).not.toBeNull()
    const me = await app.request("/api/auth/totp/status", { headers: headers(bearer) })
    expect(me.status).toBe(200)
  })

  test("a deactivated second admin does not count: the last active admin is refused", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const other = await minimal.person(admin.orgId, { role: "admin" })
    await withSystemDb("account-delete-test-deactivate", (tx) =>
      tx.execute(
        drizzleSql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${other.id}::uuid`,
      ),
    )
    const res = await deleteAccount(admin.bearer, { stepUpCode: await plantCode(admin.userId) })
    expect(res.status).toBe(409)
  })

  test("more than ten attempts in an hour are refused with 429", async () => {
    const { member } = await memberSession()
    const code = await plantCode(member.userId)
    await redis.set(`account-delete-rate:${member.userId}`, "10", "EX", 3600)
    const res = await deleteAccount(member.bearer, { stepUpCode: code })
    expect(res.status).toBe(429)
    // The account is untouched.
    const me = await app.request("/api/auth/totp/status", { headers: headers(member.bearer) })
    expect(me.status).toBe(200)
  })

  test("an admin with another active admin can delete their account", async () => {
    const admin = await minimal.orgAdmin((await createTestOrg()).id)
    const second = await minimal.session(admin.orgId, { role: "admin" })
    const res = await deleteAccount(second.bearer, { stepUpCode: await plantCode(second.userId) })
    expect(res.status).toBe(200)
  })

  test("success erases the account, its push tokens and cancels its approvals", async () => {
    const { admin, member } = await memberSession()
    const orgId = member.orgId
    const threadId = await minimal.thread(orgId, admin.id)

    await withSystemDb("account-delete-test-push", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${orgId}::uuid, ${member.userId}::uuid, 'ios', ${`tok-${crypto.randomUUID()}`})`),
    )
    const requested = await insertApproval({ orgId, threadId, requestedBy: member.userId })
    const ownerRouted = await insertApproval({
      orgId,
      threadId,
      requestedBy: admin.id,
      resourceOwnerId: member.userId,
    })
    const soleNotified = await insertApproval({
      orgId,
      threadId,
      requestedBy: admin.id,
      notifyUserIds: [member.userId],
    })
    const shared = await insertApproval({
      orgId,
      threadId,
      requestedBy: admin.id,
      notifyUserIds: [member.userId, admin.id],
    })

    const res = await deleteAccount(member.bearer, { stepUpCode: await plantCode(member.userId) })
    expect(res.status).toBe(200)

    const user = await withSystemDb("account-delete-test-user", async (tx) =>
      extractRows<{ email: string; status: string; tokens: number; sessions: number }>(
        await tx.execute(drizzleSql`
          SELECT u.email, u.status,
                 (SELECT count(*)::int FROM kernel.push_tokens WHERE user_id = u.id) AS tokens,
                 (SELECT count(*)::int FROM kernel.sessions WHERE user_id = u.id) AS sessions
            FROM kernel.users u WHERE u.id = ${member.userId}::uuid`),
      ),
    )
    expect(user[0].email).toBe(`deleted-user-${member.userId}`)
    expect(user[0].status).toBe("deactivated")
    expect(user[0].tokens).toBe(0)
    expect(user[0].sessions).toBe(0)

    for (const id of [requested, ownerRouted, soleNotified]) {
      const row = await approvalRow(id)
      expect(row.status).toBe("cancelled")
      expect(row.reason).toMatch(/deleted their account/i)
    }
    expect((await approvalRow(shared)).status).toBe("pending")

    const second = await deleteAccount(member.bearer, { stepUpCode: "123456" })
    expect(second.status).toBe(401)
  })
})

describe("the step-up code in the response body (demo reviewer)", () => {
  test("absent off demo mode", async () => {
    const { member } = await memberSession()
    const res = await requestCode(member.bearer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data.sent).toBe(true)
    expect(body.data.demoCode).toBeUndefined()
  })

  test("absent in demo mode for a visitor demo org", async () => {
    const { member } = await memberSession()
    DemoModeTestAccess.set(true)
    await markOrgAsDemo(member.orgId, visitorMarker(24))
    try {
      const res = await requestCode(member.bearer)
      const body = (await res.json()) as { data: Record<string, unknown> }
      expect(body.data.demoCode).toBeUndefined()
    } finally {
      invalidateDemoMarker(member.orgId)
    }
  })

  test("absent for the reserved org when the box is not in demo mode", async () => {
    const { member } = await memberSession()
    await markOrgAsDemo(member.orgId, reservedMarker())
    DemoModeTestAccess.set(false)
    try {
      const res = await requestCode(member.bearer)
      const body = (await res.json()) as { data: Record<string, unknown> }
      expect(body.data.demoCode).toBeUndefined()
    } finally {
      invalidateDemoMarker(member.orgId)
    }
  })

  test("absent for another purpose even in the reserved org", async () => {
    const { member } = await memberSession()
    DemoModeTestAccess.set(true)
    await markOrgAsDemo(member.orgId, reservedMarker())
    try {
      const res = await app.request("/api/auth/totp/step-up", {
        method: "POST",
        headers: headers(member.bearer),
        body: JSON.stringify({}),
      })
      const body = (await res.json()) as { data: Record<string, unknown> }
      expect(body.data.demoCode).toBeUndefined()
    } finally {
      invalidateDemoMarker(member.orgId)
    }
  })

  // The reviewer cannot read the reserved org's mailbox and the dialog shows the
  // code, so the email is not attempted there: on the demo every request
  // composed it, had it refused and logged an ERROR (walk 2026-10-19, #15).
  test("no email is attempted for the reserved org's deletion code on a demo box", async () => {
    const { member } = await memberSession()
    DemoModeTestAccess.set(true)
    await markOrgAsDemo(member.orgId, reservedMarker())
    // A demo box refuses every outgoing mail; a refused send is the attempt.
    const before = demoProvider().refused.length
    try {
      const res = await requestCode(member.bearer)
      const body = (await res.json()) as { data: { sent: boolean; demoCode?: string } }
      expect(body.data.demoCode).toMatch(/^\d{6}$/)
      expect(demoProvider().refused.length).toBe(before)
    } finally {
      invalidateDemoMarker(member.orgId)
    }
  })

  test("the email is still attempted for a visitor demo org", async () => {
    const { member } = await memberSession()
    DemoModeTestAccess.set(true)
    await markOrgAsDemo(member.orgId, visitorMarker(24))
    const before = demoProvider().refused.length
    try {
      const res = await requestCode(member.bearer)
      expect(res.status).toBe(200)
      expect(demoProvider().refused.length).toBe(before + 1)
    } finally {
      invalidateDemoMarker(member.orgId)
    }
  })

  test("present for the reserved org on a demo box, and it confirms the deletion", async () => {
    const { member } = await memberSession()
    DemoModeTestAccess.set(true)
    await markOrgAsDemo(member.orgId, reservedMarker())
    try {
      const res = await requestCode(member.bearer)
      const body = (await res.json()) as { data: { demoCode?: string } }
      expect(body.data.demoCode).toMatch(/^\d{6}$/)
      const del = await deleteAccount(member.bearer, { stepUpCode: body.data.demoCode })
      expect(del.status).toBe(200)
    } finally {
      invalidateDemoMarker(member.orgId)
    }
  })
})
